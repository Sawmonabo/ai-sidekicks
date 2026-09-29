// The seam vocabulary — which seams the ledger draws, what each one reads, and how it
// is marked.
//
// Boundary seams for provider switch, compaction, and rollback are part of the
// console's signature set. HOW THEY RENDER IS THIS MODULE'S: the log's epochs are
// geography —
// switches, compactions, and rollbacks draw as labeled seams across the ledger.
//
// A seam is ONE LINE. Never a message row, never a block — that is the whole
// visual claim, and it is why the binding below carries named parts rather than
// prose: the parts are laid out on one line by the ledger frame, and a producer
// that composed a sentence here would have decided the layout.
//
// WIRE TRUTH. Each binding carries the wire types it reads verbatim. The two switch
// settlements are the contract's own constants; the event census does not register them
// yet, so whether a type is registered is asked of the contract by
// `system-message-classifier.ts` rather than hand-copied here, and a switch row that
// arrives before the registration says so on its line.
//
// WHAT THIS MODULE IS NOT. It classifies nothing. `system-message-classifier.ts` holds
// the epoch rule — which rows are seams, and what one row's seam reads — and takes the
// table below as its closed input.

import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
} from "@ai-sidekicks/contracts";

import { type GlyphName } from "@renderer/styles/glyphs.js";

/**
 * Every seam the ledger draws. Closed; adding one is a deliberate edit here and a
 * reading of the epoch rule above.
 *
 * The tuple is the declaration and `SystemMessageKind` is derived from it, so the
 * classifier's lookup and the binding table cannot come apart.
 *
 * Four: the three epoch seams (switch, compaction, rollback) and the failed switch.
 * A pause and a continue land no row, so no run-state kind is here.
 */
export const SYSTEM_MESSAGE_KINDS = [
  "provider-switch",
  "provider-switch-failed",
  "compaction",
  "rollback",
] as const;

export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/**
 * Whether the wire type a seam reads is in the registered event census.
 *
 * Rendered, never inferred: a surface showing a seam vocabulary owes the operator
 * the difference between "this has not happened" and "the daemon cannot say this
 * yet".
 */
export type WireTypeRegistration = "registered" | "unregistered";

/** What one seam kind reads, and how it is drawn. */
export interface SystemMessageBinding {
  readonly kind: SystemMessageKind;
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
 * The binding table. Closed and total over `SystemMessageKind` by construction — a
 * fifth kind fails to compile here before it can reach a classifier that would
 * silently never match it.
 */
export const SYSTEM_MESSAGE_BINDINGS: Readonly<Record<SystemMessageKind, SystemMessageBinding>> = {
  "provider-switch": {
    kind: "provider-switch",
    label: "Provider switched",
    wireTypes: [AGENT_PROVIDER_BINDING_CHANGED_EVENT],
    glyph: "chevron-right",
    isCaution: false,
  },
  "provider-switch-failed": {
    kind: "provider-switch-failed",
    label: "Provider switch failed",
    wireTypes: [AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT],
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
};
