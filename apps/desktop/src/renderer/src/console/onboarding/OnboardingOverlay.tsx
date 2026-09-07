// Where the walkthrough is reached from, and when it may be closed.
//
// A WINDOW-SCOPED OVERLAY RATHER THAN A RAIL DESTINATION. `Spec-026 §Trigger` forbids
// this flow on install, first launch, health check, or first session creation, and
// names its openings instead: an outbound invite, or an explicit activation. A rail
// entry would be a place a person goes; this is a moment they are put in, so it sits
// beside the command palette in the frame's overlay slot.
//
// THREE OPENINGS AND NO OTHERS. Two are commands a person runs — the collaboration
// entry point that pre-stages the relay choice, and the _Set up providers_ entry
// point Group B names — and the third is `onboarding-activation.ts`, which a surface
// meeting an account-plane refusal raises AFTER that refusal has already happened.
// None of them is a check placed ahead of work.
//
// NON-DISMISSIBLE UNTIL AN ANSWER SAYS OTHERWISE, WHICH IS FAIL-CLOSED. `Spec-026
// §Desktop Surface` makes the walkthrough non-dismissible "until a choice is made", and
// a choice being made is a POSITIVE fact: only a served state read carrying `relay` in
// its completed set establishes it. So the lock lifts on that reading and on no other
// — a read still in flight and a read the daemon refused both leave the choice
// unestablished, and unlocking there would open the dialog on the strength of a state
// nothing said. This once read the other way round, locking only on the answered-and-
// unresolved arm, which meant the walkthrough opened by the collaboration command was
// closeable during the first frame of every mount and for the whole life of a build
// whose onboarding wire is unregistered.
//
// AND THE UNANSWERED ARM SAYS SO RATHER THAN ASKING FOR A CHOICE. The two lock reasons
// are different facts and the control names which one it is on: an unresolved choice
// asks for a choice, and an unanswered reading says the node has not answered. One
// label for both would tell a person to choose their way out of a dialog that will not
// open until a read succeeds. The way out of the unanswered arm is the answer arriving
// — this reading re-reads on the window's own trigger set — and never a guess made here.
//
// AND ONLY OVER THE ACTIVATION THAT ASKED FOR GROUP A. The other half of "where that
// is true" is WHICH opening is on screen: the two group-B openings are offered and
// never demanded, and one of them is raised after a run has already been refused. A
// lock keyed on the relay reading alone held those too, so a person who asked to look
// at provider readiness on a node with no relay configured could not close the dialog
// until they had configured one — a mandatory setup flow assembled out of a rule
// written for a different flow.
//
// AND IT RESOLVES NO OPENING OF ITS OWN. The collaboration command raises a `resume`
// activation and the walkthrough resolves it; this file decides nothing about where a
// walkthrough starts beyond which of the three openings was asked for. It used to pick
// the step at press time from the flow's snapshot, and the flow's window triggers
// mount inside the walkthrough — so before the first activation that snapshot was the
// opening zero value and every press opened at `relay`, on a node that may have
// settled two steps already.
//
// AND IT TELLS THE FRAME IT IS UP. `modal="trap-focus"` is what `Spec-023 §Console
// Libraries` adopts — the default mode locks body scroll, which that row forbids — and
// it leaves inerting the app root to the shell, which cannot see a view family's
// dialog. So this publishes into the window store through the same hook the sign-in
// card takes, and the frame folds the two.
//
// THE MODELS ARE PER BRIDGE AND SUPERSEDED, held through the console's one
// subject-scoped holder. A replacement bridge retires both — their unsettled calls
// would answer over a transport that no longer exists — and unmount retires them too,
// because the main-process dialogs outlive this window's interest. Holding them in a
// `useState` cell beside a remembered bridge would be a second copy of that
// substrate, and it would miss what the substrate was written for: a render React
// discards still builds a pair, and nothing would ever retire it.
//
// AND THE READINESS SCOPE IS INSTALLED WHERE AN ACTIVATION IS ACCEPTED. Every one of
// the three openings arrives through one function here, so this is the only place a
// scope is known BEFORE any state moves — and installing it from the walkthrough's own
// effect instead left one committed frame rendering the previous account's readiness
// under the new account's activation, with its provider actions wired to that stale
// snapshot. An effect cannot run before the commit that schedules it, so the install
// moved to the act rather than to a lifecycle hook. The second install site is the
// model FACTORY, for the one case an act cannot cover: a replacement bridge mints a
// fresh pair under an activation already on screen, and a pair born at the provider
// default would silently widen the scope of the account the person is looking at.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { consoleCommands, registerConsoleCommands } from "../palette/index.js";
import { OverlayDialogPopup } from "../primitives/index.js";
import { settingsRoute } from "../routing/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import {
  useModalSurfaceLifetime,
  useSubjectScopedResource,
  type SubjectScopedDisposal,
} from "../store/index.js";
import {
  activationRequiresRelayChoice,
  onboardingActivation,
  type OnboardingActivation,
} from "./onboarding-activation.js";
import { OnboardingFlow, type OnboardingReading } from "./onboarding-flow.js";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough.js";
import { ProviderReadinessModel } from "./provider-readiness/provider-readiness.js";
import { RESUME_OPENING } from "./steps/step-model.js";

