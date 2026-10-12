// One key of the viewport's list, dispatched to what it is: a run group header, an edge of a long
// run's window, a system message, a row the window no longer holds, or a projected row for the
// registered row renderer.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { type AgentHueAssignment } from "#renderer/styles/agent-hue.js";
import {
  readRunWindowEdgeKey,
  type RunCallWindows,
  type RunWindowEdge as RunWindowEdgeName,
} from "../../runs/call-window.js";
import { RunGroupHeader } from "../../runs/components/RunGroupHeader.js";
import { RunWindowEdge } from "../../runs/components/RunWindowEdge.js";
import { type RunGroup } from "../../runs/groups.js";
import { SystemMessage } from "../../system-messages/components/SystemMessage.js";
import { type ViewportRow } from "../../viewport/snapshot.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { type TranscriptRowBody } from "../../rows/renderer.js";
import { densityFor } from "../fold-state.js";
import { TranscriptFeedRow } from "./TranscriptFeedRow.js";

/** Everything the dispatch reads beyond the key itself. Each member is stable except the window. */
export interface TranscriptRowDispatchOptions {
  readonly transcriptWindow: TranscriptWindowModel;
  readonly foldedRunGroupKeys: ReadonlySet<string>;
  readonly foldedCallRowIds: ReadonlySet<string>;
  /** The calls whose output a person opened whole. */
  readonly openedOutputRowIds: ReadonlySet<string>;
  readonly hueForAgent: (actorId: string) => AgentHueAssignment | undefined;
  /** Fold or open a run group, holding its header where it stands. */
  readonly toggleRunGroup: (runGroupKey: string) => void;
  /** The windows of the session's long runs, which an edge line counts the calls beyond. */
  readonly runCallWindows: RunCallWindows;
  /** Open the next stretch of a long run beyond `edge`, holding the reading position. */
  readonly openRunStretch: (runGroup: RunGroup, edge: RunWindowEdgeName) => void;
  /** The registered row renderer's body. STABLE across renders, or the row memo moves with it. */
  readonly renderTranscriptRow: TranscriptRowBody;
}

/** The props of one dispatched key: the viewport row and the options it is looked up in. */
export interface TranscriptRowDispatchProps extends TranscriptRowDispatchOptions {
  readonly row: ViewportRow;
}

/** Draws one key of the viewport's list as the thing it names. */
export function TranscriptRowDispatch(props: TranscriptRowDispatchProps): React.JSX.Element {
  const { transcriptWindow, hueForAgent } = props;
  // A run group header is a row of the list keyed by the group it heads, with no projected row
  // behind it, so it is dispatched before the body lookup.
  const runGroup = transcriptWindow.runGroupByHeaderKey.get(props.row.key);
  if (runGroup !== undefined) {
    return (
      <RunGroupHeader
        runGroup={runGroup}
        isOpen={!props.foldedRunGroupKeys.has(runGroup.key)}
        agentHue={runGroup.actorId === undefined ? undefined : hueForAgent(runGroup.actorId)}
        onToggle={props.toggleRunGroup}
      />
    );
  }
  const edgeRow = readRunWindowEdgeKey(props.row.key, transcriptWindow.runGroupByHeaderKey);
  const edgeWindow =
    edgeRow === undefined ? undefined : props.runCallWindows.resolvedWindowOf(edgeRow.runGroup.key);
  if (edgeRow !== undefined && edgeWindow !== undefined) {
    return (
      <RunWindowEdge
        runGroup={edgeRow.runGroup}
        edge={edgeRow.edge}
        count={edgeRow.edge === "earlier" ? edgeWindow.earlierCount : edgeWindow.laterCount}
        onOpen={props.openRunStretch}
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
  // boundary. The dispatch re-renders on every admitted event, but the six values below are
  // identity-stable when the row did not move, so only the lookups run, not the card.
  return (
    <TranscriptFeedRow
      row={projected}
      agentHue={agentHue}
      isSuperseded={isSuperseded}
      // Read from the session's folds, not the row, so a folded call stays folded when it
      // scrolls out of the drawn window and back.
      density={densityFor(projected.id, props.foldedCallRowIds)}
      isOutputOpened={props.openedOutputRowIds.has(projected.id)}
      replyRowIds={transcriptWindow.replyRowIdsByFootRowId.get(projected.id)}
      renderTranscriptRow={props.renderTranscriptRow}
    />
  );
}
