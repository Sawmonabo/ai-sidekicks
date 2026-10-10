// Long work on the renderer's thread done a slice at a time, so no task runs long enough to hold a
// frame. Each slice is a task of its own, queued behind the work the thread already has rather
// than waiting for idle time, which a hidden or busy window may grant late or never, and each ends
// by the wall clock.

/**
 * Runs `work` a slice at a time in `view` until it answers it is done, handing it whether the
 * slice still has time. Resolves `true` once it is done, or `false` when `isStopped` answers true
 * before a slice; a slice that throws rejects it.
 */
export async function workInSlices(
  view: Window,
  work: (hasTime: () => boolean) => boolean,
  isStopped: () => boolean,
): Promise<boolean> {
  for (;;) {
    const isDone = await view.scheduler.postTask(
      () => {
        if (isStopped()) {
          return undefined;
        }
        return work(startSlice());
      },
      { priority: "user-visible" },
    );
    if (isDone !== false) {
      return isDone === true;
    }
  }
}

/**
 * Starts a slice now, for work that takes its first slice inside the task it is asked in: answers
 * whether the slice still has time.
 */
export function startSlice(): () => boolean {
  const sliceEnd = performance.now() + SLICE_MS;
  return () => performance.now() < sliceEnd;
}

/** The most one slice works, in milliseconds by the wall clock: well inside a frame. */
const SLICE_MS = 4;
