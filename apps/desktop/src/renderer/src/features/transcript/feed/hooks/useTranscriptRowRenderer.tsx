import { useCallback } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";
import { RunGroupHeader } from "../../run-groups/components/RunGroupHeader.js";
import { type RunGroup } from "../../run-groups/run-groups.js";
import { SystemMessage } from "../../system-messages/components/SystemMessage.js";
import { type RetainedRowState } from "../../viewport/retained-row-state-table.js";
import { type ViewportRowRenderer } from "../../viewport/components/VirtualRow.js";
import { type ViewportRow } from "../../viewport/viewport-snapshot.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { type TranscriptRowRenderer } from "../../transcript-row-renderer.js";
import { TranscriptFeedRow } from "../components/TranscriptFeedRow.js";
import { densityFor } from "../run-group-fold.js";

/** Everything the dispatch below reads. Each member is stable except the window. */
export interface TranscriptRowRendererOptions {
  readonly transcriptWindow: TranscriptWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly hueForActor: (userId: string) => AgentHueAssignment | undefined;
  readonly toggleRunGroup: (runGroup: RunGroup) => void;
  readonly rowLease: (rowKey: string) => RetainedRowState | undefined;
  /** The registered row renderer. STABLE across renders, or the memo below moves with it. */
  readonly renderTranscriptRow: TranscriptRowRenderer;
}

/**
 * Build the feed's row renderer. Its identity moves whenever the window does, deliberately: the
 * window is what a row's body is looked up in, so a callback pinned across a changed window
 * would hand the viewport a lookup that could not see the change.
 */
export function useTranscriptRowRenderer(
  options: TranscriptRowRendererOptions,
): ViewportRowRenderer {
  const { transcriptWindow, openedTerminalRunIds, hueForActor, toggleRunGroup, rowLease } = options;
  const renderTranscriptRow = options.renderTranscriptRow;
  return useCallback(
    (row: ViewportRow) => {
      // A run group header is a row of the list keyed by the run it heads, with no projected row
      // behind it, so it is dispatched before the body lookup. A live run group has none.
      const runGroup = transcriptWindow.runGroupByHeaderKey.get(row.key);
      if (runGroup !== undefined) {
        return (
          <RunGroupHeader
            runGroup={runGroup}
            isOpen={openedTerminalRunIds.has(runGroup.runId)}
            actorHue={runGroup.actorId === undefined ? undefined : hueForActor(runGroup.actorId)}
            onToggle={toggleRunGroup}
          />
        );
      }
      const projected = transcriptWindow.rowsByKey.get(row.key);
      if (projected === undefined) {
        // The window moved under the viewport between its reconcile and this paint. Named
        // rather than a blank band: a vanished row is a fact about the cap, not the session.
        return (
          <Nothing kind="not-loaded" placement="inline" title="This entry is no longer loaded." />
        );
      }
      const actorHue = projected.actor === undefined ? undefined : hueForActor(projected.actor);
      const isSuperseded = transcriptWindow.supersededRowIds.has(projected.id);
      // A seam is the transcript's own row, drawn before the row renderer is asked: it has no
      // body, being a change in the run's condition laid on one line from parts
      // `system-message-classifier.ts` derived. Delegating it would render it as an ordinary
      // receipt and drop the boundary position, continuity, losses and reason.
      const seam = transcriptWindow.seamByRowId.get(projected.id);
      if (seam !== undefined) {
        return <SystemMessage seam={seam} actorHue={actorHue} isSuperseded={isSuperseded} />;
      }
      // Through `TranscriptFeedRow` rather than straight into the row renderer: it is the memo
      // boundary. This callback moves on every admitted event, but the four values below are
      // identity-stable when the row did not move, so only the lookups run, not the card.
      return (
        <TranscriptFeedRow
          row={projected}
          actorHue={actorHue}
          isSuperseded={isSuperseded}
          // The lease overlays the list, which is the fallback: an untouched row holds no lease
          // and follows the run group fold, and an opened row keeps its choice across an unmount
          // and a prune, because the window re-parks it.
          density={
            rowLease(projected.id)?.density ??
            densityFor(projected.id, transcriptWindow.collapsedRowIds)
          }
          renderTranscriptRow={renderTranscriptRow}
        />
      );
    },
    [
      hueForActor,
      transcriptWindow,
      openedTerminalRunIds,
      renderTranscriptRow,
      rowLease,
      toggleRunGroup,
    ],
  );
}
