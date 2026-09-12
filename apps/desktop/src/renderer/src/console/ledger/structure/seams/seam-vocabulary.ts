// The seam vocabulary — which seams the ledger draws, what each one reads, and how it
// is marked.
//
// Boundary seams for provider switch, compaction, and rollback are part of the
// console's signature set. HOW THEY RENDER IS THIS MODULE'S: the log's epochs are
// geography —
// switches, compactions, and rollbacks draw as labelled seams across the ledger.
//
// A seam is ONE LINE. Never a message row, never a block — that is the whole
// visual claim, and it is why the binding below carries named parts rather than
// prose: the parts are laid out on one line by the ledger frame, and a producer
// that composed a sentence here would have decided the layout.
//
// WIRE TRUTH, AND WHERE THIS DESIGN OUTRUNS IT
//
// Five of the eight seam kinds below name an event type that
// `@ai-sidekicks/contracts` does not register today. The registered census is
// `SESSION_EVENT_CATEGORY_BY_TYPE`, and it does not carry
// `agent.provider_switched`, `agent.provider_switch_failed`, `run.resumed`, or
// `run.unblocked`; `run.blocked` is not a type at all — the design's own
// parenthetical says the block indicator distinguishes `waiting_for_approval`
// from `waiting_for_input`, and those two ARE registered, so that kind binds to
// them.
//
// The response is neither to invent the types nor to drop the kinds. Each binding
// below carries the wire types it reads verbatim, and membership in the registered
// census is ASKED of the contract by `seams.ts`' index rather than hand-copied here,
// so a surface can render the absence (rule 8's `not-checked`: nobody asked, which is
// not the same as "no") instead of drawing a seam vocabulary that half the daemon
// cannot produce.
//
// WHAT THIS MODULE IS NOT. It classifies nothing. `seams.ts` holds the epoch rule —
// which rows are seams, and what one row's seam reads — and takes the table below as
// its closed input, so the set a gallery iterates and the set the classifier switches
// over cannot come apart.

import { type GlyphName } from "../../../tokens/index.js";

/**
 * Every seam the ledger draws. Closed; adding one is a deliberate edit here and a
 * reading of the epoch rule above.
 *
 * The tuple is the declaration and `LedgerSeamKind` is derived from it, so the set
 * a gallery iterates and the set the classifier switches over cannot come apart.
 *
 * Eight, in two groups that render the same way: three epoch
 * seams (switch, compaction, rollback) plus the failed switch, and the four
 * remaining run-state subtype rows. They are one set here because a seam is a
 * one-line row marking a change in the run's condition, and a reader scanning the
 * log does not care which paragraph of the design a mark came from.
 */
export const LEDGER_SEAM_KINDS = [
  "provider-switch",
  "provider-switch-failed",
  "compaction",
  "rollback",
  "run-paused",
  "run-resumed",
  "run-blocked",
  "run-unblocked",
] as const;

export type LedgerSeamKind = (typeof LEDGER_SEAM_KINDS)[number];

/**
 * Whether the wire type a seam reads is in the registered event census.
 *
 * Rendered, never inferred: a surface showing a seam vocabulary owes the operator
 * the difference between "this has not happened" and "the daemon cannot say this
 * yet".
 */
export type SeamWireRegistration = "registered" | "unregistered";

/** What one seam kind reads, and how it is drawn. */
export interface SeamWireBinding {
  readonly kind: LedgerSeamKind;
  /**
   * What the one-line row calls this seam, in the console's own words.
   *
   * The console's, and deliberately not the wire's: the wire type is rendered
   * beside it verbatim and in mono, so this is the reader-facing half of a pair
   * rather than a paraphrase standing in for a value the daemon sent.
   */
  readonly label: string;
  /** The wire event types that produce this seam, verbatim. */
  readonly wireTypes: readonly string[];
  /**
   * The glyph the one-line row carries.
   *
   * Drawn from `tokens/glyphs.ts`'s closed family. Two readings here are
   * deliberate substitutions rather than the obvious pick, because the family
   * carries no rewind and no fold glyph and minting one is the token family's
   * edit, not this lane's: a rollback takes `clock` (history moved) and a
   * compaction takes `chevron-down` (the log folded).
   */
  readonly glyph: GlyphName;
  /**
   * Whether the seam is the pair's one caution.
   *
   * Only the FAILED switch is a caution: `'in_place'` and
   * `'replayed'` render "without a loss clause and without a warning, because
   * nothing was lost". Amber and red are spent on attention and failure alone
   * (rule 3), so this is the single member that earns one.
   */
  readonly isCaution: boolean;
}

/**
 * The binding table. Closed and total over `LedgerSeamKind` by construction — a
 * ninth kind fails to compile here before it can reach a classifier that would
 * silently never match it.
 */
export const SEAM_WIRE_BINDINGS: Readonly<Record<LedgerSeamKind, SeamWireBinding>> = {
  "provider-switch": {
    kind: "provider-switch",
    label: "Provider switched",
    wireTypes: ["agent.provider_switched"],
    glyph: "chevron-right",
    isCaution: false,
  },
  "provider-switch-failed": {
    kind: "provider-switch-failed",
    label: "Provider switch failed",
    wireTypes: ["agent.provider_switch_failed"],
    glyph: "alert",
    isCaution: true,
  },
  compaction: {
    kind: "compaction",
    label: "Context compacted",
    wireTypes: ["usage.context_compacted"],
    glyph: "chevron-down",
    isCaution: false,
  },
  rollback: {
    kind: "rollback",
    label: "Rewound",
    wireTypes: ["run.rolled_back"],
    glyph: "clock",
    isCaution: false,
  },
  "run-paused": {
    kind: "run-paused",
    label: "Run paused",
    wireTypes: ["run.paused"],
    glyph: "pause",
    isCaution: false,
  },
  "run-resumed": {
    kind: "run-resumed",
    label: "Run resumed",
    wireTypes: ["run.resumed"],
    glyph: "play",
    isCaution: false,
  },
  "run-blocked": {
    kind: "run-blocked",
    label: "Run blocked",
    // The design's own parenthetical: the block indicator distinguishes
    // `waiting_for_approval` from `waiting_for_input`, and both are registered.
    // `run.blocked` itself is not a wire type and is not read for.
    wireTypes: ["run.waiting_for_approval", "run.waiting_for_input"],
    glyph: "dot",
    isCaution: false,
  },
  "run-unblocked": {
    kind: "run-unblocked",
    label: "Run unblocked",
    wireTypes: ["run.unblocked"],
    glyph: "check",
    isCaution: false,
  },
};

/** The value `continuity` takes when the new provider works from a summary. */
export const SWITCH_CONTINUITY_MEMO = "memo";
