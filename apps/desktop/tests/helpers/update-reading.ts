// The updater reading a window hands its screens before the updater has answered, for a suite
// whose screen does not read it.

import type { UpdateReadingBinding } from "#renderer/store/update/hooks/useUpdateReading.js";

/** A window's updater reading that has not landed, whose read-again does nothing. */
export const UPDATE_NOT_READ: UpdateReadingBinding = {
  reading: { kind: "not-read" },
  readAgain: () => undefined,
};