/** The command ids this family owns. Namespaced by family, per the command rules. */
const OPEN_COMMAND_ID = "onboarding.open";
const PROVIDERS_COMMAND_ID = "onboarding.setUpProviders";

/**
 * What _Set up providers_ opens at. A constant: that command names its own step.
 *
 * The collaboration command raises `RESUME_OPENING` instead, because where it opens
 * depends on where this node already is — a reading rather than a decision this file
 * can make in advance, and one the walkthrough performs.
 */
const PROVIDERS_ACTIVATION: OnboardingActivation = {
  openAtStep: "providers",
  accountScope: undefined,
};

/**
 * The settings section the provider-account registry is registered under.
 *
 * NAMED HERE RATHER THAN IMPORTED, and the reason is the DAG: `settings/` and this
 * family are sibling VIEW families, and one never imports another
 * (`console-view-family-isolation`), so `SETTINGS_SECTION_IDS` cannot be reached from
 * this side. The route is what the two share — `routing/routes.ts` parses and formats
 * `#/settings/<page>` and takes the section as its `page` — so the value travels as a
 * route rather than as a hand-built address.
 *
 * A SECTION THIS BUILD NAMED WRONG WOULD REPORT ITSELF: an unrecognised page reaches
 * the settings surface's own not-found absence, which prints the id it was handed.
 * `page: undefined` — which this once navigated to — reaches the rail's "Choose a
 * section" instead, so a step that promised the registry landed a person somewhere
 * they still had to go looking, and nothing anywhere said so.
 */
const ACCOUNT_REGISTRY_SECTION = "accounts";

/**
 * Why a group-A activation may not be closed. Two facts, and never one.
 *
 * `unresolved` is the daemon answering that the relay step is not done, and
 * `unanswered` is the daemon not having answered at all — a read still in flight, or
 * one it refused. Both hold the dialog, because `Spec-026 §Desktop Surface` lifts the
 * lock on a choice being MADE and neither of these establishes one; they are two arms
 * rather than a boolean because only the first is something a person can act on.
 */
type RelayLockReason = "unresolved" | "unanswered";

/** What the close control says under each lock. A total record over the two arms. */
const RELAY_LOCK_LABELS: Readonly<Record<RelayLockReason, string>> = {
  unresolved: "Choose a relay to continue",
  unanswered: "Waiting for this node to answer",
};

/**
 * Whether this reading lets a group-A activation close, and why it does not.
 *
 * FAIL-CLOSED ON EVERY ARM BUT ONE. Only a served reading carrying `relay` among the
 * completed steps is the corpus's "a choice is made"; the in-flight arm has not asked
 * yet and the refused arm asked and was told nothing, so neither may open a dialog the
 * spec holds shut. Reading the reading here rather than at the call site keeps the
 * three arms in one place, where the day a fourth lands is a compile error.
 */
function relayLockFor(reading: OnboardingReading): RelayLockReason | undefined {
  switch (reading.kind) {
    case "read":
      return reading.completed.has("relay") ? undefined : "unresolved";
    case "reading":
    case "unreadable":
      return "unanswered";
  }
}

/** What one window holds for this walkthrough, rebuilt only when the bridge moves. */
interface OnboardingModels {
  readonly flow: OnboardingFlow;
  readonly readiness: ProviderReadinessModel;
}

