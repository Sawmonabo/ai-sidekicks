// One node of the run, as a box on the canvas: its name and its first output's item count, its
// kind, and a ring and a line saying what its latest step is doing and which attempt it is. The
// library supplies position, focus and handle geometry; every color is drawn from design tokens
// through the data attributes the sheet reads.

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { handleOffset, type RunGraphFlowNode } from "./run-graph-elements.js";

/**
 * One node's box, rendered by the library under `RUN_GRAPH_NODE_TYPE`. The handles, one per id
 * the document's edges name, are unconnectable geometry an edge attaches to; this canvas has no
 * connect mode.
 */
export function RunGraphNode(props: NodeProps<RunGraphFlowNode>): React.JSX.Element {
  const { view, handles } = props.data;
  return (
    <div
      className="meridian-run-graph-node"
      data-status={view.status}
      data-waiting-on-person={view.isWaitingOnPerson}
      data-disabled={view.isDisabled}
      data-selected={props.selected}
    >
      {handles.inputs.map((id, index) => (
        <Handle
          key={id}
          id={id}
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="meridian-run-graph-node__handle"
          style={{ top: handleTop(index, handles.inputs.length) }}
        />
      ))}
      <span className="meridian-run-graph-node__head">
        <span className="meridian-run-graph-node__name">{view.node.name}</span>
        {view.outputCountWords === undefined ? null : (
          <span className="meridian-run-graph-node__count">{view.outputCountWords}</span>
        )}
      </span>
      <span className="meridian-run-graph-node__kind">
        <WireFigure value={view.node.kind} truncate />
      </span>
      <span className="meridian-run-graph-node__state">
        {view.attemptWords === undefined
          ? view.stateWords
          : `${view.stateWords} · ${view.attemptWords}`}
      </span>
      {view.errorLine === undefined ? null : (
        <span className="meridian-run-graph-node__error">{view.errorLine}</span>
      )}
      {view.resumeLine === undefined ? null : (
        <span className="meridian-run-graph-node__resume">{view.resumeLine}</span>
      )}
      {handles.outputs.map((id, index) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="meridian-run-graph-node__handle"
          style={{ top: handleTop(index, handles.outputs.length) }}
        />
      ))}
    </div>
  );
}

/** A handle's place down its side as a share of the box, matching the stated handle geometry. */
function handleTop(index: number, count: number): string {
  return `${String(handleOffset(100, index, count))}%`;
}
