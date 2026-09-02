// The acts that ARE the bridge.
//
// `useConsoleBridge` is the console's single door to the bridge — "console code
// reaches the bridge only through the bridge provider" — and until this module no
// surface walked through it. The frame takes the RESOLUTION rather than the bridge,
// because it is the one place that has to render the "preload did not run" failure;
// every other family reaches the daemon through the store's apply chokepoint. What
// was left over is the small set of acts that have no surface of their own, and a
// command palette is exactly where an act with no home lives. So they are the
// palette's rather than the frame's, and they take the bridge itself.
//
// EVERY ACT SETTLES. `CommandRegistry.invoke` hands the caller the command's own
// promise and the overlay drops it, deliberately — the dialog must not stay open
// waiting on a command that opens another surface. A `run` that REJECTED would
// therefore surface as an unhandled rejection and the person who pressed Enter
// would see nothing at all. Each act below catches its own failure and hands it to
// the caller's sink as a `ConsoleRefusal`, the one refusal value the three refusal
// renderings consume, so a refused act is rendered rather than lost.
//
// The refusal detail is a CONSTANT sentence and never the caught error's message.
// The bridge's failures come from the main process across an IPC boundary; their
// text is not console copy, may be a stack, and — under the live bridge — describes
// a subsystem the person cannot act on. The code names which act failed, which is
// what a person pastes into an issue.

import { useMemo } from "react";
import { useConsoleBridge, type ConsoleBridge } from "../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { ConsoleCommand } from "./contributions.js";

/** Why a bridge-backed command could not complete. */
export const BRIDGE_COMMAND_REFUSAL_CODES = [
  "clipboard-unavailable",
  "update-check-unavailable",
] as const;

/** One bridge-command refusal code. Derived, so the vocabulary is declared once. */
export type BridgeCommandRefusalCode = (typeof BRIDGE_COMMAND_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const BRIDGE_COMMAND_REFUSAL_ORIGIN = "palette-bridge-command";

/** Where a refused act is rendered. Supplied by the surface that owns the copy. */
export type BridgeCommandRefusalSink = (refusal: ConsoleRefusal) => void;

/**
 * The bridge-backed commands, for a bridge the caller already holds.
 *
 * Separate from the hook below so the commands can be built and driven without a
 * React tree — the hook is the wiring, this is the behaviour, and a test that had
 * to render to reach the behaviour would be proving both at once.
 */
export function buildBridgeCommands(
  bridge: ConsoleBridge,
  onRefusal: BridgeCommandRefusalSink,
): readonly ConsoleCommand[] {
  return [
    {
      id: "bridge.copyBuildDetails",
      title: "Copy build details",
      group: "Help",
      keywords: ["version", "platform", "architecture", "locale", "diagnostics", "bug report"],
      run: async () => {
        // Read from the bridge rather than from `navigator`: `app` meta is what the
        // MAIN process reports, and under the fixture it is pinned, so a screenshot
        // of this command's result does not move with the developer's machine.
        const { version, platform, arch, locale } = bridge.sidekicks.app;
        await settle(onRefusal, "clipboard-unavailable", CLIPBOARD_REFUSAL_DETAIL, () =>
          bridge.sidekicks.native.copyToClipboard(
            `AI Sidekicks ${version} — ${platform}/${arch} — ${locale}`,
          ),
        );
      },
    },
    {
      id: "bridge.checkForUpdates",
      title: "Check for updates",
      group: "Help",
      keywords: ["update", "upgrade", "release", "version"],
      run: async () => {
        // Requests the check and returns. The updater's own state arrives through
        // `update.subscribe`, which belongs to whichever surface renders it — a
        // command that awaited an outcome here would be a second reader of a state
        // machine the shell already observes.
        await settle(onRefusal, "update-check-unavailable", UPDATE_REFUSAL_DETAIL, () =>
          bridge.sidekicks.update.requestCheck(),
        );
      },
    },
  ];
}

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

const CLIPBOARD_REFUSAL_DETAIL =
  "The build details could not be copied. The clipboard belongs to the main process, and this window could not reach it.";

const UPDATE_REFUSAL_DETAIL =
  "The update check could not start. The updater runs in the main process, and this window could not reach it.";

async function settle(
  onRefusal: BridgeCommandRefusalSink,
  code: BridgeCommandRefusalCode,
  detail: string,
  act: () => Promise<void>,
): Promise<void> {
  try {
    await act();
  } catch {
    onRefusal(refuse(BRIDGE_COMMAND_REFUSAL_ORIGIN, code, detail));
  }
}
