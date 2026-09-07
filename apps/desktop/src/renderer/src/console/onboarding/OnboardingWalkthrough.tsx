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
// AND BOTH GO THROUGH THE WINDOW TRIGGER SET, which is the console's one home for
// when a reading re-reads. Both models are NODE-scoped — where this node is, and
// which providers this node can run — so the pair they take is the window's: the
// arrival, and the window regaining focus. Neither holds a session, so no session's
// repair and no session's timeline bear on either. This file used to call the two
// arrival reads itself, which left both readings current at mount and stale from the
// first time somebody came back to the window, with nothing on screen saying so.
//
// AND NOTHING RE-READS ON A TIMER. Every other read is the tail of an act somebody
// performed: a step recorded, a choice made, a sign-in handed off, a re-check asked
// for.
//
// STEP ORDERING IS THE STEP MODEL'S AND IS ASKED FOR ONCE. `stepBlockedReason` is
// what says a step may not be opened yet; the rail asks it per entry and this file
// asks it for the step that is open, so the entry a person cannot press and the
// control they would have found behind it are the same refusal rather than two.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { RefusalCard } from "../primitives/index.js";
import { useWindowReadTriggers } from "../store/index.js";
import { CompletionSummary } from "./CompletionSummary.js";
import type { OnboardingFlow, OnboardingSnapshot } from "./onboarding-flow.js";
import { ProviderReadinessStep } from "./provider-readiness/ProviderReadinessStep.js";
import type {
  ProviderReadinessModel,
  ProviderReadinessReading,
} from "./provider-readiness/provider-readiness.js";
import { RelayChoiceStep } from "./relay/RelayChoiceStep.js";
import { StepRail } from "./steps/StepRail.js";
import { ONBOARDING_STEPS, stepBlockedReason, type OnboardingStepId } from "./steps/step-model.js";
import { TelemetryStep } from "./steps/TelemetryStep.js";

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
  // ADDRESSED BEFORE THE TRIGGERS OPEN, and the ordering is why this effect is
  // declared above them rather than beside the props it reads. `useWindowReadTriggers`
  // asks for the arrival read from an effect of its own, React runs a component's
  // effects in the order its hooks were called, and a readiness model still holding
  // the previous activation's scope would answer about a different account than the
  // one this activation was raised over. Addressing is not a read: the scope arrives
  // through one verb and every read leaves through the routed entry.
  useEffect(() => {
    readiness.addressAt(accountScope);
  }, [readiness, accountScope]);
  // THE TWO REASONS A NODE-SCOPED READING RE-READS, wired through the one home for
  // them. Nothing here performs a read; a reading that wired its own arrival by hand
  // is the reading that never hears about the second one.
  useWindowReadTriggers(flow);
  useWindowReadTriggers(readiness);

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
          // The open step's own hold, composed once here from the same completed set
          // the rail reads. The rail keeps a held step from being opened; this is
          // what an activation that opened AT one renders, and neither is the other's
          // fallback — both ask the step model.
          blockedReason: stepBlockedReason(chosenStepId, completed),
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
  /** Why the OPEN step is held, or `undefined` when nothing holds it. */
  readonly blockedReason: string | undefined;
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
  const { flow, readiness } = props;
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
          blockedReason={state.blockedReason}
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
            void readiness.handOffSignIn(providerName);
          }}
          onRecheck={(providerName, accountId) => {
            void readiness.recheck(providerName, accountId);
          }}
          onOpenAccountRegistry={props.onOpenAccountRegistry}
          // From the rail's model rather than from this arm: `Spec-026` makes exactly
          // one step skippable, `step-model.ts` records which, and a handler written
          // unconditionally here would be a second answer to that question living
          // beside the first.
          onSkip={
            ONBOARDING_STEPS[stepId].isSkippable
              ? () => {
                  void flow.skip(stepId);
                }
              : undefined
          }
        />
      );
  }
}
