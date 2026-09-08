// "Start a workflow", in the composer's own menu.
//
// THE SEAT IS THE COMPOSER'S AND THE BODY IS THIS FAMILY'S. The composer owns the
// disclosure, its position, and the session the run would start in; what goes inside is
// the definition enumeration and the start, which are this family's. The seat stood
// reserved while this family had no enumeration to offer, and now it has one.
//
// IT IS THE DISCOVERABLE HALF OF ONE ACT AND NOT A SECOND ONE. The directive line's
// accelerator resolves a name somebody already knows and reaches the same two wires; this
// lists what there is. Both start the same way, so nothing here is a second start
// semantics and no second command root exists.
//
// THE READ IS THE FAMILY'S OWN AND IS PUT ONCE. `useWorkflowDefinitionDirectory` holds
// its answer against the port and the session, pages on request, and never polls — so
// opening the menu twice in one session asks nothing the second time, and a composer
// re-addressed to another session reads that session's list from the first frame.
//
// EVERY STATE IS DRAWN AND NONE IS GUESSED. A read in flight, a refused read, an
// enumeration that is genuinely empty, a start in flight, a start that landed, and a
// start the daemon denied are six different things a person can meet here, and each says
// which it is. In particular an empty enumeration is not a dead control: it says where
// definitions come from rather than offering a button that would refuse.
//
// NO ELIGIBILITY IS DERIVED HERE. Whether this participant may start a run is the
// daemon's adjudication; the control is offered and its refusal is rendered. A menu that
// hid the entry for a viewer would be a renderer deciding a question it does not own —
// and would hide the one surface that explains the refusal.

import { Chip, InlineRefusal, Nothing, PartialRead, WireFigure } from "../../primitives/index.js";
import type { GrowthPort } from "../../bridge/index.js";
import { useWorkflowDefinitionDirectory } from "../definitions/definition-directory.js";
import { WorkflowStartDenial } from "./WorkflowStartDenial.js";
import { useWorkflowStartAct, type WorkflowStartAct } from "./start-act.js";

export interface WorkflowStartMenuProps {
  /**
   * The port both wires ride, and the whole of what this body needs of the bridge.
   *
   * The port rather than the bridge, because that is the subject the read and the act
   * are held against: `useSubjectScopedState` keys on it, and a body handed the whole
   * bridge would have to reach for the same member and could be handed one whose port
   * had been replaced underneath it without the holder noticing.
   */
  readonly growth: GrowthPort;
  /** The session the run starts in — the composer's own, never resolved here. */
  readonly sessionId: string;
  /**
   * The originating channel, where this composer is addressed at one.
   *
   * Provenance only, and never typed by anybody: the composer reads it off the address
   * it already holds, and the daemon validates the starter's membership before it binds
   * a surface.
   */
  readonly channelId: string | undefined;
}

/** The definition picker and the start it dispatches. */
export function WorkflowStartMenu(props: WorkflowStartMenuProps): React.JSX.Element {
  const { growth, sessionId, channelId } = props;
  const directory = useWorkflowDefinitionDirectory(growth, sessionId);
  const dispatch = useWorkflowStartAct({ growth, sessionId, channelId });
  const { state } = directory;

  return (
    <div className="meridian-workflow-start-menu">
      <p className="meridian-workflow-start-menu__lede">Start a workflow</p>
      {state.status === "unasked" || state.status === "reading" ? (
        <Nothing kind="not-loaded" title="Reading the workflows this session can start." />
      ) : null}
      {state.status === "unavailable" ? (
        <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
      ) : null}
      {state.status === "served" && state.definitions.length === 0 ? (
        <Nothing
          kind="empty"
          title="This session resolves no workflow definitions."
          detail="Definitions are authored in the workflows destination; one saved there becomes startable here."
        />
      ) : null}
      {state.status === "served" && state.definitions.length > 0 ? (
        <ul className="meridian-workflow-start-menu__list" aria-label="Workflow definitions">
          {state.definitions.map((definition) => (
            <li className="meridian-workflow-start-menu__row" key={definition.id}>
              <button
                type="button"
                className="meridian-workflow-start-menu__start"
                onClick={() => {
                  dispatch.start(definition);
                }}
              >
                {definition.name}
              </button>
              {/*
               * The scope is the string the daemon resolves against, so it wears the
               * provenance signature rather than being title-cased into prose — and it is
               * here because two definitions can share a name across scopes, which is
               * exactly the ambiguity the accelerator refuses on.
               */}
              <Chip mono label={definition.scope} />
            </li>
          ))}
        </ul>
      ) : null}
      {state.status === "served" && state.continuation.status === "available" ? (
        <button
          type="button"
          className="meridian-workflow-start-menu__more"
          onClick={directory.continueReading}
        >
          Show more definitions
        </button>
      ) : null}
      {renderAct(dispatch.act)}
    </div>
  );
}

/**
 * What the last start did, where one has been asked for.
 *
 * A function rather than a component: it is one of this menu's regions rather than a body
 * with a life of its own, and the four arms are exhaustive over what the act can be.
 */
function renderAct(act: WorkflowStartAct): React.ReactNode {
  if (act.status === "idle") {
    return null;
  }
  if (act.status === "starting") {
    return <PartialRead states={[{ kind: "reading" }]} subject="this workflow's run" />;
  }
  if (act.status === "refused") {
    return <WorkflowStartDenial code={act.code} detail={act.detail} />;
  }
  return (
    <p className="meridian-workflow-start-menu__started" role="status">
      {`Started ${act.definitionName} — `}
      <WireFigure value={act.workflowRunId} />
    </p>
  );
}
