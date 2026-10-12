// One piece of work run after the frame that asks for it, in a task of its own on the window's
// scheduler, rather than inside the task that asked.

/**
 * Queues `task` behind the work `ownerWindow`'s thread already has, in a task of its own, so work
 * a scroll event or a commit asks for runs after the frame it lands in rather than inside it.
 */
export function queueTaskIn(ownerWindow: Window, task: () => void): void {
  void ownerWindow.scheduler.postTask(task, { priority: "user-visible" });
}
