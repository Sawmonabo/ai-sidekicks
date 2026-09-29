import { useMemo } from "react";

import { useConsoleBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import type { ConsoleCommand } from "@renderer/registries/commands/command-types.js";
import { buildBridgeCommands, type BridgeCommandRefusalSink } from "../contributions/commands.js";

/**
 * The bridge-backed commands for the bridge this window resolved.
 *
 * `useConsoleBridge` throws when the bridge is unavailable, and that is correct
 * here rather than something to guard: the frame renders the unavailable arm above
 * every surface, so any component that reaches this hook is already below a
 * resolved bridge, and a `undefined` return would let a palette render "no commands
 * apply here" over a window whose preload never ran.
 *
 * `onRefusal` belongs in the dependency list, so a caller passing an inline lambda
 * rebuilds the command list every render. Callers hold it in a `useCallback` — the
 * command list is registered once and the registry refuses a duplicate id.
 */
export function useBridgeCommands(onRefusal: BridgeCommandRefusalSink): readonly ConsoleCommand[] {
  const bridge = useConsoleBridge();
  return useMemo(() => buildBridgeCommands(bridge, onRefusal), [bridge, onRefusal]);
}
