"use strict";
/** Host bridge; the webview never talks to the filesystem. */
const api = acquireVsCodeApi();
/** Sidebar buttons that post `data-action` to the host. */
const buttons = Array.from(document.querySelectorAll('button[data-action]'));
for (const button of buttons) {
    button.addEventListener('click', () => {
        if (!button.disabled)
            api.postMessage({ type: button.dataset.action });
    });
}
/** Status strings the sidebar webview will render. */
const STATUSES = new Set([
    'idle',
    'waiting',
    'running',
    'completed',
    'incomplete',
    'failed',
    'partial',
    'cancelled',
]);
/** Apply small host state using textContent; never interpret labels as HTML. */
window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message ||
        typeof message !== 'object' ||
        message.type !== 'state') {
        return;
    }
    /** Compact sidebar model posted by the extension host. */
    const state = message.state;
    if (!state || typeof state !== 'object')
        return;
    /** Host state fields used as plain text; never interpreted as HTML. */
    const s = state;
    for (const [field, id] of [
        ['workspaceName', 'workspace-name'],
        ['workspaceLocation', 'workspace-location'],
        ['workspaceDetail', 'workspace-detail'],
        ['statusTitle', 'status-title'],
        ['statusDetail', 'status-detail'],
    ]) {
        const el = document.getElementById(id);
        if (el && typeof s[field] === 'string')
            el.textContent = s[field];
    }
    const list = document.getElementById('status-items');
    if (list) {
        list.replaceChildren();
        const items = Array.isArray(s.statusItems) ? s.statusItems : [];
        list.hidden = items.length === 0;
        for (const item of items) {
            if (typeof item !== 'string' || !item)
                continue;
            const li = document.createElement('li');
            li.textContent = item;
            list.appendChild(li);
        }
    }
    /** True while a transfer holds the lock. */
    const busy = s.busy === true;
    /** Last or current operation status, falling back to idle. */
    const status = typeof s.status === 'string' && STATUSES.has(s.status) ? s.status : 'idle';
    for (const button of buttons) {
        const action = button.dataset.action;
        button.disabled =
            (busy && ['export', 'import', 'chooseWorkspace'].includes(action)) ||
                (action === 'export' && s.sourceAvailable !== true);
        if (action === 'cancel')
            button.hidden = s.canCancel !== true;
        if (action === 'quitCursor') {
            /** True when Quit Cursor may be shown and clicked after a completed import. */
            const eligible = !busy &&
                s.canQuitCursor === true &&
                s.importNeedsRestart === true &&
                ['completed', 'incomplete'].includes(status);
            button.hidden = !eligible;
            button.disabled = !eligible;
        }
    }
    /** Determinate progress track in the operation card. */
    const progress = document.getElementById('progress');
    /** Fill element whose width reflects a known percent. */
    const fill = document.getElementById('progress-fill');
    /** True when the host supplied a finite progress percent. */
    const hasPct = typeof s.progress === 'number' && Number.isFinite(s.progress);
    // Holding the lock while a picker is open is not background progress.
    /** True while work is running, not while a native picker is open. */
    const working = busy && status === 'running';
    progress.hidden = !working;
    progress.classList.toggle('is-indeterminate', working && !hasPct);
    if (hasPct) {
        const pct = Math.max(0, Math.min(100, s.progress));
        fill.style.width = `${pct}%`;
        progress.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    else {
        fill.style.width = '';
        progress.removeAttribute('aria-valuenow');
    }
    document.querySelector('.operation').dataset.status = status;
    document.querySelector('.status-mark').textContent =
        status === 'completed'
            ? '✓'
            : ['failed', 'partial', 'incomplete'].includes(status)
                ? '!'
                : status === 'running'
                    ? '↻'
                    : '○';
});
api.postMessage({ type: 'ready' });
