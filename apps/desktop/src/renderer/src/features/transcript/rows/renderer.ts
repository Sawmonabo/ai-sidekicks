// The transcript row renderer: the one body every transcript row is drawn with, and which rows it
// draws one for. The transcript feature registers it (`contributions/rows.ts`, under
// `TRANSCRIPT_ROW_OWNER`) and the pane reads it back through `findTranscriptRowRenderer`. One
// renderer, owner-scoped: the same owner may re-register (a hot reload), a different owner is
// refused by name.
// The props carry decisions the list makes, not facts a row holds: `agentHue` comes from
// `AgentHueAllocator` over the session log, `isSuperseded` is the row's superseded mark read by
// the list, and `density` is whether a person folded the row.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type AgentHueAssignment } from "#renderer/styles/agent-hue.js";
import { SingleEntryRegistry } from "#renderer/lib/single-entry-registry.js";

/**
 * Whether a row is folded: a call with a body is open until a person folds it, and nothing folds
 * itself. Two values, not a spacing scale.
 */
export const TRANSCRIPT_ROW_DENSITIES = ["collapsed", "expanded"] as const;

/** Whether one row is folded. Derived from the enumeration, never restated. */
export type TranscriptRowDensity = (typeof TRANSCRIPT_ROW_DENSITIES)[number];

/** What the transcript list hands each row. */
export interface TranscriptRowProps {
  /** The projected row, wire-verbatim, as `@ai-sidekicks/contracts` defines it. */
  readonly row: TranscriptEventRow;
  /**
   * The author's place on the twelve-step wheel, or `undefined` for a row with no attributable
   * agent. The whole assignment, not a color string: past twelve agents the wheel wraps and two
   * agents share a step. `undefined`, not step zero, which
   * belongs to somebody.
   */
  readonly agentHue: AgentHueAssignment | undefined;
  /** Whether a rollback boundary later in the list supersedes this row. */
  readonly isSuperseded: boolean;
  readonly density: TranscriptRowDensity;
  /**
   * On the row that carries a reply's foot, the reply's rows in log order, whose text its Copy
   * takes; absent on every other row.
   */
  readonly replyRowIds?: readonly string[] | undefined;
}

/** The row body. Returns `React.ReactNode` so the list can render it directly. */
export type TranscriptRowBody = (props: TranscriptRowProps) => React.ReactNode;

/** The registered row renderer: the body it draws a row with, and which rows it has one for. */
export interface TranscriptRowRenderer {
  readonly render: TranscriptRowBody;
  /**
   * Whether `render` draws anything for this row. The feed asks before a row reaches the list, so
   * a row with no body takes no place and no height there.
   */
  readonly drawsBody: (row: TranscriptEventRow) => boolean;
}

const transcriptRowRegistry = new SingleEntryRegistry<TranscriptRowRenderer>(
  "transcript row",
  "the transcript draws every row with one renderer, registered once by the transcript feature",
);

/** Register the transcript's row renderer; a second owner is refused by name. */
export function registerTranscriptRowRenderer(
  owner: string,
  renderer: TranscriptRowRenderer,
): void {
  transcriptRowRegistry.register({ owner, render: renderer });
}

/** The row renderer, or `undefined` while nothing is registered. */
export function findTranscriptRowRenderer(): TranscriptRowRenderer | undefined {
  return transcriptRowRegistry.renderer();
}
