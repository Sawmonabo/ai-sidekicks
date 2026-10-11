// What can be said about a candidate binding set before it is installed, and which chords
// the host takes before this application sees them.
//
// Every verdict comes from the keybinding table itself: conflicts from
// `KeybindingTable.conflictsIn` (a pre-flight check that avoids a half-replaced table), and dropped
// rows from offering each binding to a throwaway table. A second overlap rule or chord parser here
// would drift from the table. Each operating system's keyboard lists the chords it consumes, so a
// binding on one installs but never fires, and may name a modifier it keeps for itself in every
// chord. A chord reaches the lookup in its one spelling, so only its key is folded: `$mod+escape`
// meets `$mod+Escape`.

import { CommandRegistry } from "../commands/registry.js";
import { type Keybinding } from "../commands/keybinding.js";
import { type KeybindingConflict } from "./conflicts.js";
import { KeybindingTable } from "./table.js";
import type { KeyboardConvention } from "#renderer/lib/chord/convention/contract.js";
import { HOST_KEYBOARD_CONVENTION } from "#renderer/lib/chord/convention/selection.js";
import { foldChordKeyToken, splitChordTokens } from "#renderer/lib/chord/format.js";

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
 * The reason the system of `convention` takes this chord, or `undefined` when it does not. A chord holding a
 * modifier the system keeps for itself is reserved, whether or not the system uses that chord
 * today.
 */
export function reservedChordReason(
  chord: string,
  convention: KeyboardConvention = HOST_KEYBOARD_CONVENTION,
): string | undefined {
  const { reservedChords, reservedModifier } = convention;
  const candidate = foldKeystroke(chord);
  if (reservedModifier !== undefined && candidate.modifiers.includes(reservedModifier.modifier)) {
    return reservedModifier.reason;
  }
  return reservedChords.find((reserved) => {
    const held = foldKeystroke(reserved.chord);
    return held.key === candidate.key && held.modifiers.join(" ") === candidate.modifiers.join(" ");
  })?.reason;
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

// The chord as spelled, its key folded as tinykeys compares a key.
function foldKeystroke(chord: string): {
  readonly modifiers: readonly string[];
  readonly key: string;
} {
  const { modifiers, key } = splitChordTokens(chord);
  return { modifiers, key: foldChordKeyToken(key) };
}
