// The row footer renderer: where a row-level control another feature owns sits (the edit
// control on a user message). It is a second registry beside the row renderer so that feature
// need not own every row body, and the row hands the owner's element to `MessageRow` as its
// edit control. The contract carries only the row and its superseded ranking, no caller or
// run state: whether a person may edit is a daemon predicate, not something computed here.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { SingleEntryRegistry } from "#renderer/lib/single-entry-registry.js";

/** What the transcript hands a row footer. */
export interface TranscriptRowFooterRendererProps {
  /** The projected row, wire-verbatim, as `@ai-sidekicks/contracts` defines it. */
  readonly row: TranscriptEventRow;
  /**
   * Whether a rollback boundary later in the list supersedes this row. A ranking over the rows
   * around this one, which no single row carries; a control that rewinds needs it.
   */
  readonly isSuperseded: boolean;
}

/** The footer body. Returns `React.ReactNode` so the row can render it directly. */
export type TranscriptRowFooterRenderer = (
  props: TranscriptRowFooterRendererProps,
) => React.ReactNode;

const transcriptRowFooterRegistry = new SingleEntryRegistry<TranscriptRowFooterRenderer>(
  "transcript row footer",
  "a user message carries one set of actions after Copy; a second " +
    "owner would make which one renders depend on import order",
);

/**
 * The call the footer's owner makes to register its renderer. A second owner is refused
 * naming both, not decided by import order.
 */
export function registerTranscriptRowFooterRenderer(
  owner: string,
  render: TranscriptRowFooterRenderer,
): void {
  transcriptRowFooterRegistry.register({ owner, render });
}

/** The footer body, or `undefined` while nothing is registered. */
export function findTranscriptRowFooterRenderer(): TranscriptRowFooterRenderer | undefined {
  return transcriptRowFooterRegistry.renderer();
}
