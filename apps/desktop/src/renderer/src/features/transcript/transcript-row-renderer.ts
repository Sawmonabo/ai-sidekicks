// The transcript row renderer: the one body every transcript row is drawn with. The transcript
// feature registers it (`contributions/transcript-rows.ts`, under `TRANSCRIPT_ROW_OWNER`) and
// the pane reads it back through `findTranscriptRowRenderer`. One renderer, owner-scoped: the
// same owner may re-register (a hot reload), a different owner is refused by name.
// The props carry decisions the list makes, not facts a row holds: `agentHue` comes from
// `AgentHueAllocator` over the session log, `isSuperseded` ranks against rollback boundaries
// around the row, and `density` is the list's collapse state.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";
import { SingleEntryRegistry } from "@renderer/lib/single-entry-registry.js";

/**
 * A row's collapse state: tool rows render as one line until opened; run groups collapse once
 * terminal and the live run group stays open. Two values, not a spacing scale.
 */
export const TRANSCRIPT_ROW_DENSITIES = ["collapsed", "expanded"] as const;

/** One row's collapse state. Derived from the enumeration, never restated. */
export type TranscriptRowDensity = (typeof TRANSCRIPT_ROW_DENSITIES)[number];

/** What the transcript list hands each row. */
export interface TranscriptRowProps {
  /** The projected row, wire-verbatim, as `@ai-sidekicks/contracts` defines it. */
  readonly row: TimelineRow;
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
}

/** The row body. Returns `React.ReactNode` so the list can render it directly. */
export type TranscriptRowRenderer = (props: TranscriptRowProps) => React.ReactNode;

const transcriptRowRegistry = new SingleEntryRegistry<TranscriptRowRenderer>(
  "transcript row",
  "the transcript draws every row with one renderer, registered once by the transcript feature",
);

/** Register the transcript's row renderer; a second owner is refused by name. */
export function registerTranscriptRowRenderer(owner: string, render: TranscriptRowRenderer): void {
  transcriptRowRegistry.register({ owner, render });
}

/** Release the registered renderer. Test scaffolding: the registry is module-scope. */
export function unregisterTranscriptRowRenderer(): void {
  transcriptRowRegistry.unregister();
}

/** The row body, or `undefined` while nothing is registered. */
export function findTranscriptRowRenderer(): TranscriptRowRenderer | undefined {
  return transcriptRowRegistry.renderer();
}
