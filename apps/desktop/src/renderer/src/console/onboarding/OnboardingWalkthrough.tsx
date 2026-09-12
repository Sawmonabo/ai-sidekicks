// The walkthrough: a rail of steps, one step open, and a footer that can finish.
//
// THE SHAPE IS FIXED: a left-rail progress list with a right pane carrying copy and
// inputs and one explicit primary action per step, so that is what this composes and
// nothing more.
//
// THE FINISH ACTION IS ALWAYS REACHABLE, and that is the "offered, never demanded"
// rule expressed as layout rather than as a sentence. Completing with no provider
// ready is a legitimate terminal, so the summary and its action sit in a footer that
// is present on every step instead of behind a step a person has to reach.
//
// REACHABLE IS NOT THE SAME AS PRESSABLE, THOUGH. Group B is what "never demanded"
// is about; group A is demanded, and a footer on every step was the one control that
// could dispatch `onboarding.complete` from a step nobody had answered. So the act is
// held until both group-A answers are recorded — composed by `completionStanding`
// from the same completed set the rail reads, and withdrawn rather than merely
// disabled, on the telemetry step's precedent.
//
// AND IT RETIRES ON THE READ RATHER THAN ON ITS OWN REPLY. The same `completionStanding`
// answers the other end: once the daemon's state read says this node IS set up, the
// footer renders a terminal and offers no act at all. It used to clear only an
// in-flight flag, so a finished walkthrough sat there with a live "Finish setting up"
// button and a second press dispatched `onboarding.complete` again. What retires it is
// the authoritative reading and never the mutation's own settlement — the mutation
// answering is the daemon accepting the act, and the read is what says the node moved.
//
// WHERE IT OPENS IS THE ACTIVATION'S, AND `resume` IS ONE OF THE ANSWERS. Two openings
// name a step and the third means "wherever this node got to", which cannot be resolved
// until the read answers — so `useOpeningStep` resolves it here, once, against the
// reading this component already holds.
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
// performed: a step recorded, a choice made, a re-check asked for.
//
// AND THE READINESS SCOPE IS INSTALLED BEFORE THIS COMPONENT EXISTS, which is why no
// prop here names one. Addressing from a passive effect put the install one COMMITTED
// FRAME after the activation that raised it: a reopening at a different account
// rendered — and wired its provider actions against — the previous account's snapshot,
// and an interaction reaching that frame acted on the wrong credential home. An effect
// cannot be moved earlier than the commit it follows, so the address moved to the
// moment the activation is ACCEPTED, in `OnboardingOverlay.tsx`, where the scope is
// known before any state moves. What is left here is a model already addressed, which
// is the only shape that has no stale frame at all.
//
// AND THE READINESS SUBSCRIPTION TAKES THAT MODEL'S SNAPSHOT AND NOT ITS PROJECTION.
// A per-provider act moves without the projection moving, so subscribing to the
// reading alone handed `useSyncExternalStore` a value that had not re-identified and
// React rendered nothing: the row's buttons stayed enabled and its refusal stayed off
// screen until an unrelated read replaced the reading object.
//
// STEP ORDERING IS THE STEP MODEL'S AND IS ASKED FOR ONCE. `stepBlockedReason` is
// what says a step may not be opened yet; the rail asks it per entry and this file
// asks it for the step that is open, so the entry a person cannot press and the
// control they would have found behind it are the same refusal rather than two.

import { useCallback, useState, useSyncExternalStore } from "react";

import type { TransportReconnectObservable } from "../core/index.js";
import { RefusalCard } from "../primitives/index.js";
import { useWindowReadTriggers, type ShellMutationBlock } from "../store/index.js";
import { CompletionSummary } from "./CompletionSummary.js";
import type { OnboardingFlow, OnboardingSnapshot } from "./onboarding-flow.js";
import { ProviderReadinessStep } from "./provider-readiness/ProviderReadinessStep.js";
import type { ProviderReadinessModel } from "./provider-readiness/provider-readiness.js";
import type { ProviderReadinessReading } from "./provider-readiness/provider-readiness-reading.js";
import { RelayChoiceStep } from "./relay/RelayChoiceStep.js";
import { useOpeningStep } from "./steps/opening-step.js";
import { StepRail } from "./steps/StepRail.js";
import {
  completionStanding,
  ONBOARDING_STEPS,
  stepBlockedReason,
  type OnboardingOpening,
  type OnboardingStepId,
} from "./steps/step-model.js";
import { TelemetryStep } from "./steps/TelemetryStep.js";

