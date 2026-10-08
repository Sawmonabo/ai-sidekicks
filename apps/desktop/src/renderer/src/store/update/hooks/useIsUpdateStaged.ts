import { isUpdateStaged, type UpdaterCalls } from "../reading.js";
import { useUpdateReading } from "./useUpdateReading.js";

/**
 * Whether an update is staged and waiting for the restart, from the window's one reading of the
 * updater; called once per window, as `useUpdateReading` is.
 */
export function useIsUpdateStaged(updater: UpdaterCalls): boolean {
  return isUpdateStaged(useUpdateReading(updater));
}
