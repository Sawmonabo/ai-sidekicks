import { LOADING_NOTICE_DELAY_MS } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { useIsPastDelay } from "#renderer/hooks/useIsPastDelay.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { MachineSettingsSnapshot } from "../snapshot.js";

/**
 * Whether a page's rows kept in the machine's settings file show `Loading…`: one delay per page,
 * armed on `clock` while the file is neither read nor refused, which every such row reads.
 */
export function useSettingsFileLoadingDelay(
  snapshot: MachineSettingsSnapshot,
  clock: Clock,
): boolean {
  const isWaiting = snapshot.reading === undefined && snapshot.readRefusal === undefined;
  return useIsPastDelay(isWaiting ? clock : undefined, LOADING_NOTICE_DELAY_MS);
}
