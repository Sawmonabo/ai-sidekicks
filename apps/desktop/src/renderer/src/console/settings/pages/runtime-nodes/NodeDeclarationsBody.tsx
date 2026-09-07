// The three arms of what the roster read answered, and what each one draws.
//
// THE ARMS ARE THE OBSERVATION'S OWN, not a second reading of the same wire. What this
// body renders comes from the response the absorbed roster ALREADY read, recorded as it
// passed through the console's own seam — so the declarations on screen and the rows
// beside them are one answer. A second `runtimenode.roster` would be a second answer,
// and two answers that disagree are indistinguishable to a person reading both.
//
// WHY `unread` AND "no nodes" ARE DIFFERENT ARMS. Before the roster's own effect has
// fired there is no answer, and saying "no machine is attached to this session" then is
// a false statement about the session rather than an honest one about the read. The
// empty arm renders only where the control plane actually answered with an empty set.
//
// THE REFUSAL RENDERS THROUGH `InlineRefusal`, which is the console's own shape for one:
// the refuser's code verbatim, its sentence, and its origin. The absorbed roster beside
// this block renders the same refusal in its own words — `name: message` under an alert
// role with a retry — and that is its render to make. This block does not paraphrase it
// and does not offer a second retry: one control that re-opens a subscription is enough,
// and the second would be a second path into a seam this console does not own.

import type { ReactNode } from "react";

import type { NodeRosterObservation } from "../../../seats/index.js";
import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import { NodeDeclarationRow } from "./NodeDeclarationRow.js";

export function NodeDeclarationsBody(props: {
  readonly observation: NodeRosterObservation;
}): ReactNode {
  const { observation } = props;

  if (observation.kind === "unread") {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="Reading what each machine declares about itself."
      />
    );
  }

  if (observation.kind === "unreadable") {
    return <InlineRefusal {...observation.refusal} />;
  }

  if (observation.response.nodes.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No machine is attached to this session."
        detail="The control plane answered, and its roster is empty. A node joins by attaching from its own runtime — nothing about that happens in this window."
      />
    );
  }

  return (
    <ul className="meridian-node-declarations__rows">
      {observation.response.nodes.map((node) => (
        <NodeDeclarationRow key={node.nodeId} node={node} />
      ))}
    </ul>
  );
}
