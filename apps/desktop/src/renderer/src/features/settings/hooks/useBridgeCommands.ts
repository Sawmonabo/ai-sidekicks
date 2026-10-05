import { useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import type { CommandDefinition } from "#renderer/registries/commands/types.js";
import { buildBridgeCommands, type BridgeCommandRefusalSink } from "../contributions/commands.js";

/**
 * The bridge-backed commands for the bridge this window resolved.
 *
 * `usePlatformBridge` throws when the bridge is unavailable, deliberately: the frame renders
 * the unavailable arm above every screen, so a caller here is already below a resolved bridge.
 * `onRefusal` is a dependency, so callers hold it in a `useCallback`; an inline lambda rebuilds
 * the list every render and the registry refuses a duplicate id.
 */
export function useBridgeCommands(
  onRefusal: BridgeCommandRefusalSink,
): readonly CommandDefinition[] {
  const bridge = usePlatformBridge();
  return useMemo(() => buildBridgeCommands(bridge, onRefusal), [bridge, onRefusal]);
}
