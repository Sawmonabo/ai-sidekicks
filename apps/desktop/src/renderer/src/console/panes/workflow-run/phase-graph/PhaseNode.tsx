// One phase, as a box on the canvas.
//
// The visuals are OWN-BUILT, which `Spec-023 §Console Libraries` requires of the
// node and edge treatment: the library supplies the box's position, its focus
// handling and its handle geometry, and everything a reader looks at is this file's
// and this family's sheet. Nothing here reads a library colour — the treatment comes
// off Meridian tokens through data attributes, so light and dark are one rule.
//
// THE SAME WORDS, LOOKING AND LISTENING. The state line below prints exactly the
// members `phaseNodeAccessibleName` reads, in the same order, so the node's
// accessible name is a rendering of what is on screen rather than a second, drifting
// description of it.
//
// WHY THE HANDLES ARE HERE AT ALL ON A READ-ONLY SURFACE. The renderer draws an edge
// between two handles and not between two boxes: a node with none is a node no edge
// can reach, and the sequence would render as a column of disconnected cards. They
// are declared unconnectable, so they are geometry and never a drag origin — there
// is no connect mode on this surface and no path that creates an edge.
//
// PARK IS READ FROM THE PARK MEMBER. The phase-state vocabulary carries no suspended
// arm, and park is live-scoped — true for exactly the phases parked when the caller
// built this list. A box that inferred park from a state that looked like waiting
// would be asserting something the run never said.
//
// THREE OF THE FOUR THINGS ON THIS BOX CAME OFF THE WIRE, AND THEY LOOK LIKE IT.
// `Spec-023 §Console Design (Meridian)` rule 4 gives every wire-true figure the mono
// provenance signature, and the phase id, the state and the gate state are all
// strings a daemon sent. They were drawn as ordinary interface prose, which read
// worst on the id: with no authored name available to any read this console can put,
// the id stood in the name's place, in the name's face and weight, and an opaque key
// was presented as something a person had chosen. So the name — where there is one —
// is the only text here the console sets as prose, and the identifier and the two
// enum values go through `WireFigure`.
//
// AND THE PARK'S ATTENTION IS THE CALLER'S READING, NOT THIS BOX'S. Amber means a
// person is needed; a phase parked on provider capacity with a readable resume
// instant needs nobody, so it takes the neutral scheduled treatment. The two are one
// attribute rather than a parked flag plus a hue rule, so the sheet cannot paint a
// treatment the caller never asked for.

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { WireFigure } from "../../../primitives/index.js";
import type { PhaseFlowNode } from "./phase-graph-elements.js";
import { PHASE_PARK_ATTENTION_MARKS } from "./phase-topology.js";

/** One phase's box. Rendered by the library, addressed by `PHASE_NODE_TYPE`. */
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
