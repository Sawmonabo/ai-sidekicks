// What can be said about a candidate binding set before it is installed, and which chords
// the host takes before this application sees them.
//
// Every verdict comes from the keybinding table itself: conflicts from
// `KeybindingTable.conflictsIn` (a pre-flight check that avoids a half-replaced table), and
// dropped rows from offering each binding to a throwaway table. A second overlap rule or chord
// parser here would drift from the table. The reserved-chord table below lists chords the
// operating system consumes, so a binding on one installs but never fires; on Windows every chord
// holding the Windows key is reserved as a class, since Windows keeps that key for itself.

import { CommandRegistry } from "../commands/registry.js";
import { type Keybinding } from "../commands/keybinding.js";
import { type KeybindingConflict } from "./conflicts.js";
import { KeybindingTable } from "./table.js";
import {
  HOST_CHORD_PLATFORM,
  splitChordTokens,
  type ChordPlatform,
} from "#renderer/lib/chord-format.js";

/** One chord the host consumes before this application can see it. */
interface ReservedChord {
  readonly chord: string;
  readonly reason: string;
}

/** Chords the operating system takes, per platform; only entries that hold on a default install. */
const RESERVED_CHORDS_BY_PLATFORM: Readonly<Record<ChordPlatform, readonly ReservedChord[]>> = {
  darwin: [
    {
      chord: "$mod+Space",
      reason: "macOS opens Spotlight on this chord before any application sees it.",
    },
    {
      chord: "$mod+Tab",
      reason: "macOS switches applications on this chord before any application sees it.",
    },
  ],
  win32: [
    {
      chord: "Alt+Tab",
      reason: "Windows switches windows on this chord before any application sees it.",
    },
    {
      chord: "Alt+Escape",
      reason: "Windows switches windows on this chord before any application sees it.",
    },
    {
      chord: "$mod+Escape",
      reason: "Windows opens the Start menu on this chord before any application sees it.",
    },
    {
      chord: "$mod+Shift+Escape",
      reason: "Windows opens Task Manager on this chord before any application sees it.",
    },
  ],
  linux: [
    {
      chord: "Alt+Tab",
      reason:
        "The desktop environment usually switches windows " +
        "on this chord before any application sees it.",
    },
    // GNOME's own Escape chords, spelled in the order the recorder writes a press's modifiers.
    {
      chord: "Alt+Escape",
      reason: "GNOME switches windows on this chord before any application sees it.",
    },
    {
      chord: "Alt+Shift+Escape",
      reason: "GNOME switches windows on this chord before any application sees it.",
    },
    {
      chord: "$mod+Alt+Escape",
      reason: "GNOME switches system controls on this chord before any application sees it.",
    },
    {
      chord: "$mod+Alt+Shift+Escape",
      reason: "GNOME switches system controls on this chord before any application sees it.",
    },
    {
      chord: "Meta+Escape",
      reason: "GNOME restores its own shortcuts on this chord before any application sees it.",
    },
  ],
};

/** Why a chord holding the Windows key is refused on Windows. */
const WINDOWS_KEY_REASON = "Windows keeps every chord with the Windows key for its own shortcuts.";

/** A binding the keybinding table refused to install, with its own reason. */
export interface DroppedBinding {
  readonly commandId: string;
  readonly chord: string;
  readonly reason: string;
}

/** Everything the keybinding table can say about a binding set without installing it. */
export interface KeybindingAudit {
  readonly conflicts: readonly KeybindingConflict[];
  readonly dropped: readonly DroppedBinding[];
}

/**
 * The reason the host takes this chord, or `undefined` when it does not. On Windows any chord
 * holding the Windows key is reserved, whether or not Windows uses that chord today.
 */
export function reservedChordReason(
  chord: string,
  platform: ChordPlatform = HOST_CHORD_PLATFORM,
): string | undefined {
  if (
    platform === "win32" &&
    splitChordTokens(chord).modifiers.some((modifier) => modifier.toLowerCase() === "meta")
  ) {
    return WINDOWS_KEY_REASON;
  }
  return RESERVED_CHORDS_BY_PLATFORM[platform].find(
    (reserved) => reserved.chord.toLowerCase() === chord.toLowerCase(),
  )?.reason;
}

/**
 * Asks the keybinding table what is wrong with this set. Drops are found by offering each binding
 * alone to a throwaway table, which cannot conflict with itself and so cannot throw; the probe
 * table is never installed, so no keystroke reaches it.
 */
export function auditKeybindings(bindings: readonly Keybinding[]): KeybindingAudit {
  const probeTable = new KeybindingTable({
    // An empty registry, so validation cannot reach the window's commands.
    registry: new CommandRegistry(),
    readContext: () => ({}),
  });
  const dropped: DroppedBinding[] = [];
  for (const binding of bindings) {
    probeTable.setBindings([binding]);
    const diagnostic = probeTable.diagnostics()[0];
    if (diagnostic !== undefined) {
      dropped.push({
        commandId: binding.commandId,
        chord: binding.chord,
        reason: diagnostic.detail,
      });
    }
  }
  return { conflicts: KeybindingTable.conflictsIn(bindings), dropped };
}
