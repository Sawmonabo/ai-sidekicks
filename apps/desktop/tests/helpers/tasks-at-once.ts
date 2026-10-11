// A window whose scheduled tasks run at once, for work done in slices under a test environment
// that schedules none, such as happy-dom.

/** A window whose `scheduler.postTask` runs each task at once. */
export const TASKS_AT_ONCE: Window = {
  scheduler: { postTask: async (task: () => unknown) => task() },
} as unknown as Window;
