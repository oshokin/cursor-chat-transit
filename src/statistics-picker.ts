import type * as vscode from 'vscode';
import type { StatisticsUpdate } from './statistics';

/** Show a native picker whose optional scan never disables selection or filtering. */
export function showStatisticsPicker<T extends vscode.QuickPickItem>(options: {
  picker: vscode.QuickPick<T>;
  items: T[];
  key: (item: T) => string | undefined;
  title: string;
  placeholder: string;
  many?: boolean;
  /** Build a filtered workspace list once on opening; metadata scans remain explicit. */
  autoFilter?: boolean;
  /** Keep the current workspace available even if it is empty. */
  keepVisible?: (item: T) => boolean;
  analyzeButton: vscode.QuickInputButton;
  cancelButton: vscode.QuickInputButton;
  /** Optional second action; filter for workspaces, checked selection for chats. */
  actionButton?: vscode.QuickInputButton;
  restoreButton?: vscode.QuickInputButton;
  action?: 'filter' | 'select';
  run: (
    signal: AbortSignal,
    update: (row: StatisticsUpdate) => void,
    deepCheck?: boolean,
  ) => Promise<{ failed: number }>;
  onError: (error: unknown) => void;
  /** Record view actions after they are actually applied. */
  onAction?: (message: string) => void;
}): Promise<T[] | undefined> {
  const { picker, items } = options;

  picker.title = options.title;
  picker.placeholder = options.placeholder;
  picker.canSelectMany = !!options.many;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.keepScrollPosition = true;
  picker.items = options.autoFilter ? [] : items;
  if (options.many) picker.selectedItems = items.filter((item) => item.picked);

  picker.buttons = [
    options.analyzeButton,
    ...(options.actionButton ? [options.actionButton] : []),
  ];

  const total = items.filter((item) => options.key(item) !== undefined).length;

  const protectedKeys = new Set(
    items.filter((item) => options.keepVisible?.(item)).map(options.key),
  );

  const details = new Map<string, string>();
  let closed = false;
  let preparing = options.autoFilter === true;
  let abort: AbortController | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selection: T[] | undefined;
  let hidden = new Set<string>();
  const updates = new Map<string, StatisticsUpdate>();

  const selectionKey = () =>
    JSON.stringify(picker.selectedItems.map(options.key).sort());

  const buttons = () => {
    picker.buttons = [
      options.analyzeButton,
      ...(hidden.size && options.restoreButton
        ? [options.restoreButton]
        : options.actionButton && !options.autoFilter
          ? [options.actionButton]
          : []),
    ];
  };

  /** Restore current user selection and keyboard focus after replacing item objects. */
  const render = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || preparing) return;
    const selected = new Set(picker.selectedItems.map(options.key));
    const active = new Set(picker.activeItems.map(options.key));

    const visible = items.filter((item) => {
      const key = options.key(item);

      return key === undefined || !hidden.has(key);
    });

    const rows = visible
      .filter(
        (item, index) =>
          options.key(item) !== undefined ||
          (index + 1 < visible.length &&
            options.key(visible[index + 1]) !== undefined),
      )
      .map((item) => {
        const key = options.key(item);
        const detail = key === undefined ? undefined : details.get(key);

        return detail
          ? {
              ...item,
              detail: [detail, item.detail].filter(Boolean).join(' · '),
            }
          : item;
      });

    picker.items = rows;

    picker.selectedItems = rows.filter(
      (item) =>
        options.key(item) !== undefined && selected.has(options.key(item)),
    );

    picker.activeItems = rows.filter(
      (item) =>
        options.key(item) !== undefined && active.has(options.key(item)),
    );
  };

  return new Promise((resolve) => {
    const trigger = (button: vscode.QuickInputButton) => {
      if (running) {
        abort?.abort();
        picker.title = `${options.title} — Stopping analysis…`;

        return;
      }

      if (button === options.restoreButton && hidden.size) {
        options.onAction?.(
          `Show all workspaces; restored ${hidden.size} hidden entries`,
        );

        hidden.clear();
        render();
        buttons();
        picker.title = options.title;
        picker.placeholder = options.placeholder;

        return;
      }

      const deepCheck =
        !!options.actionButton && button === options.actionButton;

      const selectedBefore = selectionKey();

      updates.clear();
      abort = new AbortController();
      const signal = abort.signal;
      let completed = 0;

      details.clear();

      for (const item of items) {
        const key = options.key(item);

        if (key !== undefined) details.set(key, 'Not analyzed');
      }

      render();
      picker.busy = true;
      picker.buttons = [options.cancelButton];

      picker.title = preparing
        ? `${options.title} — Preparing workspace list…`
        : `${options.title} — Analyzing 0/${total}`;

      // Schedule after assigning running, including synchronous failures from run().
      running = Promise.resolve()
        .then(() =>
          options.run(
            signal,
            (row) => {
              if (closed || signal.aborted) return;
              details.set(row.key, row.detail);
              updates.set(row.key, row);
              completed++;

              picker.title = preparing
                ? `${options.title} — Preparing workspace list… ${completed}/${total}`
                : `${options.title} — Analyzing ${completed}/${total}`;

              timer ??= setTimeout(render, 100);
            },
            deepCheck,
          ),
        )
        .then((result) => {
          if (closed || signal.aborted) return;
          preparing = false;
          if (!(deepCheck && options.action === 'filter')) render();

          if (deepCheck && options.action === 'filter') {
            hidden = new Set(
              [...updates.values()]
                .filter(
                  (row) =>
                    row.hide === true &&
                    !row.failed &&
                    !protectedKeys.has(row.key),
                )
                .map((row) => row.key),
            );

            render();

            picker.placeholder = hidden.size
              ? `${options.placeholder} · Show all workspaces includes empty destinations`
              : options.placeholder;

            options.onAction?.(
              `Workspace filter applied; hidden ${hidden.size} entries; no storage deleted`,
            );

            picker.title = `${options.title}${hidden.size ? ` — ${hidden.size} empty hidden` : ''}${result.failed ? ' — unreadable entries kept' : ''}`;
          } else if (deepCheck && options.action === 'select') {
            if (selectionKey() !== selectedBefore) {
              picker.title = `${options.title} — Checks finished; your selection was kept`;

              return;
            }

            const ids = new Set(
              [...updates.values()]
                .filter((row) => row.eligible === true && !row.failed)
                .map((row) => row.key),
            );

            picker.selectedItems = picker.items.filter((item) =>
              ids.has(options.key(item) || ''),
            );

            options.onAction?.(
              `Selected ${picker.selectedItems.length} chats with messages that passed transfer checks`,
            );

            picker.title = `${options.title} — ${picker.selectedItems.length} checked chats selected`;
          } else {
            picker.title = `${options.title} — ${result.failed ? 'Some statistics unavailable' : 'Statistics ready'}`;
          }
        })
        .catch((error: unknown) => {
          if (signal.aborted || closed) return;
          picker.title = `${options.title} — Analysis failed; see operation log`;
          options.onError(error);
        })
        .finally(() => {
          preparing = false;

          if (!closed) {
            if (signal.aborted)
              picker.title = `${options.title} — Analysis stopped`;
            render();
            picker.busy = false;
            buttons();
          }

          running = undefined;
        });
    };

    const subscriptions = [
      picker.onDidTriggerButton(trigger),
      picker.onDidAccept(() => {
        selection = [...picker.selectedItems];
        // Single-select picks cannot accept a separator or an empty filter result.
        if (
          !options.many &&
          !selection.some((item) => options.key(item) !== undefined)
        )
          return;
        picker.hide();
      }),
      picker.onDidHide(() => {
        if (closed) return;
        closed = true;
        abort?.abort();
        clearTimeout(timer);
        for (const subscription of subscriptions) subscription.dispose();
        picker.dispose();
        // The next transfer starts after the worker releases its read connection.
        void Promise.resolve(running).then(() => resolve(selection));
      }),
    ];

    if (options.autoFilter && options.actionButton)
      trigger(options.actionButton);
    picker.show();
  });
}
