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
 * Build the feed's row renderer.
 *
 * Its identity moves whenever the window does, and that is deliberate: the window is
 * what a row's body is looked up in, so a callback pinned across a changed window
 * would hand the viewport a lookup that could not see the change.
 */
export function useTranscriptRowRenderer(
  options: TranscriptRowRendererOptions,
): ViewportRowRenderer {
  const { transcriptWindow, openedTerminalRunIds, hueForActor, toggleRunGroup, rowLease } = options;
  const renderTranscriptRow = options.renderTranscriptRow;
  return useCallback(
    (row: ViewportRow) => {
      // A RUN GROUP HEADER IS A ROW OF THE LIST, keyed by the run it heads, so it is
      // dispatched before the body lookup — there is no projected row behind it and
      // there was never meant to be. Every terminal run group has one; a live run group
      // has none and its rows stay top-level.
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
        // The window moved under the viewport between its reconcile and this paint.
        // Named rather than rendered as a blank band: a row that vanished mid-frame
        // is a fact about the cap, not about the session.
        return (
          <Nothing kind="not-loaded" placement="inline" title="This entry is no longer loaded." />
        );
      }
      const actorHue = projected.actor === undefined ? undefined : hueForActor(projected.actor);
      const isSuperseded = transcriptWindow.supersededRowIds.has(projected.id);
      // A SEAM IS THE TRANSCRIPT'S OWN ROW, so it is drawn before the row renderer is
      // asked. The row renderer draws a session's row BODIES, and a seam has none: it is a change in the run's condition, laid on one line from
      // parts `system-message-classifier.ts` derived. Delegating it would render a rollback, a
      // compaction or a switch as an ordinary receipt and drop the boundary position,
      // the continuity, the losses and the reason.
      const seam = transcriptWindow.seamByRowId.get(projected.id);
      if (seam !== undefined) {
        return <SystemMessage seam={seam} actorHue={actorHue} isSuperseded={isSuperseded} />;
      }
      // THROUGH `TranscriptFeedRow` RATHER THAN STRAIGHT INTO THE ROW RENDERER, and the
      // indirection is the memo boundary — see that file. This callback's identity
      // moves on every admitted event because it closes over the window, so the
      // viewport's own row memo cannot hold across one; the four values below are
      // identity-stable when nothing about the row moved, so the card behind them
      // does hold. What runs per row per event is these lookups, not the card.
      return (
        <TranscriptFeedRow
          row={projected}
          actorHue={actorHue}
          isSuperseded={isSuperseded}
          // THE LEASE OVERLAYS THE LIST, and the list is the fallback rather than the
          // other way round: a row nobody has touched holds no lease and follows the
          // run group fold, and a row somebody opened keeps that choice across an
          // unmount and across a prune, because the window re-parks it.
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
