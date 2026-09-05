// What can be said about a candidate binding set before anything is installed, and
// which chords the host takes before this application is asked.
//
// EVERY VERDICT HERE IS THE KEYBINDING SERVICE'S OWN
//
// Conflicts come from `KeyBindingTable.conflictsIn`, which that module documents as
// a pre-flight check for exactly this: asking by catching the throw from
// `setBindings` would mean the table had already been half-replaced. Whether a
// binding is well formed at all comes from the same service, by offering each
// candidate to a throwaway table and reading the diagnostic it reports for a row it
// dropped. Neither question is answered here, and neither may be: a second overlap
// rule and a second chord parser would agree with the service until the day they did
// not, and then two surfaces would report a keyboard nobody has.
//
// WHY THIS LIVES IN `frame/` AND NOT BESIDE THE KEYBOARD PAGE
//
// It was in `settings/pages/keyboard/keybinding-map.ts`, which is where its only reader was.
// The override store next door is now a second reader, and it sits BELOW settings in
// the console's family DAG — so leaving the table there would have meant either an
// upward import or a second copy of the reserved-chord list and the probe loop. The
// console hoists on the second use, and this is the lowest family both readers
// already import.
//
// PLATFORM-RESERVED CHORDS ARE STATED NARROWLY OR NOT AT ALL
//
// The table below names chords the OPERATING SYSTEM consumes before any application
// sees them. It deliberately does not try to enumerate this application's own menu
// accelerators: those live in the main process, the renderer has no read for them,
// and a guessed list would be wrong in exactly the direction that matters — telling
// somebody a chord is free when the menu bar will take it.

import { CommandRegistry, KeyBindingTable } from "../palette/index.js";
import type { KeyBinding } from "../palette/index.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../primitives/index.js";

/** One chord the host consumes before this application can see it. */
interface ReservedChord {
  readonly chord: string;
  readonly reason: string;
}

/**
 * Chords the operating system takes, per platform, and deliberately short.
 *
 * Only entries that hold on a default installation of the platform itself are
 * listed. A chord this application's own menu bar owns is ALSO unavailable and is
 * not here, because the menu belongs to the main process and this renderer has no
 * read that would enumerate it.
 */
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
  ],
  linux: [
    {
      chord: "Alt+Tab",
      reason:
        "The desktop environment usually switches windows on this chord before any application sees it.",
    },
  ],
};

/** The reason this chord is unavailable on this host, or `undefined`. */
export function reservedChordReason(
  chord: string,
  platform: ChordPlatform = HOST_CHORD_PLATFORM,
): string | undefined {
  return RESERVED_CHORDS_BY_PLATFORM[platform].find(
    (reserved) => reserved.chord.toLowerCase() === chord.toLowerCase(),
  )?.reason;
}

/** A binding the keybinding service refused to install, with its own reason. */
export interface DroppedBinding {
  readonly commandId: string;
  readonly chord: string;
  readonly reason: string;
}

/** Two commands that can be live on one chord, as the service reports the pair. */
export type KeybindingConflict = ReturnType<typeof KeyBindingTable.conflictsIn>[number];

/** Everything the service can say about a binding set without installing it. */
export interface KeybindingAudit {
  readonly conflicts: readonly KeybindingConflict[];
  readonly dropped: readonly DroppedBinding[];
}

/**
 * Ask the keybinding service what is wrong with this set, if anything.
 *
 * Two questions, both answered by the real service. Conflicts come from its
 * pre-flight check over the whole set. Drops are found by offering each binding
 * ALONE to a throwaway table: one binding cannot conflict with itself, so that call
 * cannot throw, and whatever the table declines to install it names in its own
 * diagnostics. The probe table is never installed against a target, so nothing
 * listens and no keystroke reaches it.
 */
export function auditKeybindings(bindings: readonly KeyBinding[]): KeybindingAudit {
  const probeTable = new KeyBindingTable({
    // A fresh empty registry rather than the window's: a validation must not be
    // able to reach the commands whose bindings it is checking.
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
  return { conflicts: KeyBindingTable.conflictsIn(bindings), dropped };
}
