// Which node performs the attach, chosen from the session's own roster.
//
// A RADIO GROUP AND NOT A SELECT, because the two axes each row discloses do not fit
// in an option label and must not be flattened into one: a node whose slot reads
// `online` and whose presence reads `offline` is a real disagreement the wire keeps,
// and a picker that had room for one word would have picked which half to believe.
//
// EVERY NODE IS OFFERED, INCLUDING THE ONES THAT LOOK UNUSABLE. Whether a given node
// can reach a given path is that node's answer and not this console's, so nothing here
// is disabled by health: a node that cannot serve the attach refuses it with a typed
// code and the dialog renders that code. Disabling rows here would make a refusable
// attach look impossible and would hide the reason.
//
// THE NODE ID IS A `WireFigure` — verbatim, middle-truncated by the stylesheet, whole
// on the element's title — because it is a wire value and this console renders those
// one way everywhere.

import { Chip, WireFigure } from "../../../primitives/index.js";
import { NO_HEARTBEAT_YET, type AttachNodeOption } from "./attach-model.js";

export interface NodePickerProps {
  readonly options: readonly AttachNodeOption[];
  readonly selectedNodeId: string | undefined;
  /** Every radio in one group needs one name; the caller's dialog supplies it. */
  readonly groupName: string;
  readonly onSelect: (nodeId: string) => void;
}

export function NodePicker(props: NodePickerProps): React.JSX.Element {
  return (
    <fieldset className="meridian-attach__nodes">
      <legend className="meridian-attach__legend">Node</legend>
      {props.options.map((option) => (
        <label className="meridian-attach__node" key={option.nodeId}>
          <input
            type="radio"
            name={props.groupName}
            value={option.nodeId}
            checked={props.selectedNodeId === option.nodeId}
            onChange={() => {
              props.onSelect(option.nodeId);
            }}
          />
          <WireFigure value={option.nodeId} title={option.nodeId} />
          <Chip label={option.state} mono tone="neutral" />
          {/*
            THE SECOND AXIS, ALWAYS DRAWN, including for a node that has never sent a
            heartbeat: an absent presence row is a fact about the node — it has not
            beat yet — and a row that simply omitted the chip would read as a node
            whose liveness nobody asked about.
          */}
          {option.healthState === "offline" ? (
            <Chip label={option.healthState} mono tone="failure" glyph="alert" />
          ) : (
            <Chip label={option.healthState} mono tone={healthToneFor(option.healthState)} />
          )}
          {option.readOnly ? (
            // DISCLOSED AND NOT ENFORCED. A read-only node is one this session may not
            // write through, which is very likely to make the attach refuse — but the
            // refusal is the daemon's to give and its code is what says why.
            <Chip label="read-only" mono tone="attention" />
          ) : null}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The tone one liveness reading wears.
 *
 * ONLY `offline` EARNS FAILURE, and the restraint is deliberate: `degraded` is a node
 * still answering, `online` is the ordinary state, and a node that has not beat yet is
 * an unanswered question rather than a fault. Toning three of the four as problems
 * would spend the palette's alarm on the state a session normally sits in.
 */
function healthToneFor(healthState: string): "neutral" | "attention" | "failure" {
  if (healthState === "offline") {
    return "failure";
  }
  if (healthState === "degraded" || healthState === NO_HEARTBEAT_YET) {
    return "attention";
  }
  return "neutral";
}
