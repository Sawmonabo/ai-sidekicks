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
// EVERY STATE IS DRAWN AND NONE IS GUESSED. A read in flight, a refused read, a page
// that held nothing while the enumeration goes on — being read, or waiting to be — an
// enumeration that is genuinely empty, a start in flight, a start that landed, and a
// start the daemon denied are seven different things a person can meet here, and each
// says which it is. In particular an empty enumeration is not a dead control: it says
// where definitions come from rather than offering a button that would refuse. And the
// third of those is not the fourth — the daemon reporting an unread page is the one
// thing that separates "there are none" from "none have been read", which is a claim
// this menu may not make on its behalf.
//
// NO ELIGIBILITY IS DERIVED HERE. Whether this participant may start a run is the
// daemon's adjudication; the control is offered and its refusal is rendered. A menu that
// hid the entry for a viewer would be a renderer deciding a question it does not own —
// and would hide the one surface that explains the refusal.
//
// A CONTROL IS NAMED BY ITS DEFINITION AND ITS SCOPE, BECAUSE THE NAME ALONE DOES NOT
// IDENTIFY IT. Two definitions may deliberately share a name across scopes — that is what
// the scope chip beside each row is FOR — and a chip is not part of the button's
// accessible name, so a screen reader met several identically named start controls with
// no way to tell which one it was about to press. The visible label stays the name alone,
// as designed; the scope reaches the name through `aria-label`, which is how every other
// row control in this console names itself.
//
// A START IN FLIGHT CLOSES EVERY ROW AND THE REASON IS SAID ONCE. The rows are one
// control surface taking one start at a time (`start-flight.ts` holds that rule and the
// guard that enforces it), so while one is outstanding the others would be presses that
// went nowhere. The cause is a sentence for the LIST rather than a copy per row: it is
// one fact about the picker, and it names the definition that is starting, which is the
// half a person needs. The continuation control is deliberately left alone — reading the
// next page is another wire and closing it would be a guess about a call this guard says
// nothing about.
//
// AND A REFUSED PAGE IS A FACT ABOUT ONE PAGE, WHICH IS WHY IT IS DRAWN BESIDE THE
// CONTROL AND NOT INSTEAD OF THE LIST. The directory keeps the cursor a refused
// continuation was asked with — the refusal was about the page, never about the handle —
// so the same ask is exactly what a person retries. This menu used to render the
// continuation only on the `available` arm and a refusal only when the WHOLE directory
// was unavailable, so a refused second page vanished: the rows stayed, nothing said the
// rest had failed to arrive, and the definitions past the first page were unreachable
// again. All three live arms now reach the screen through one control — offered, closed
// while its page is in flight, and offered again under the daemon's own sentence.

