// The transcript row renderer: the one body every transcript row is drawn with.
//
// The transcript feature registers it (`contributions/transcript-rows.ts`, under
// `TRANSCRIPT_ROW_OWNER`) and the transcript pane reads it back through
// `findTranscriptRowRenderer`. It holds one renderer, owner-scoped: the same owner may
// register again, which is what a hot reload does, and a different owner is refused by
// name, so which body draws the rows never depends on module import order.
//
// WHY THE PROPS ARE NOT JUST `row`
//
// Three of the four members are decisions the LIST makes, not facts the row
// carries, and a renderer that re-derived them would be a second source of truth
// for each:
//
//   • `actorHue` is allocated by `AgentHueAllocator` over the session's
//     join log — order-dependent state no single row can see.
//   • `isSuperseded` is a rollback-boundary ranking over the rows AROUND this one.
//     Only `TimelineRow`'s `run` arm carries a `superseded` marker at all; a
//     `general` row after a boundary is superseded too and says so nowhere in its
//     own shape.
//   • `density` is the list's collapse state for this row, under the transcript's
//     density budgets.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";
import { SingleEntryRegistry } from "@renderer/lib/single-entry-registry.js";

/**
 * A row's collapse state, under the transcript's density rule: tool rows render as one
 * line until opened; run groups collapse once terminal and the live run group stays
 * open.
 *
 * Two values and not a numeric scale: the rule is about what is COLLAPSED, and a
 * comfortable/compact spacing axis would be a second, unrelated meaning wearing
 * the same word.
 */
export const TRANSCRIPT_ROW_DENSITIES = ["collapsed", "expanded"] as const;

/** One row's collapse state. Derived from the enumeration, never restated. */
export type TranscriptRowDensity = (typeof TRANSCRIPT_ROW_DENSITIES)[number];

/** What the transcript list hands each row. */
export interface TranscriptRowProps {
  /** The projected row, wire-verbatim, as `@ai-sidekicks/contracts` defines it. */
  readonly row: TimelineRow;
  /**
   * The author's place on the twelve-step wheel, or `undefined` for a row with no
   * attributable user.
   *
   * The whole assignment rather than a color string because the hue is never the sole
   * attribution channel — past twelve users the wheel wraps and the ring
   * treatment is what tells two people on one step apart. A row handed only a color
   * could not render that, and `undefined` is the fail-closed answer rather than step
   * zero, which belongs to somebody.
   */
  readonly actorHue: AgentHueAssignment | undefined;
  /** Whether a rollback boundary later in the list supersedes this row. */
  readonly isSuperseded: boolean;
  readonly density: TranscriptRowDensity;
}

/** The row body. Returns `React.ReactNode` so the list can render it directly. */
export type TranscriptRowRenderer = (props: TranscriptRowProps) => React.ReactNode;

const transcriptRowRegistry = new SingleEntryRegistry<TranscriptRowRenderer>(
  "transcript row",
  "the transcript draws every row with one renderer, registered once by the transcript feature",
);

/**
 * Register the transcript's row renderer.
 *
 * A second owner is refused by name rather than winning or losing by import order.
 */
export function registerTranscriptRowRenderer(owner: string, render: TranscriptRowRenderer): void {
  transcriptRowRegistry.register({ owner, render });
}

/**
 * Release the registered renderer.
 *
 * Test scaffolding: the registry is module-scope, so a case that fills it would leak
 * into the next one.
 */
export function unregisterTranscriptRowRenderer(): void {
  transcriptRowRegistry.unregister();
}

/** The row body, or `undefined` while nothing is registered. */
export function findTranscriptRowRenderer(): TranscriptRowRenderer | undefined {
  return transcriptRowRegistry.renderer();
}
