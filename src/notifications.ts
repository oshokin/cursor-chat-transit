/** Present a notice without making operation lifetime depend on dismissal. */
export function notifyCompletion(
  /** Starts the native notification; synchronous throws are caught too. */
  show: () => PromiseLike<string | undefined>,
  /** Optional action chosen after the operation has released its resources. */
  onChoice: (choice: string | undefined) => void | PromiseLike<void> = () => {},
  /** Report host/UI failures without turning a completed transfer into failure. */
  onError: (error: unknown) => void = () => {},
): void {
  try {
    void Promise.resolve(show()).then(onChoice).catch(onError);
  } catch (error) {
    onError(error);
  }
}
