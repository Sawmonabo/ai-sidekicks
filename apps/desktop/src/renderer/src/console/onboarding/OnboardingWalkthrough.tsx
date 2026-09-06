// The walkthrough: a rail of steps, one step open, and a footer that can finish.
//
// THE SHAPE IS THE CORPUS'S. `Spec-026 §Desktop Surface` fixes it as "a left-rail
// progress list with a right pane carrying copy and inputs and one explicit primary
// action per step", so that is what this composes and nothing more.
//
// THE FINISH ACTION IS ALWAYS REACHABLE, and that is the "offered, never demanded"
// rule expressed as layout rather than as a sentence. Completing with no provider
// ready is a legitimate terminal, so the summary and its action sit in a footer that
// is present on every step instead of behind a step a person has to reach.
//
// TWO READS ON OPEN AND NO MORE. The flow's own state read says where this node is,
// and the readiness read says which providers it can run. The second is issued here
// rather than when the providers step is first opened, because the footer states
// which providers are not ready on every step — and because a readiness read is a
// registry read that spawns no provider process, which is the whole reason the
// contract serves it from the stored observation.
//
// AND NOTHING RE-READS ON A TIMER. Every later read is the tail of an act somebody
// performed: a step recorded, a choice made, a sign-in handed off, a re-check asked
// for.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { RefusalCard } from "../primitives/index.js";
import { CompletionSummary } from "./CompletionSummary.js";
import type { OnboardingFlow, OnboardingSnapshot } from "./onboarding-flow.js";
import { ProviderReadinessStep } from "./ProviderReadinessStep.js";
import type { ProviderReadinessModel, ProviderReadinessReading } from "./provider-readiness.js";
import { RelayChoiceStep } from "./RelayChoiceStep.js";
import { StepRail } from "./StepRail.js";
import { ONBOARDING_STEPS, type OnboardingStepId } from "./step-model.js";
import { TelemetryStep } from "./TelemetryStep.js";

export interface OnboardingWalkthroughProps {
  readonly flow: OnboardingFlow;
  readonly readiness: ProviderReadinessModel;
  /** Which step this activation opens at. */
  readonly openAtStep: OnboardingStepId;
  /** Scopes the readiness read; present only on the post-refusal activation. */
  readonly accountScope: ProviderAccountId | undefined;
  readonly onOpenAccountRegistry: () => void;
}

export function OnboardingWalkthrough(props: OnboardingWalkthroughProps): React.JSX.Element {
  const { flow, readiness } = props;
  const [chosenStepId, setChosenStepId] = useState<OnboardingStepId>(props.openAtStep);
  const [isFinishing, setIsFinishing] = useState(false);

  const subscribeToFlow = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const readFlow = useCallback(() => flow.snapshot, [flow]);
  const snapshot = useSyncExternalStore(subscribeToFlow, readFlow);
  const subscribeToReadiness = useCallback(
    (listener: () => void) => readiness.subscribe(listener),
    [readiness],
  );
  const readReadiness = useCallback(() => readiness.reading, [readiness]);
  const readinessReading = useSyncExternalStore(subscribeToReadiness, readReadiness);

  const { accountScope } = props;
  // THE ARRIVAL, which is one of the four reasons the design rules name. The flow
  // takes it through its scheduler's own entry point rather than by calling the read;
  // the readiness model reads directly, because it is scoped to an account this
  // activation named and a scheduler keyed on nothing could not tell two scopes apart.
  useEffect(() => {
    flow.requestRead("subscribe");
    void readiness.read(accountScope);
  }, [flow, readiness, accountScope]);

  const { reading } = snapshot;
  const completed = reading.kind === "read" ? reading.completed : NO_STEPS_DONE;

  return (
    <div className="meridian-onboarding">
      <StepRail completed={completed} openStepId={chosenStepId} onOpenStep={setChosenStepId} />
      <div className="meridian-onboarding__pane">
        <h3 className="meridian-onboarding__title">{ONBOARDING_STEPS[chosenStepId].label}</h3>
        {reading.kind === "unreadable" ? (
          // Where this node is could not be read. A block above the step rather than
          // a line beside a control, because no control asked — the walkthrough's own
          // arrival did — and the step below still renders whatever it can.
          <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />
        ) : null}
        {renderStep(chosenStepId, props, {
          snapshot,
          readinessReading,
          isRelayResolved: completed.has("relay"),
        })}
      </div>
      <footer className="meridian-onboarding__footer">
        <CompletionSummary
          reading={readinessReading}
          isFinishing={isFinishing}
          onFinish={() => {
            setIsFinishing(true);
            void flow.complete().finally(() => {
              setIsFinishing(false);
            });
          }}
        />
      </footer>
    </div>
  );
}

/** Everything the right pane needs that is not already on the walkthrough's props. */
interface StepRenderState {
  readonly snapshot: OnboardingSnapshot;
  readonly readinessReading: ProviderReadinessReading;
  readonly isRelayResolved: boolean;
}

/**
 * The completed set a walkthrough shows before its first read answers.
 *
 * A module constant rather than a fresh `new Set()` per render: the rail compares
 * membership only, so one empty set serves every render and a new one each time would
 * re-render three rail entries for no change at all.
 */
const NO_STEPS_DONE: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>();

/** One step, and never two. A total switch, so a fourth step is a compile error. */
function renderStep(
  stepId: OnboardingStepId,
  props: OnboardingWalkthroughProps,
  state: StepRenderState,
): React.ReactNode {
  const { flow, readiness, accountScope } = props;
  switch (stepId) {
    case "relay":
      return (
        <RelayChoiceStep
          reading={state.snapshot.relayChoice}
          isResolved={state.isRelayResolved}
          onPresentChoice={() => {
            void flow.presentRelayChoice();
          }}
        />
      );
    case "telemetry":
      return (
        <TelemetryStep
          reading={state.snapshot.telemetry}
          onPresentPrompt={() => {
            void flow.presentTelemetryPrompt();
          }}
        />
      );
    case "providers":
      return (
        <ProviderReadinessStep
          reading={state.readinessReading}
          actionFor={(providerName) => readiness.actionFor(providerName)}
          onSignIn={(providerName) => {
            void readiness.handOffSignIn(providerName, accountScope);
          }}
          onRecheck={(providerName, accountId) => {
            void readiness.recheck(providerName, accountId, accountScope);
          }}
          onOpenAccountRegistry={props.onOpenAccountRegistry}
          onSkip={() => {
            void flow.skip("providers");
          }}
        />
      );
  }
}
