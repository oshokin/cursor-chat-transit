/** This tiny process has no database handles and stays responsive during native SQL. */
const ORPHAN_PARENT_POLL_INTERVAL_MS = 250;

const owner = Number(process.argv[2]);
const worker = Number(process.argv[3]);

if (
  !Number.isSafeInteger(owner) ||
  owner <= 0 ||
  !Number.isSafeInteger(worker) ||
  worker <= 0
)
  process.exit(1);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const timer = setInterval(() => {
  if (!alive(owner)) {
    try {
      process.kill(worker, 'SIGKILL');
    } catch {
      /* Already stopped. */
    }

    clearInterval(timer);
    process.exit(0);
  }
}, ORPHAN_PARENT_POLL_INTERVAL_MS);

process.once('disconnect', () => {
  clearInterval(timer);
  process.exit(0);
});
