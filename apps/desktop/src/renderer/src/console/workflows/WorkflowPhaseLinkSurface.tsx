// What `#/session/<sid>/workflow/<rid>/phase/<pid>` opens: that run's pane, on that
// phase.
//
// THE ADDRESS EXISTED AND REACHED NOTHING. `routing/routes.ts` has parsed and formatted
// the phase deep link since the grammar grew it, and no surface consumed
// `workflowPhase` — so following such a link changed the hash, changed the route
// identity, and mounted the ordinary workspace. A parked phase was addressable in
// writing and reachable only by somebody already looking at the run pane, which is the
// one person the link is not for. This module is the consumer that was missing.
//
// IT LIVES IN THE FAMILY THAT OWNS THE PANE. `routing/` sits near the floor of the
// console's family DAG and knows nothing above it; the frame mounts whatever the route
// names and imports no view family. So the consumer is neither of those: it is the
// family that owns `workflow-run`, reaching the frame through the surface registry
// exactly as the rail's own destination does.
//
// THE PANE COMES THROUGH THE BOARD AND NOT THROUGH AN IMPORT. `OpenPaneBody` resolves
// the registered body off the pane board this composition was handed and composes the
// pane context around it — the same door `WorkflowsPaneHost` opens a pane through, and
// the same one the deck will. Rendering `WorkflowRunPane` directly from here would be a
// second mount path for one body, composing a second pane context beside the first, and
// the two would drift the first time either gained a member.
//
// AND THE PHASE DOES NOT TRAVEL ON THE ADDRESS. A pane address is the pane's IDENTITY
// and is parsed back out of a persisted layout, so a focus written into it would be
// restored days later as though somebody had just followed the link. The run pane reads
// the focus off the window's own route instead, guarded on the run it is addressed at —
// `WorkflowRunPane.tsx` states that from its side.
//
// WHAT THIS SURFACE DOES NOT DO. It resolves no run, checks no phase against one, and
// draws no absence of its own for either: a run the session does not carry comes back as
// the run read's own refusal inside the pane, and a phase the run is not parked on
// resolves to the wait the pane would have opened anyway. Adjudicating either here would
// be a second answer to a question the daemon and the pane already answer, and it would
// have to be wrong first — before the read that settles it has landed.

import { Nothing } from "../primitives/index.js";
import { routeSessionId, routeWorkflowPhase } from "../routing/index.js";
import type { ConsolePaneAddress, ConsoleSurfaceContext } from "../seats/index.js";
import { OpenPaneBody } from "./OpenPaneBody.js";

export interface WorkflowPhaseLinkSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

/** The run pane a phase address opens, mounted at the run that address names. */
export function WorkflowPhaseLinkSurface(props: WorkflowPhaseLinkSurfaceProps): React.JSX.Element {
  const { context } = props;
  const focus = routeWorkflowPhase(context.route);
  if (focus === undefined) {
    // Unreachable through `surfaceSlotFor`, which maps this slot from the focused arm
    // and from no other — and stated anyway, because a surface is handed a route rather
    // than a proof about one, and a body that assumed its own arm would render the
    // previous route's run under an address that names none.
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="This address names no workflow phase."
        detail="A phase link carries the run and the phase it opens; this one carries neither."
      />
    );
  }
  const address: ConsolePaneAddress = {
    kind: "workflow-run",
    entity: { kind: "workflow-run", id: focus.workflowRunId },
  };
  return (
    <OpenPaneBody
      address={address}
      context={context}
      // The route's own session, which is the session the address names. A phase link is
      // a workspace address, so there is no scope picker above this surface and nothing
      // else for the pane's store to be resolved from.
      scopeSessionId={routeSessionId(context.route)}
    />
  );
}