import { Chip, InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import type { GrowthPort } from "../../bridge/index.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionContinuation,
} from "../definitions/definition-directory.js";
import { WorkflowStartDenial } from "./WorkflowStartDenial.js";
import { useWorkflowStartAct } from "./start-act.js";
import type { WorkflowStartAct } from "./start-flight.js";

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
  // Read once for the whole list rather than per row: it is one fact about the picker,
  // and the sentence below the rows is the one place it is explained.
  const startInFlight = dispatch.act.status === "starting";

  return (
    <div className="meridian-workflow-start-menu">
      <p className="meridian-workflow-start-menu__lede">Start a workflow</p>
      {state.status === "unasked" || state.status === "reading" ? (
        <Nothing kind="not-loaded" title="Reading the workflows this session can start." />
      ) : null}
      {state.status === "unavailable" ? (
        <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
      ) : null}
      {state.status === "served" && state.definitions.length === 0
        ? renderNoDefinitions(state.continuation)
        : null}
      {state.status === "served" && state.definitions.length > 0 ? (
        <ul className="meridian-workflow-start-menu__list" aria-label="Workflow definitions">
          {state.definitions.map((definition) => (
            <li className="meridian-workflow-start-menu__row" key={definition.id}>
              <button
                type="button"
                className="meridian-workflow-start-menu__start"
                // Composed from the same two values the row draws, so what is heard and
                // what is seen cannot disagree, and the visible name leads it — a voice
                // command spoken from the screen still reaches this control.
                aria-label={`Start ${definition.name} from the ${definition.scope} scope`}
                disabled={startInFlight}
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
      {state.status === "served"
        ? renderContinuation(state.continuation, directory.continueReading)
        : null}
      {renderAct(dispatch.act)}
    </div>
  );
}

/**
 * What an enumeration holding no rows may claim about itself, which depends on whether
 * it is finished.
 *
 * THREE ABSENCES BECAUSE THREE THINGS ARE TRUE AT DIFFERENT MOMENTS, and the browser's
 * own scope groups already draw exactly this split. `not-loaded` while a page that could
 * hold definitions is arriving — wait. `not-checked` once it has, while a cursor remains,
 * because a cursor API may legitimately serve an empty intermediate page and the daemon
 * has explicitly said the enumeration is not finished. `empty` only when it is — the read
 * succeeded, found none, and the next move is to author one.
 *
 * The middle arm is the one this menu used to skip. The definitive claim stood over a
 * page the daemon had told it was not the last, and stood directly above the control
 * offering to read the pages it had just said were not worth reaching — the console
 * asserting a result nobody gave it, which is the conflation the five kinds exist to
 * prevent. A refused continuation lands on the same arm as an unfollowed cursor, and the
 * daemon's own sentence is rendered once, beside the control that retries it.
 *
 * On a SURFACE rather than at `not-checked`'s ordinary inline mount: this stands in for
 * the list, and the badge form carries its second line only as a tooltip — which is where
 * the whole of the reason lives.
 */
function renderNoDefinitions(continuation: WorkflowDefinitionContinuation): React.ReactNode {
  if (continuation.status === "reading") {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading the next page of workflow definitions."
      />
    );
  }
  if (continuation.status !== "exhausted") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No workflow definitions in the pages read so far."
        detail="The enumeration has more pages and the console has not read them. Reading on may reach definitions this session can start."
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      title="This session resolves no workflow definitions."
      detail="Definitions are authored in the workflows destination; one saved there becomes startable here."
    />
  );
}

/**
 * What lies past the pages on screen, and the one control that asks for it.
 *
 * ONE CONTROL ACROSS THREE ARMS rather than a control on one of them and nothing on the
 * rest. `exhausted` has nothing to ask for and renders nothing, which is the
 * absent-not-disabled rule. The other three are the same ask in three conditions — it
 * may be made, it has been made and is running, it was refused and may be made again —
 * and a surface that dropped the control on two of them left a person with no way to
 * reach the rest of the enumeration and nothing on screen saying why.
 *
 * THE REFUSAL IS INLINE AND CARRIES THE CONTROL AS ITS NEXT MOVE, which is what the
 * inline shape is for: nothing changed, the rows already served are still true, and the
 * act can be tried again. The label does not change with the arm — it is the same ask,
 * and a control that renamed itself after a refusal would read as a second thing to
 * press.
 *
 * A function rather than a component, on `renderAct`'s own precedent: it is one of this
 * menu's regions and not a body with a life of its own.
 */
function renderContinuation(
  continuation: WorkflowDefinitionContinuation,
  continueReading: () => void,
): React.ReactNode {
  if (continuation.status === "exhausted") {
    return null;
  }
  const more = (
    <button
      type="button"
      className="meridian-workflow-start-menu__more"
      // Closed only while the page it asked for is in flight: the hook refuses a second
      // request for a page already running, so an open control there would be a press
      // that went nowhere.
      disabled={continuation.status === "reading"}
      onClick={continueReading}
    >
      Show more definitions
    </button>
  );
  if (continuation.status === "unavailable") {
    return (
      <InlineRefusal
        code={continuation.refusal.code}
        detail={continuation.refusal.detail}
        action={more}
      />
    );
  }
  return more;
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
    // A sentence rather than the reading notice this arm used to mount. That notice is
    // rule 8's `not-loaded` absence, whose whole point is that it says nothing and is
    // replaced a beat later — correct for a read in flight beside rows that are still
    // offered, and wrong here, because the rows are now CLOSED and a closed control with
    // no stated cause is a control that looks broken. `role="status"` so the reason is
    // spoken when it appears: the disabled buttons carry no focus, so a description
    // hung on them would reach nobody.
    return (
      <p className="meridian-workflow-start-menu__flight" role="status">
        {`Starting ${act.definitionName}. This menu starts one workflow at a time, so the rest wait for the daemon's answer.`}
      </p>
    );
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
