// The Settings palette commands: acts on this install with no screen of their own (copy build
// details, check for updates) and the `Color scheme` row.
//
// Every bridge act settles: the palette drops the promise a command returns, so each act
// catches its own failure and hands the caller's sink a `Refusal`. The refusal detail is a
// constant sentence, never the caught error's message, which crosses IPC from the main
// process and may be a stack naming a subsystem the person cannot act on.

import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { nextSchemePreference, type SchemePreference } from "@renderer/styles/tokens.js";

/** Why a bridge-backed command could not complete. */
export type BridgeCommandRefusalCode = "clipboard-unavailable" | "update-check-unavailable";

/** The subsystem name every refusal this module raises carries. */
const BRIDGE_COMMAND_REFUSAL_ORIGIN = "palette-bridge-command";

/** Where a refused act is rendered. Supplied by the view that owns the copy. */
export type BridgeCommandRefusalSink = (refusal: Refusal) => void;

/**
 * The bridge-backed commands, for a bridge the caller already holds.
 *
 * Separate from `useBridgeCommands` so the commands can be built without a React tree.
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
        // Read from the bridge, not `navigator`: the main process reports `app`, and the
        // fixture pins it so a rendered view does not move with the machine.
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
        // Requests the check and returns: the updater's state arrives through
        // `update.subscribe` to whichever view renders it, and awaiting an outcome here would be
        // a second reader of it.
        await settle(onRefusal, "update-check-unavailable", UPDATE_REFUSAL_DETAIL, () =>
          bridge.update.requestCheck(),
        );
      },
    },
  ];
}

/**
 * The `Color scheme` row, which moves this window to the next scheme in the cycle. Built per
 * window because it reads and chooses through the window's own scheme.
 */
export function buildColorSchemeCommand(
  readScheme: () => SchemePreference,
  chooseScheme: (preference: SchemePreference) => void,
): CommandDefinition {
  return {
    id: "settings.cycleColorScheme",
    title: "Color scheme",
    group: "App",
    keywords: ["dark", "light", "system"],
    run: () => {
      chooseScheme(nextSchemePreference(readScheme()));
    },
  };
}

const CLIPBOARD_REFUSAL_DETAIL =
  "The build details could not be copied. The clipboard belongs to " +
  "the main process, and this window could not reach it.";

const UPDATE_REFUSAL_DETAIL =
  "The update check could not start. The updater runs in the main " +
  "process, and this window could not reach it.";

/**
 * Perform one act, and route either kind of failure to the sink.
 *
 * `act` is called inside the `try`, and that placement is the contract: a preload member main
 * has not wired throws synchronously while the fixture refuses with a rejected promise. A
 * boundary on the returned promise would let the throw escape into the palette's
 * fire-and-forget dispatch, which drops it.
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
