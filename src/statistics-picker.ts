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
  analyzeButton: vscode.QuickInputButton;
  cancelButton: vscode.QuickInputButton;
  run: (
    signal: AbortSignal,
    update: (row: StatisticsUpdate) => void,
  ) => Promise<{ failed: number }>;
  onError: (error: unknown) => void;
}): Promise<T[] | undefined> {
  const { picker, items } = options;

  picker.title = options.title;
  picker.placeholder = options.placeholder;
  picker.canSelectMany = !!options.many;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.keepScrollPosition = true;
  picker.items = items;
  if (options.many) picker.selectedItems = items.filter((item) => item.picked);
  picker.buttons = [options.analyzeButton];
  const total = items.filter((item) => options.key(item) !== undefined).length;
  const details = new Map<string, string>();
  let closed = false;
  let abort: AbortController | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selection: T[] | undefined;

  /** Restore current user selection and keyboard focus after replacing item objects. */
  const render = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    const selected = new Set(picker.selectedItems.map(options.key));
    const active = new Set(picker.activeItems.map(options.key));

    const rows = items.map((item) => {
      const key = options.key(item);
      const detail = key === undefined ? undefined : details.get(key);

      return detail
        ? { ...item, detail: [detail, item.detail].filter(Boolean).join(' · ') }
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
    const subscriptions = [
      picker.onDidTriggerButton(() => {
        if (running) {
          abort?.abort();
          picker.title = `${options.title} — Stopping analysis…`;

          return;
        }

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
        picker.title = `${options.title} — Analyzing 0/${total}`;

        // Schedule after assigning running, including synchronous failures from run().
        running = Promise.resolve()
          .then(() =>
            options.run(signal, (row) => {
              if (closed || signal.aborted) return;
              details.set(row.key, row.detail);
              completed++;
              picker.title = `${options.title} — Analyzing ${completed}/${total}`;
              timer ??= setTimeout(render, 100);
            }),
          )
          .then((result) => {
            if (!closed && !signal.aborted)
              picker.title = `${options.title} — ${result.failed ? 'Some statistics unavailable' : 'Statistics ready'}`;
          })
          .catch((error: unknown) => {
            if (signal.aborted || closed) return;
            picker.title = `${options.title} — Analysis failed; see operation log`;
            options.onError(error);
          })
          .finally(() => {
            if (!closed) {
              if (signal.aborted)
                picker.title = `${options.title} — Analysis stopped`;
              render();
              picker.busy = false;
              picker.buttons = [options.analyzeButton];
            }

            running = undefined;
          });
      }),
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

    picker.show();
  });
}
