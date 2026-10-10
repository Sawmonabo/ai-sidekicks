// The transcript row renderer: the one body every transcript row is drawn with, and which rows it
// draws one for. The transcript feature registers it (`contributions/rows.ts`, under
// `TRANSCRIPT_ROW_OWNER`) and the pane reads it back through `findTranscriptRowRenderer`. One
// renderer, owner-scoped: the same owner may re-register (a hot reload), a different owner is
// refused by name.
// The props carry decisions the list makes, not facts a row holds: `agentHue` comes from
// `AgentHueAllocator` over the session log, `isSuperseded` is the row's superseded mark read by
// the list, and `density` is whether a person folded the row.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type DiagramPictures } from "#renderer/components/Markdown/diagram/pictures.js";
import { type AgentHueAssignment } from "#renderer/styles/agent-hue.js";
import { SingleEntryRegistry } from "#renderer/lib/single-entry-registry.js";
import { type PublishedText } from "../reveal/published-text.js";
import { type OffListTables } from "./markdown/table-window/off-list.js";

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
   * Whether a person opened this call's output whole, so it is drawn uncut. Held by the feed, so
   * it survives the row scrolling out and back, and a fold.
   */
  readonly isOutputOpened: boolean;
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
  /**
   * Starts the work a row's first frame waits on that is not done yet, such as a finished
   * diagram's picture, so the feed lists the row only once it draws whole and keeps the rest of
   * the window ready to scroll to. `undefined` for a row that never waits on anything.
   */
  readonly prepareRow: TranscriptRowPreparer;
}

/** Where a row's first frame reads from, beyond the row itself. */
export interface TranscriptRowSources {
  /** The text the reveal engine is publishing for a row, or `undefined` for a row with none. */
  readonly publishedTextFor: (rowId: string) => PublishedText | undefined;
  /** The window the feed draws in, whose document and palette a row is drawn under. */
  readonly ownerWindow: Window;
  /** The app's diagram pictures, or `undefined` outside the app. */
  readonly diagramPictures: DiagramPictures | undefined;
  /** Where a row's long tables are measured before it is listed. */
  readonly offListTables: OffListTables;
}

/** The work one row's first frame waits on, kept while the window holds the row. */
export interface TranscriptRowPreparation {
  /** Whether every piece of work started so far has landed or failed. */
  readonly isReady: boolean;
  /**
   * Reads the row's text again and starts what its newly finished blocks wait on. A text that did
   * not change costs nothing, and a grown one costs its growth.
   */
  refresh(): void;
  /** Withdraws the work still running. */
  release(): void;
}

/**
 * Starts a row's preparation; see `TranscriptRowRenderer.prepareRow`. `onReady` is called each
 * time the work started so far has all landed or failed.
 */
export type TranscriptRowPreparer = (
  row: TranscriptEventRow,
  sources: TranscriptRowSources,
  onReady: () => void,
) => TranscriptRowPreparation | undefined;

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
