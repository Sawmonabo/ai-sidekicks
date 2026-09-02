// The keyboard map: which chord runs which command, and what the service says
// about the set as it stands.
//
// `Spec-023 §Console Design (Meridian)` §Keyboard: "One row per command with its
// chord, its command id, and the when-grammar expression that scopes it …
// Conflict detection against the same when-scope, naming the command that already
// holds the chord … Never accepts a chord that collides in the same scope without
// naming the collision. Never silently drops a binding that a platform reserves;
// it renders as unavailable with the reason. Never writes a binding to a wire; the
// map is renderer-local."
//
// EVERY VERDICT HERE IS THE KEYBINDING SERVICE'S OWN
//
// Conflicts come from `KeyBindingTable.conflictsIn`, which that module documents as
// existing for exactly this page — asking by catching the throw from `setBindings`
// would mean the table had already been half-replaced. Whether a binding was
// installed at all comes from the same service, by offering each candidate to a
// throwaway table and reading the diagnostic it reports for a row it dropped.
// Neither question is answered here, and neither may be: a second overlap rule and
// a second chord parser would agree with the service until the day they did not,
// and then this page would report a keyboard nobody has.
//
// PLATFORM-RESERVED CHORDS ARE STATED NARROWLY OR NOT AT ALL
//
// The table below names chords the OPERATING SYSTEM consumes before any
// application sees them. It deliberately does not try to enumerate this
// application's own menu accelerators: those live in the main process, the
// renderer has no read for them, and a guessed list would be wrong in exactly the
// direction that matters — telling somebody a chord is free when the menu bar will
// take it. The page says that in words instead of claiming a completeness it does
// not have.

import { CommandRegistry, KeyBindingTable } from "../../palette/index.js";
import type { ConsoleCommand, KeyBinding } from "../../palette/index.js";
import { scoreSubsequence } from "../../palette/subsequence-score.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../../primitives/index.js";

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

/** One row of the keyboard map. */
export interface KeybindingRow {
  readonly commandId: string;
  readonly title: string;
  readonly group: string;
  /** The chord bound to this command, or `undefined` when it has none. */
  readonly chord: string | undefined;
  /** The when-grammar expression scoping the BINDING, or `undefined` when global. */
  readonly whenExpression: string | undefined;
  /** Present when the host takes this chord before the console can. */
  readonly unavailableReason: string | undefined;
}

/**
 * Compose the rows a person reads.
 *
 * Pure over its inputs, so the ordering, the binding join, and the reserved
 * marking are all testable without a registry, a table, or a DOM. Ordered by group
 * and then title — the order the palette already puts these same commands in, so
 * one console does not have two ideas about how its acts are arranged.
 */
export function composeKeybindingRows(options: {
  readonly commands: readonly ConsoleCommand[];
  readonly bindings: readonly KeyBinding[];
  readonly platform?: ChordPlatform;
}): readonly KeybindingRow[] {
  const platform = options.platform ?? HOST_CHORD_PLATFORM;
  return [...options.commands]
    .sort(
      (left, right) =>
        left.group.localeCompare(right.group) || left.title.localeCompare(right.title),
    )
    .map((command): KeybindingRow => {
      const bound = options.bindings.find((binding) => binding.commandId === command.id);
      return {
        commandId: command.id,
        title: command.title,
        group: command.group,
        chord: bound?.chord,
        // The BINDING's scope and not the command's: a command may be offered
        // everywhere while its chord is live in one place, and the row is about
        // the chord.
        whenExpression: bound?.when,
        unavailableReason:
          bound === undefined ? undefined : reservedChordReason(bound.chord, platform),
      };
    });
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
 * ALONE to a throwaway table: one binding cannot conflict with itself, so that
 * call cannot throw, and whatever the table declines to install it names in its
 * own diagnostics. The probe table is never installed against a target, so nothing
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

/**
 * Narrow the rows to a typed query.
 *
 * The console's one matcher, reached the way settings search reaches it
 * (`settings-page-registry.ts`) — imported, never re-implemented. A row offers its
 * title, its command id, and its group; the best of the three decides. An empty
 * query answers every row in composition order, which is what the page shows
 * before anyone has typed.
 */
export function matchKeybindingRows(
  rows: readonly KeybindingRow[],
  query: string,
): readonly KeybindingRow[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery === "") {
    return rows;
  }
  const scored: { readonly row: KeybindingRow; readonly score: number }[] = [];
  for (const row of rows) {
    let best: number | undefined;
    for (const candidate of [row.title, row.commandId, row.group]) {
      const match = scoreSubsequence(candidate, trimmedQuery);
      if (match !== undefined && (best === undefined || match.score > best)) {
        best = match.score;
      }
    }
    if (best !== undefined) {
      scored.push({ row, score: best });
    }
  }
  // Stable sort over an already-ordered input, so two equally-good rows never
  // swap places between keystrokes.
  return scored.sort((left, right) => right.score - left.score).map((entry) => entry.row);
}
