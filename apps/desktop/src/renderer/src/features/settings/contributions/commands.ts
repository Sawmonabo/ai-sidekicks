// The Settings feature's palette commands: the acts on this install that have no screen of
// their own (copy build details, check for updates) and the `Color scheme` row.
//
// Every bridge act settles. The palette drops the promise a command returns, so a `run`
// that rejected would show the person nothing; each act catches its own failure and hands
// it to the caller's sink as a `Refusal`. The refusal detail is a constant sentence,
// never the caught error's message: that text comes from the main process across IPC, may
// be a stack, and names a subsystem the person cannot act on.

import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { nextSchemePreference, type SchemePreference } from "@renderer/styles/tokens.js";

/** Why a bridge-backed command could not complete. */
export const BRIDGE_COMMAND_REFUSAL_CODES = [
  "clipboard-unavailable",
  "update-check-unavailable",
] as const;

/** One bridge-command refusal code. Derived, so the vocabulary is declared once. */
export type BridgeCommandRefusalCode = (typeof BRIDGE_COMMAND_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const BRIDGE_COMMAND_REFUSAL_ORIGIN = "palette-bridge-command";

/** Where a refused act is rendered. Supplied by the view that owns the copy. */
export type BridgeCommandRefusalSink = (refusal: Refusal) => void;

/**
 * The bridge-backed commands, for a bridge the caller already holds.
 *
 * Separate from `useBridgeCommands` so the commands can be built and driven without a
 * React tree: the hook is the wiring, this is the behavior.
 */
export function buildBridgeCommands(
  bridge: PlatformBridge,
  onRefusal: BridgeCommandRefusalSink,
): readonly CommandDefinition[] {
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
        const { version, platform, arch, locale } = bridge.app;
        await settle(onRefusal, "clipboard-unavailable", CLIPBOARD_REFUSAL_DETAIL, () =>
          bridge.native.copyToClipboard(
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
        // `update.subscribe`, which belongs to whichever view renders it — a
        // command that awaited an outcome here would be a second reader of a state
        // machine the main process already observes.
        await settle(onRefusal, "update-check-unavailable", UPDATE_REFUSAL_DETAIL, () =>
          bridge.update.requestCheck(),
        );
      },
    },
  ];
}

/**
 * The `Color scheme` row, which moves this window to the next scheme in the cycle.
 *
 * Built per window rather than registered at module scope, because it reads and chooses
 * through the window's own scheme.
 */
export function buildColorSchemeCommand(
  readScheme: () => SchemePreference,
  chooseScheme: (preference: SchemePreference) => void,
): CommandDefinition {
  return {
    id: "settings.cycleColorScheme",
    title: "Color scheme",
    group: "Console",
    keywords: ["dark", "light", "system"],
    run: () => {
      chooseScheme(nextSchemePreference(readScheme()));
    },
  };
}

const CLIPBOARD_REFUSAL_DETAIL =
  "The build details could not be copied. The clipboard belongs to the main process, and this window could not reach it.";

const UPDATE_REFUSAL_DETAIL =
  "The update check could not start. The updater runs in the main process, and this window could not reach it.";

/**
 * Perform one act, and route either kind of failure to the sink.
 *
 * `act` is CALLED INSIDE the `try` rather than awaited from outside it, and that
 * placement is the contract: the shipped stub bridge implements every method as a
 * synchronous `throw`, while the fixture bridge refuses by returning a rejected
 * promise. A boundary attached to the returned promise would catch the fixture and
 * let the release build's throw escape into the palette's fire-and-forget dispatch,
 * which drops it — so the person who pressed Enter would see nothing on the one
 * build they actually run.
 */
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
