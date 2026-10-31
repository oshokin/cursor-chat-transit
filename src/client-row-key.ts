/** Cursor Agent client-row suffixes reconstructed from conversation state. */
const STEP = /^s:(0|[1-9][0-9]*)$/;
const TOOL = /^t(?:[2-9]|[1-9][0-9]+)?:[^/]+$/;

/** Reject malformed spellings of Cursor's known Agent client-row slots. */
export function assertCanonicalClientRowId(id: string): void {
  const slash = id.indexOf('/');

  if (slash < 0) return;
  const root = id.slice(0, slash);
  const slot = id.slice(slash + 1);

  if (!root || (!STEP.test(slot) && !TOOL.test(slot) && slot !== 'u')) {
    throw new Error(`Invalid Cursor client-row ID: ${id}`);
  }
}
