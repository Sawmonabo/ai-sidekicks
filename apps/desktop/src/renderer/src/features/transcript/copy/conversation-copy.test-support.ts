// A window a copy's build can run its slices in under a test, where the page schedules no tasks.

import { vi } from "vitest";

/** A window running its tasks at once, its clock past each slice's end: a slice holds one part. */
export function windowCuttingEveryPart(): Window {
  let nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (nowMs += 10));
  return { scheduler: { postTask: async (task: () => unknown) => task() } } as unknown as Window;
}