/**
 * How a retired pair ends: both superseded, and both working objects afterwards.
 *
 * A RELEASE rather than a terminal disposal — superseding advances a generation and
 * closes nothing, so there is no corpse a second mount could be handed. Declared at
 * module level so its identity is stable across renders.
 */
const ONBOARDING_MODELS_DISPOSAL: SubjectScopedDisposal<OnboardingModels> = {
  release: (retired) => {
    retired.flow.supersede();
    retired.readiness.supersede();
  },
};

export interface OnboardingOverlayProps {
  readonly context: ConsoleSurfaceContext;
}

export function OnboardingOverlay(props: OnboardingOverlayProps): React.JSX.Element {
  const { bridge, frameStore } = props.context;
  const [activation, setActivation] = useState<OnboardingActivation | undefined>(undefined);
  // Bumped on every activation so the walkthrough REMOUNTS: the step it opens at is
  // that activation's, and a component holding a chosen step from the previous one
  // would ignore where this activation asked to start.
  const [activationSequence, setActivationSequence] = useState(0);
  // One pair per bridge, opened during the render that first sees a bridge and
  // retired however that render ended. There is no second axis to key on — a window
  // has one walkthrough — so the key is `undefined`.
  //
  // The builder is handed the LIVE activation's scope rather than nothing, because a
  // bridge that moves under an open activation mints this pair afresh: born at the
  // provider default it would answer about a different account from the one on
  // screen, and no act runs at that moment to correct it.
  const { value: models } = useSubjectScopedResource(
    bridge,
    undefined,
    () => buildModels(bridge, frameStore, activation?.accountScope),
    ONBOARDING_MODELS_DISPOSAL,
  );

  const subscribe = useCallback(
    (listener: () => void) => models.flow.subscribe(listener),
    [models],
  );
  const readSnapshot = useCallback(() => models.flow.snapshot, [models]);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot);

  useEffect(() => {
    const open = (next: OnboardingActivation): void => {
      // BEFORE THE ACTIVATION MOVES, AND NOT FROM AN EFFECT BELOW IT. Addressing
      // retires what the previous account put on screen and returns the reading to its
      // zero state, so a walkthrough rendered for this activation reads THIS account
      // from its first committed frame — never the previous one's entries with the
      // previous one's per-provider acts still pressable beside them. Re-addressing at
      // a scope this model already holds costs nothing: the model answers that itself.
      models.readiness.addressAt(next.accountScope);
      setActivation(next);
      setActivationSequence((sequence) => sequence + 1);
    };
    const stopListening = onboardingActivation.subscribe(open);
    registerConsoleCommands([
      {
        id: OPEN_COMMAND_ID,
        title: "Set up collaboration",
        group: "Setup",
        keywords: ["onboarding", "relay", "first run", "telemetry"],
        run: () => {
          // The INTENT, and not a step resolved from whatever this window had read by
          // the time somebody pressed. A walkthrough resumes at the first step nothing
          // says is done, and what is done is the daemon's answer — which this command
          // may fire before: the flow's window triggers mount inside the walkthrough,
          // so before the first activation the snapshot carries the opening zero value
          // and every press resolved to `relay`, on a node that may have settled two
          // steps already. `useOpeningStep` resolves this against the read the
          // walkthrough performs, under that read's own generation.
          open({ openAtStep: RESUME_OPENING, accountScope: undefined });
        },
      },
      {
        id: PROVIDERS_COMMAND_ID,
        title: "Set up providers",
        group: "Setup",
        keywords: ["onboarding", "provider", "account", "sign in", "readiness"],
        run: () => {
          open(PROVIDERS_ACTIVATION);
        },
      },
    ]);
    return () => {
      stopListening();
      consoleCommands.unregister(OPEN_COMMAND_ID);
      consoleCommands.unregister(PROVIDERS_COMMAND_ID);
    };
  }, [models]);

  // The one condition the corpus locks on — fail-closed on the reading, and asked only
  // of an activation that opens group A.
  const lockReason =
    activation !== undefined && activationRequiresRelayChoice(activation)
      ? relayLockFor(snapshot.reading)
      : undefined;
  const isLocked = lockReason !== undefined;
  const isOpen = activation !== undefined;

  // The window's background is inert for exactly this dialog's lifetime. Under
  // `modal="trap-focus"` Base UI marks `.meridian-frame` `aria-hidden` and leaves the
  // structural half to the shell, so without this publish the rail and the whole route
  // surface stayed reachable behind an open walkthrough. Through the store family's
  // own hook, which the sign-in card takes too.
  useModalSurfaceLifetime(frameStore, isOpen);

  return (
    <Dialog.Root
      open={isOpen}
      // `Spec-023 §Console Libraries` adopts this family under `trap-focus` and no
      // other mode: the default `modal` also locks body scroll, which that row
      // forbids, and inerting the app root is the shell's job rather than the
      // library's. Held for every console dialog by
      // `test/console/architecture/dialog-modal-mode.test.ts`.
      modal="trap-focus"
      disablePointerDismissal={isLocked}
      onOpenChange={(nextOpen) => {
        if (nextOpen || isLocked) {
          return;
        }
        setActivation(undefined);
      }}
    >
      {/* THE PORTAL, BACKDROP, AND POPUP ARE THE PRIMITIVE'S, and the whole of this
          surface's part in it is what it puts inside (`Spec-023 §Console Design
          (Meridian)` 12.3, §4.3). A dialog mounted by hand here reached the window's
          airspace through nothing, so a native browser-pane view went on painting over
          this walkthrough and taking its input — including the backdrop press. No
          `label`: the title below is what names this dialog, and Base UI hands the
          popup that title's id. */}
      <OverlayDialogPopup
        backdropClassName="meridian-onboarding__backdrop"
        className="meridian-onboarding__popup"
      >
        <Dialog.Title className="meridian-onboarding__heading">Set up this node</Dialog.Title>
        {activation === undefined ? null : (
          <OnboardingWalkthrough
            key={activationSequence}
            flow={models.flow}
            readiness={models.readiness}
            openAtStep={activation.openAtStep}
            onOpenAccountRegistry={(providerName) => {
              // The registry's own page owns registration and defaults; this step
              // is a view. Closing first, because leaving the walkthrough open over
              // a rail move would put two surfaces on screen for one act — and
              // landing on the SECTION, because the control names it.
              //
              // The PROVIDER rides the address rather than any state this file keeps:
              // a row's action names one and the step's own button names none, and
              // the page reads it off the route it was opened on. Composed through
              // the routing family's constructor, which is the one place the
              // omit-versus-set-to-`undefined` rule that keeps the address
              // round-tripping is decided.
              setActivation(undefined);
              frameStore.navigate(settingsRoute(ACCOUNT_REGISTRY_SECTION, providerName));
            }}
            // The way out the provider step's **Not now** puts this away into, and
            // `undefined` where this dialog refuses to close at all. One condition,
            // read once: the lock the dismissal path already answers to.
            onDismiss={
              isLocked
                ? undefined
                : () => {
                    setActivation(undefined);
                  }
            }
          />
        )}
        <Dialog.Close
          className="meridian-onboarding__act meridian-onboarding__act--secondary"
          disabled={isLocked}
        >
          {lockReason === undefined ? "Close" : RELAY_LOCK_LABELS[lockReason]}
        </Dialog.Close>
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}

/**
 * The pair one window holds. The store travels because the readiness model needs it.
 *
 * `Spec-023 §Daemon Supervision Lifecycle` step 3 blocks mutating operations while the
 * supervisor is not serving, and the provider step's re-check dispatches one — so that
 * model reads the shell state this store publishes and refuses the probe itself. The
 * store is the window's, not this overlay's, so it is handed over rather than built.
 *
 * A FRESH PAIR IS ADDRESSED BEFORE IT IS HANDED OVER. The scope is a property of the
 * activation on screen, and a pair minted mid-activation — which is what a bridge swap
 * does — would otherwise read the provider default for an account the person was
 * already looking at. Addressing here is not a read: `addressAt` publishes the zero
 * state and puts nothing on the wire, and the trigger set the walkthrough opens is
 * what asks.
 */
function buildModels(
  bridge: ConsoleSurfaceContext["bridge"],
  frameStore: ConsoleSurfaceContext["frameStore"],
  accountScope: ProviderAccountId | undefined,
): OnboardingModels {
  const readiness = new ProviderReadinessModel(bridge, frameStore);
  readiness.addressAt(accountScope);
  return { flow: new OnboardingFlow(bridge), readiness };
}
