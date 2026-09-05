// What a mark on the provenance rail CAN be — the closed vocabulary and its table.
//
// Its own module because it is data rather than derivation: `rail-model.ts` decides
// what THIS window's rail is, and this decides what any rail's marks may be at all.
// The legend, the keyboard's "next tick of a kind" walk, the painter, and the census
// below all read the one table, so a kind added here reaches every one of them.
//
// TWO COLOURS, SPENT ONCE. `Spec-023 §Meridian, the design language` rule 3: "Amber
// means a person is needed. Red means something failed. Nothing else is colored for
// attention." On the rail that reads as: only pending-human ticks are amber and only
// failures are red, every other tick taking the actor's hue at low chroma (rule 2's
// participant hue system). The tone is a property of the KIND, fixed in the table
// below, so no call site can spend amber on a tick that needs nobody.

import { type GlyphName } from "../../tokens/index.js";
import { LedgerSeamIndex, SEAM_WIRE_BINDINGS, type LedgerSeamKind } from "./seams.js";

/**
 * Every kind of mark the rail draws. Closed, and this module's own enumeration.
 *
 * The tuple is the declaration and the union follows from it, so the legend, the
 * keyboard's "next tick of a kind" walk, and the painter all read one list.
 */
export const RAIL_TICK_KINDS = [
  "participant-message",
  "approval",
  "tool-error",
  "handoff",
  "park",
  "resume",
  "rollback-epoch",
  "compaction",
  "provider-switch",
  "artifact-publication",
] as const;

export type RailTickKind = (typeof RAIL_TICK_KINDS)[number];

/**
 * What colour a tick takes. Three values, and two of them are rationed.
 *
 * `actor` is not a colour — it is an instruction to take the actor's hue at low
 * chroma, which the painter resolves from the session's hue allocation. Naming it
 * here rather than resolving a colour string keeps rule 2's "the hue is never the
 * sole attribution channel" answerable by the surface that knows the wheel.
 */
export const RAIL_TICK_TONES = ["actor", "attention", "failure"] as const;

export type RailTickTone = (typeof RAIL_TICK_TONES)[number];

/** What one tick kind reads and how it is drawn. */
export interface RailTickBinding {
  readonly kind: RailTickKind;
  /** Wire event types that produce this tick directly, verbatim. */
  readonly wireTypes: readonly string[];
  /** Seam kinds that produce this tick. Read through `seams.ts`, never re-classified. */
  readonly seamKinds: readonly LedgerSeamKind[];
  readonly tone: RailTickTone;
  readonly glyph: GlyphName;
}

/**
 * The tick table. Total over `RailTickKind` by construction.
 *
 * The six seam-derived kinds name SEAM KINDS rather than repeating the seam
 * module's wire types: the seam vocabulary is one table, and a second copy of it
 * here would be the drift `apps/desktop/AGENTS.md` names — "two copies of one
 * regular expression or normalization: they drift, and the gate goes green".
 */
export const RAIL_TICK_BINDINGS: Readonly<Record<RailTickKind, RailTickBinding>> = {
  "participant-message": {
    kind: "participant-message",
    wireTypes: ["user.message"],
    seamKinds: [],
    tone: "actor",
    glyph: "member",
  },
  approval: {
    kind: "approval",
    // The one pending-human mark, and therefore the one amber one. The settled
    // arms (`approval.approved` / `.rejected`) are not ticks: the rail marks where
    // a person was NEEDED, and a decided approval needs nobody.
    wireTypes: ["approval.requested"],
    seamKinds: [],
    tone: "attention",
    glyph: "approval",
  },
  "tool-error": {
    kind: "tool-error",
    wireTypes: ["tool.error"],
    seamKinds: [],
    tone: "failure",
    glyph: "alert",
  },
  handoff: {
    kind: "handoff",
    // Work changing hands: an agent joining or leaving the session, and a child
    // run taking a piece of it. All four are in the registered event census.
    wireTypes: ["agent.attached", "agent.detached", "subagent.started", "subagent.completed"],
    seamKinds: [],
    tone: "actor",
    glyph: "agent",
  },
  park: { kind: "park", wireTypes: [], seamKinds: ["run-paused"], tone: "actor", glyph: "pause" },
  resume: {
    kind: "resume",
    wireTypes: [],
    seamKinds: ["run-resumed"],
    tone: "actor",
    glyph: "play",
  },
  "rollback-epoch": {
    kind: "rollback-epoch",
    wireTypes: [],
    seamKinds: ["rollback"],
    tone: "actor",
    // The rewind mark, which `tokens/glyphs.ts` draws for exactly this: an open
    // ring whose gap is the part of the conversation being given up. A clock
    // would say "this took time", which is the one thing a rollback is not about.
    glyph: "rewind",
  },
  compaction: {
    kind: "compaction",
    wireTypes: [],
    seamKinds: ["compaction"],
    tone: "actor",
    // The fold mark: two chevrons closing onto a rule. A bare `chevron-down`
    // points AWAY from the boundary and is the disclosure chevron everywhere else
    // in the console, so on the rail it would read as "expand me".
    glyph: "fold",
  },
  "provider-switch": {
    kind: "provider-switch",
    wireTypes: [],
    seamKinds: ["provider-switch", "provider-switch-failed"],
    tone: "actor",
    glyph: "chevron-right",
  },
  "artifact-publication": {
    kind: "artifact-publication",
    wireTypes: ["artifact.published"],
    seamKinds: [],
    tone: "actor",
    glyph: "artifact",
  },
};

/**
 * Which tick kinds the rail can never draw today, because no wire type behind them
 * is registered.
 *
 * The rail's own half of the seam module's honesty: a legend that listed ten kinds
 * while the daemon can emit eight would be a legend that lies about the session.
 */
export function railTickKindsWithoutRegisteredWire(
  seamIndex: LedgerSeamIndex,
): readonly RailTickKind[] {
  return RAIL_TICK_KINDS.filter((kind) => {
    const binding = RAIL_TICK_BINDINGS[kind];
    const directTypes = binding.wireTypes;
    const seamTypes = binding.seamKinds.flatMap(
      (seamKind) => SEAM_WIRE_BINDINGS[seamKind].wireTypes,
    );
    const everyType = [...directTypes, ...seamTypes];
    return (
      everyType.length > 0 &&
      everyType.every((wireType) => !seamIndex.isRegisteredWireType(wireType))
    );
  });
}
