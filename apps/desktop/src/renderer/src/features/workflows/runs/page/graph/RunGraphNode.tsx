// One node of the run, as a box on the canvas: its name and its first output's item count, short
// on the box and whole in its hover label; its kind as words, which the box is sized to hold; and
// a ring and a line saying what its latest step is doing and which attempt it is. The library
// supplies position, focus and handle geometry; every color is drawn from design tokens through the
// data attributes the sheet reads.

import "./RunGraphNode.css";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { formatCompactCount } from "#renderer/lib/wire/figures.js";
import { joinFigureSentence } from "#renderer/lib/figure-sentence.js";
import { itemCountWords, nodeKindWords } from "#renderer/features/workflows/words.js";
import { DayClockFigure } from "#renderer/features/workflows/components/DayClockFigure.js";
import { handleOffset, type RunGraphFlowNode } from "./elements.js";
import { RUN_GRAPH_RESUME_WORDS } from "./node-views.js";

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
        {view.outputCount === undefined ? null : (
          <span className="meridian-run-graph-node__count">
            <WireFigure
              value={formatCompactCount(view.outputCount)}
              hoverLabel={joinFigureSentence(itemCountWords(view.outputCount, "wire"))}
            />
          </span>
        )}
      </span>
      <span className="meridian-run-graph-node__kind">{nodeKindWords(view.node.kind)}</span>
      <span className="meridian-run-graph-node__state">
        {view.stateWords}
        {view.attemptWords === undefined ? null : (
          <>
            {" · "}
            <FigureSentence parts={view.attemptWords} />
          </>
        )}
      </span>
      {view.errorLine === undefined ? null : (
        <span className="meridian-run-graph-node__error">
          <FigureSentence parts={view.errorLine} />
        </span>
      )}
      {view.resumeFigure === undefined ? null : (
        <span className="meridian-run-graph-node__resume">
          {RUN_GRAPH_RESUME_WORDS} <DayClockFigure {...view.resumeFigure} />
        </span>
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
