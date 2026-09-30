// One phase, as a box on the canvas. The library supplies position, focus and handle geometry;
// everything a reader looks at is drawn here from design tokens through data attributes. The
// state line prints the members `phaseNodeAccessibleName` reads, and the daemon-sent id, state
// and gate state render as wire figures. Park comes from `parkAttention`, never from state.

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { PhaseFlowNode } from "./run-graph-elements.js";
import { PHASE_PARK_ATTENTION_MARKS } from "./phase-topology.js";

/**
 * One phase's box. Rendered by the library, addressed by `PHASE_NODE_TYPE`.
 *
 * The handles are unconnectable geometry: an edge attaches to a handle, and this canvas has
 * no connect mode.
 */
export function PhaseNode(props: NodeProps<PhaseFlowNode>): React.JSX.Element {
  const { phase } = props.data;
  return (
    <div
      className="meridian-phase-node"
      data-state={phase.state}
      data-gate={phase.gateState}
      data-park={phase.parkAttention}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="meridian-phase-node__handle"
      />
      {phase.displayName === undefined ? null : (
        <span className="meridian-phase-node__name">{phase.displayName}</span>
      )}
      <span className="meridian-phase-node__id">
        <WireFigure value={phase.phaseId} />
      </span>
      <span className="meridian-phase-node__state">
        <WireFigure value={phase.state} />
        <span className="meridian-phase-node__gate">
          gate <WireFigure value={phase.gateState} />
        </span>
        {phase.parkAttention === undefined ? null : (
          <span className="meridian-phase-node__park">
            {PHASE_PARK_ATTENTION_MARKS[phase.parkAttention]}
          </span>
        )}
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="meridian-phase-node__handle"
      />
    </div>
  );
}
