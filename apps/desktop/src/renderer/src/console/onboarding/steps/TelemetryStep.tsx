// Telemetry: its own step, its own answer, and default off.
//
// A SEPARATE STEP AND NEVER BUNDLED. `Spec-026 §Telemetry Opt-In` requires it be put
// after the relay choice resolves, with an explicit answer and no silent default, and
// `Spec-026 §Pitfalls To Avoid` names bundling it into the choice as a defect. So it
// has its own rail entry, its own action, and its own reading — and the walkthrough
// does not treat a resolved relay choice as an answer to this.
//
// WHAT THIS STEP STATES AND WHAT THE QUESTION STATES. The section fixes four facts
// the consent copy must carry: what is collected, what is not, the retention window,
// and how to change the setting later. Three of them are fixed in the corpus and are
// written here verbatim. The retention window is not: no document in the corpus
// registers a number for it, so this console does not print one. Inventing a window
// would be this renderer asserting a policy the daemon owns — the same fail-closed
// rule that keeps every other daemon-owned fact off these surfaces — and the question
// itself is raised in a window that has the answer.
//
// THE ANSWER IS NOT COLLECTED HERE. `onboarding.telemetryPrompt` is a main-process
// question, so this step offers the act and renders what came back. There is no
// toggle in this file, which is why the default cannot be silently applied by it.
//
// AND THE ACT IS WITHDRAWN RATHER THAN GUARDED while the relay choice is unresolved.
// `blockedReason` is the whole of that fact — one value decides both the disabled
// control and the missing handler, so there is no second condition to keep in step
// with the first, and this file states no ordering rule of its own: the reason
// arrives composed from the step model, which is where the ordering lives.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import type { TelemetryReading } from "../onboarding-flow.js";

/** What telemetry carries, from the section that fixes it. Rendered as a list. */
const COLLECTED: readonly string[] = [
  "Counts of errors by class",
  "Version strings",
  "Which relay option was chosen, without the relay address",
];

/** What it never carries. The same section, and the half people actually ask about. */
const NOT_COLLECTED: readonly string[] = [
  "Anything said or written in a session",
  "File contents",
  "Who the participants are",
  "Relay traffic",
];

/** How to change the answer afterwards, in the words the command takes. */
const CHANGE_LATER_NOTE =
  "This can be changed at any time afterwards with `sidekicks telemetry set on` or `sidekicks telemetry set off`.";

export interface TelemetryStepProps {
  readonly reading: TelemetryReading;
  /**
   * Why the question may not be put yet, or `undefined` when it may.
   *
   * Present, it takes the control away as well as explaining it: the handler is not
   * wired at all, so nothing here can reach the prompt whatever a caller does to the
   * button. `Spec-026 §Telemetry Opt-In` puts this question after the relay choice
   * resolves, and an answer recorded ahead of that choice is that rule broken in the
   * one way nothing could take back — the question has been asked and answered.
   */
  readonly blockedReason: string | undefined;
  readonly onPresentPrompt: () => void;
}

export function TelemetryStep(props: TelemetryStepProps): React.JSX.Element {
  const { blockedReason, reading } = props;
  const isBlocked = blockedReason !== undefined;
  return (
    <section className="meridian-onboarding__step" aria-label="Telemetry">
      <p className="meridian-onboarding__note">
        Telemetry is off unless it is turned on here. There is no default answer, and nothing is
        sent until the question below has one.
      </p>
      <div className="meridian-onboarding__ledger">
        <h4 className="meridian-onboarding__ledger-title">What would be sent</h4>
        <ul className="meridian-onboarding__list">
          {COLLECTED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <h4 className="meridian-onboarding__ledger-title">What would never be sent</h4>
        <ul className="meridian-onboarding__list">
          {NOT_COLLECTED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
        How long anything sent is kept is stated in the question itself, which is raised outside
        this window. {CHANGE_LATER_NOTE}
      </p>
      {renderReading(reading)}
      {blockedReason === undefined ? null : (
        <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
          {blockedReason}
        </p>
      )}
      <button
        type="button"
        className="meridian-onboarding__act"
        onClick={isBlocked ? undefined : props.onPresentPrompt}
        disabled={isBlocked || reading.kind === "asking"}
      >
        {reading.kind === "answered" ? "Answer again" : "Answer the telemetry question"}
      </button>
    </section>
  );
}

function renderReading(reading: TelemetryReading): React.ReactNode {
  switch (reading.kind) {
    case "unasked":
      return (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="The question has not been put yet."
          detail="Telemetry stays off until it has been, and off is what an unanswered question means here."
        />
      );
    case "asking":
      return (
        <Nothing
          kind="computing"
          placement="inline"
          title="Waiting on the telemetry question"
          detail="The question is in front of you in a window this console does not draw."
        />
      );
    case "answered":
      return (
        <p className="meridian-onboarding__note">
          {reading.enabled
            ? "Telemetry is on. It sends the list above and nothing else."
            : "Telemetry is off. Nothing is sent."}
        </p>
      );
    case "refused":
      // Beside the control that asked, in the console's inline refusal shape.
      return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
}
