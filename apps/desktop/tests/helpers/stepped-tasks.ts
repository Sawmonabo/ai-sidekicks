// A window whose `scheduler.postTask` holds each task until the case runs it, for work done in a
// task of its own under a test environment that schedules none, such as happy-dom.

/** A window whose scheduled tasks wait until the case runs them. */
export class SteppedTasks {
  readonly #queue: (() => void)[] = [];
  readonly window = {
    scheduler: {
      postTask: async (task: () => unknown) =>
        await new Promise((resolve, reject) => {
          this.#queue.push(() => {
            try {
              resolve(task());
            } catch (error) {
              reject(error as Error);
            }
          });
        }),
    },
  } as unknown as Window;

  /** Runs the next task, and lets the work waiting on it queue its next; false with none queued. */
  public async runNext(): Promise<boolean> {
    const task = this.#queue.shift();
    if (task === undefined) {
      return false;
    }
    task();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return true;
  }

  /** Runs every task queued now, at once and in order; a task they queue waits. */
  public runQueued(): void {
    for (const task of this.#queue.splice(0, this.#queue.length)) {
      task();
    }
  }
}
