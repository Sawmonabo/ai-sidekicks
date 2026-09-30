// The seam vocabulary: which seams the transcript draws, what each reads, and how it is marked.
// A seam is one line, never a message row or block, so a binding carries named parts rather than
// prose. Each binding carries its wire types verbatim. Classification is in
// `system-message-classifier.ts`, which takes this table as its closed input.

import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
} from "@ai-sidekicks/contracts";

import { type GlyphName } from "@renderer/styles/glyphs.js";

/**
 * Every seam the transcript draws. Closed; `SystemMessageKind` derives from this tuple so the
 * classifier's lookup and the binding table cannot come apart. A pause and a continue land no
 * row, so no run-state kind is here.
 */
export const SYSTEM_MESSAGE_KINDS = [
  "provider-switch",
  "provider-switch-failed",
  "compaction",
  "rollback",
] as const;

/** The closed set of seam kinds. */
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/** What one seam kind reads, and how it is drawn. */
export interface SystemMessageBinding {
  readonly kind: SystemMessageKind;
  /**
   * What the one-line row calls this seam. The console's words, not the wire's: the wire type
   * is rendered beside it verbatim in mono.
   */
  readonly label: string;
  /** The wire event types that produce this seam, verbatim. */
  readonly wireTypes: readonly string[];
  /**
   * The glyph the one-line row carries. The glyph set has no rewind or fold glyph, so a
   * rollback takes `clock` and a compaction takes `chevron-down`.
   */
  readonly glyph: GlyphName;
  /** Whether the seam is drawn as a caution; only the failed switch is. */
  readonly isCaution: boolean;
}

/**
 * The binding table. Total over `SystemMessageKind`, so a new kind fails to compile here
 * before it reaches a classifier that would never match it.
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
