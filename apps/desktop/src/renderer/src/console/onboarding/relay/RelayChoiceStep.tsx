// Where this node relays: three options, all visible, and one explicit answer.
//
// THREE, NEVER TWO, AND NEVER A SILENT DEFAULT. `Spec-026 §Three-Way Choice
// Semantics` fixes the set and `Spec-026 §Pitfalls To Avoid` names collapsing the
// third behind an advanced control as a defect. So all three render at once, each
// with what it means for a session's traffic and what it will ask for, and one of
// them is marked as the option the choice opens on — which is a starting position and
// not an answer. Nothing is recorded until a person presses.
//
// THE OPTION LIST IS NOT A CONTROL, and that is the design rather than a shortfall.
// Two of the three need a secret or a browser hand-off, and both belong to the main
// process; a radio group here would collect a choice this window then has to send
// somewhere that asks for it all over again. So the list is what a person reads
// BEFORE the one action, and the action opens the surface that asks.
//
// AND THERE IS NO CANCEL CONTROL, deliberately. The corpus's cancel cancels the
// outbound INVITE that triggered the walkthrough rather than the choice — and no
// invite trigger exists in this build, because the five daemon methods behind it are
// unregistered and the walkthrough is reached by explicit activation alone. A control
// that cancelled "the invite" here would name something that never happened. What the
// non-dismissibility rule leaves is enforced where it belongs, on the container: the
// walkthrough cannot be dismissed while this step is unresolved.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import type { RelayChoiceReading } from "../onboarding-flow.js";
import { RELAY_METHOD_OPTIONS_IN_ORDER } from "./relay-choice.js";
import { RelayConnectionMount } from "./RelayConnectionMount.js";
import { RELAY_CONNECTION_SLOT } from "./RelayConnectionShell.js";

export interface RelayChoiceStepProps {
  readonly reading: RelayChoiceReading;
  /** Whether this step is already recorded as done, so the action reads as a change. */
  readonly isResolved: boolean;
  readonly onPresentChoice: () => void;
}

export function RelayChoiceStep(props: RelayChoiceStepProps): React.JSX.Element {
  const { reading } = props;
  return (
    <section className="meridian-onboarding__step" aria-label="Where this node relays">
      <ol className="meridian-onboarding__options">
        {RELAY_METHOD_OPTIONS_IN_ORDER.map((option) => (
          <li className="meridian-onboarding__option" key={option.id}>
            <h4 className="meridian-onboarding__option-label">
              {option.label}
              {option.isDefault ? (
                <span className="meridian-onboarding__badge">Opens selected</span>
              ) : null}
            </h4>
            <p className="meridian-onboarding__note">{option.consequence}</p>
            <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
              {option.inputs}
            </p>
          </li>
        ))}
      </ol>
      {renderReading(reading)}
      <button
        type="button"
        className="meridian-onboarding__act"
        onClick={props.onPresentChoice}
        disabled={reading.kind === "asking"}
      >
        {props.isResolved ? "Choose a different relay" : "Choose where this node relays"}
      </button>
    </section>
  );
}

/**
 * What the flow currently knows about the choice.
 *
 * Every arm renders, and the two that are not answers say which kind of nothing they
 * are: a question nobody has put yet is _not checked_, and a question that was put
 * and failed is an error carrying what its producer said.
 */
function renderReading(reading: RelayChoiceReading): React.ReactNode {
  switch (reading.kind) {
    case "unasked":
      return (
        <RelayConnectionMount
          {...RELAY_CONNECTION_SLOT}
          methodId={undefined}
          relayUrl={undefined}
          hasCredentialHandle={false}
        />
      );
    case "asking":
      return (
        <Nothing
          kind="computing"
          placement="inline"
          title="Waiting on the choice window"
          detail="The options are in front of you in a window this console does not draw. Nothing is recorded until one is confirmed there."
        />
      );
    case "chosen":
      return (
        <RelayConnectionMount
          {...RELAY_CONNECTION_SLOT}
          methodId={reading.methodId}
          relayUrl={reading.relayUrl}
          hasCredentialHandle={reading.hasCredentialHandle}
        />
      );
    case "unrecognised":
      return (
        <Nothing
          kind="error"
          placement="inline"
          title="An unfamiliar relay was reported"
          detail={`The choice came back as "${reading.reportedId}", which this build does not recognise as one of the three. Nothing was recorded, because recording the nearest match would report a choice nobody made.`}
        />
      );
    case "refused":
      // The console's own inline shape, beside the control that produced it. A
      // `Nothing` carrying the wire code as its TITLE would read as the name of a
      // state a person could act on; a refusal is a refusal and has a shape.
      return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
}