export interface OnboardingWalkthroughProps {
  readonly flow: OnboardingFlow;
  /**
   * The readiness reading, ALREADY ADDRESSED at this activation's account scope.
   *
   * A precondition of the prop and not a step this component performs — see the
   * header. There is deliberately no `accountScope` beside it: a component holding a
   * scope it does not install is a second record of where this model points, and the
   * frame in which the two disagree is exactly the defect that moved the install.
   */
  readonly readiness: ProviderReadinessModel;
  /** Which step this activation opens at, or `resume` for wherever this node got to. */
  readonly openAtStep: OnboardingOpening;
  /**
   * This window's transport-reconnect signal, for the two readings below.
   *
   * A prop because it is the BRIDGE's and this component holds models rather than a
   * bridge — the same reason the models themselves arrive built. Both readings here are
   * node-scoped, so reconnect is the one edge that says their answer may have moved,
   * and `store/read/read-triggers.ts` takes it as a required argument for that reason.
   */
  readonly transportReconnect: TransportReconnectObservable;
  /** Open the account registry, scoped to a provider where a row named one. */
  readonly onOpenAccountRegistry: (providerName: string | undefined) => void;
  /**
   * Put this activation away, where the surface holding it admits being closed.
   *
   * `undefined` while it does not — the overlay's own lock is the one place that is
   * decided — and the provider step's **Not now** is offered only where a way out
   * exists. A control offered over a dialog that refuses to close is a control that
   * does nothing when pressed.
   */
  readonly onDismiss: (() => void) | undefined;
}

export function OnboardingWalkthrough(props: OnboardingWalkthroughProps): React.JSX.Element {
  const { flow, readiness } = props;
  const [isFinishing, setIsFinishing] = useState(false);

  const subscribeToFlow = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const readFlow = useCallback(() => flow.snapshot, [flow]);
  const snapshot = useSyncExternalStore(subscribeToFlow, readFlow);
  const subscribeToReadiness = useCallback(
    (listener: () => void) => readiness.subscribe(listener),
    [readiness],
  );
  const readReadiness = useCallback(() => readiness.snapshot, [readiness]);
  const readinessSnapshot = useSyncExternalStore(subscribeToReadiness, readReadiness);

  // THE TWO REASONS A NODE-SCOPED READING RE-READS, wired through the one home for
  // them. Nothing here performs a read; a reading that wired its own arrival by hand
  // is the reading that never hears about the second one.
  useWindowReadTriggers(flow, props.transportReconnect);
  useWindowReadTriggers(readiness, props.transportReconnect);

  const { completedSteps, reading } = snapshot;
  // Where the pane opens, and the one cell a rail press moves. A `resume` opening is
  // resolved against the completed set below and settled on the first answered read;
  // a named one is that step from the first frame.
  const { openStepId, chooseStep } = useOpeningStep(
    props.openAtStep,
    completedSteps,
    reading.kind === "read",
  );

  return (
    <div className="meridian-onboarding">
      <StepRail completed={completedSteps} openStepId={openStepId} onOpenStep={chooseStep} />
      <div className="meridian-onboarding__pane">
        <h3 className="meridian-onboarding__title">{ONBOARDING_STEPS[openStepId].label}</h3>
        {reading.kind === "unreadable" ? (
          // Where this node is could not be read. A block above the step rather than
          // a line beside a control, because no control asked — the walkthrough's own
          // arrival did — and the step below still renders whatever it can.
          <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />
        ) : null}
        {renderStep(openStepId, props, {
          snapshot,
          readinessReading: readinessSnapshot.reading,
          // Off the readiness snapshot this component already subscribes to, rather
          // than a second read of the shell state here: the model derives the block
          // through the store's per-method seam and republishes when it moves, so one
          // subscription carries both what the step shows and what it may put.
          recheckBlock: readinessSnapshot.recheckBlock,
          isRelayResolved: completedSteps.has("relay"),
          // The open step's own hold, composed once here from the same completed set
          // the rail reads. The rail keeps a held step from being opened; this is
          // what an activation that opened AT one renders, and neither is the other's
          // fallback — both ask the step model.
          blockedReason: stepBlockedReason(openStepId, completedSteps),
        })}
      </div>
      <footer className="meridian-onboarding__footer">
        <CompletionSummary
          reading={readinessSnapshot.reading}
          // One closed value for all three states, from the step model and the
          // authoritative reading: settled where the daemon says this node is set up,
          // held until both group-A answers are recorded, offered otherwise. An
          // unanswered read reports neither — `isComplete` is a fact this console
          // never assumes.
          standing={completionStanding(
            completedSteps,
            reading.kind === "read" && reading.isComplete,
          )}
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
  /** Why the provider step's re-check is closed, or `undefined` while it is not. */
  readonly recheckBlock: ShellMutationBlock | undefined;
  readonly isRelayResolved: boolean;
  /** Why the OPEN step is held, or `undefined` when nothing holds it. */
  readonly blockedReason: string | undefined;
}

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
          onRecheck={(providerName, accountId) => {
            void readiness.recheck(providerName, accountId);
          }}
          recheckBlock={state.recheckBlock}
          onOpenAccountRegistry={props.onOpenAccountRegistry}
          // A LOCAL EXIT AND NOT A RECORDED SKIP. Exactly one step is leavable,
          // `step-model.ts` records which, and the way out is the overlay's own
          // dismissal — so nothing reaches the daemon, which is what group B persisting
          // nothing means when a person presses it. Both conditions are read rather than
          // restated: a handler written unconditionally here would be a second answer to
          // the first question, and one that closed the dialog regardless would be a
          // second answer to the second.
          onDismiss={ONBOARDING_STEPS[stepId].mayBeLeftUnanswered ? props.onDismiss : undefined}
        />
      );
  }
}
