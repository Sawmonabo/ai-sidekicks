// One key of the viewport's list, dispatched to what it is: a run group header, a system message,
// a row the window no longer holds, or a projected row for the registered row renderer.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";
import { RunGroupHeader } from "../../run-groups/components/RunGroupHeader.js";
import { type RunGroup } from "../../run-groups/run-groups.js";
import { SystemMessage } from "../../system-messages/components/SystemMessage.js";
import { type RetainedRowState } from "../../viewport/retained-row-state-table.js";
import { type ViewportRow } from "../../viewport/viewport-snapshot.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { type TranscriptRowRenderer } from "../../transcript-row-renderer.js";
import { densityFor } from "../run-group-fold.js";
import { TranscriptFeedRow } from "./TranscriptFeedRow.js";

/** Everything the dispatch reads beyond the key itself. Each member is stable except the window. */
export interface TranscriptRowDispatchOptions {
  readonly transcriptWindow: TranscriptWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly hueForAgent: (actorId: string) => AgentHueAssignment | undefined;
  readonly toggleRunGroup: (runGroup: RunGroup) => void;
  readonly retainedRowState: (rowKey: string) => RetainedRowState | undefined;
  /** The registered row renderer. STABLE across renders, or the row memo moves with it. */
  readonly renderTranscriptRow: TranscriptRowRenderer;
}

/** The props of one dispatched key: the viewport row and the options it is looked up in. */
export interface TranscriptRowDispatchProps extends TranscriptRowDispatchOptions {
  readonly row: ViewportRow;
}

/** Draws one key of the viewport's list as the thing it names. */
export function TranscriptRowDispatch(props: TranscriptRowDispatchProps): React.JSX.Element {
  const { transcriptWindow, hueForAgent } = props;
  // A run group header is a row of the list keyed by the run it heads, with no projected row
  // behind it, so it is dispatched before the body lookup. A live run group has none.
  const runGroup = transcriptWindow.runGroupByHeaderKey.get(props.row.key);
  if (runGroup !== undefined) {
    return (
      <RunGroupHeader
        runGroup={runGroup}
        isOpen={props.openedTerminalRunIds.has(runGroup.runId)}
        agentHue={runGroup.actorId === undefined ? undefined : hueForAgent(runGroup.actorId)}
        onToggle={props.toggleRunGroup}
      />
    );
  }
  const projected = transcriptWindow.rowsByKey.get(props.row.key);
  if (projected === undefined) {
    // The window moved under the viewport between its reconcile and this paint. Named rather
    // than left blank: a vanished row is a fact about the cap, not the session.
    return <Nothing kind="not-loaded" placement="inline" title="This entry is no longer loaded." />;
  }
  const agentHue = projected.actor === undefined ? undefined : hueForAgent(projected.actor);
  const isSuperseded = transcriptWindow.supersededRowIds.has(projected.id);
  // A system message is the transcript's own row, drawn before the row renderer is asked: it has
  // no body, being a change in the run's condition laid on one line. Delegating it would render
  // it as an ordinary receipt.
  const systemMessage = transcriptWindow.systemMessageByRowId.get(projected.id);
  if (systemMessage !== undefined) {
    return (
      <SystemMessage
        systemMessage={systemMessage}
        agentHue={agentHue}
        isSuperseded={isSuperseded}
      />
    );
  }
  // Through `TranscriptFeedRow` rather than straight into the row renderer: it is the memo
  // boundary. The dispatch re-renders on every admitted event, but the five values below are
  // identity-stable when the row did not move, so only the lookups run, not the card.
  return (
    <TranscriptFeedRow
      row={projected}
      agentHue={agentHue}
      isSuperseded={isSuperseded}
      // The retained state overlays the list, which is the fallback: an untouched row holds none
      // and follows the run group fold, and an opened row keeps its choice across an unmount and
      // a prune, because the window re-parks it.
      density={
        props.retainedRowState(projected.id)?.density ??
        densityFor(projected.id, transcriptWindow.collapsedRowIds)
      }
      replyRowIds={transcriptWindow.replyRowIdsByFootRowId.get(projected.id)}
      renderTranscriptRow={props.renderTranscriptRow}
    />
  );
}
