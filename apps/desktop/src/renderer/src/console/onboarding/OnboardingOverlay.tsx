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
// NON-DISMISSIBLE, BUT ONLY WHERE THAT IS TRUE. The corpus makes the walkthrough
// non-dismissible until a choice is made or the triggering invite is cancelled — and
// that holds only once the daemon has ANSWERED that the relay step is unresolved. A
// build whose onboarding wire is unregistered refuses the read, and locking a person
// inside a dialog on the strength of a read that failed would be a trap built out of
// an absence. So the lock is applied on the answered arm and on no other.
//
// AND ONLY OVER THE ACTIVATION THAT ASKED FOR GROUP A. The other half of "where that
// is true" is WHICH opening is on screen: the two group-B openings are offered and
// never demanded, and one of them is raised after a run has already been refused. A
// lock keyed on the relay reading alone held those too, so a person who asked to look
// at provider readiness on a node with no relay configured could not close the dialog
// until they had configured one — a mandatory setup flow assembled out of a rule
// written for a different flow.
//
// THE MODELS ARE PER BRIDGE AND SUPERSEDED, held through the console's one
// subject-scoped holder. A replacement bridge retires both — their unsettled calls
// would answer over a transport that no longer exists — and unmount retires them too,
// because the main-process dialogs outlive this window's interest. Holding them in a
// `useState` cell beside a remembered bridge would be a second copy of that
// substrate, and it would miss what the substrate was written for: a render React
// discards still builds a pair, and nothing would ever retire it.

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { consoleCommands, registerConsoleCommands } from "../palette/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../store/index.js";
import {
  activationRequiresRelayChoice,
  onboardingActivation,
  type OnboardingActivation,
} from "./onboarding-activation.js";
import { OnboardingFlow } from "./onboarding-flow.js";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough.js";
import { ProviderReadinessModel } from "./provider-readiness/provider-readiness.js";
import { firstUnresolvedStep, type OnboardingStepId } from "./steps/step-model.js";

/** The command ids this family owns. Namespaced by family, per the command rules. */
const OPEN_COMMAND_ID = "onboarding.open";
const PROVIDERS_COMMAND_ID = "onboarding.setUpProviders";

/**
 * What _Set up providers_ opens at. A constant: that command names its own step.
 *
 * The collaboration command has no constant, because where it opens depends on where
 * this node already is — a resumed walkthrough opens at the first step nothing says is
 * done, which is a reading rather than a decision this file can make in advance.
 */
const PROVIDERS_ACTIVATION: OnboardingActivation = {
  openAtStep: "providers",
  accountScope: undefined,
};

/** The completed set a walkthrough resumes from before its first read answers. */
const NO_STEPS_DONE: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>();

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
  const { value: models } = useSubjectScopedResource(
    bridge,
    undefined,
    () => buildModels(bridge),
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
          // Where it opens is read at PRESS time, not at registration: a walkthrough
          // resumes at the first step nothing says is done, and what is done can have
          // changed since this command was contributed.
          const { reading } = models.flow.snapshot;
          const completed = reading.kind === "read" ? reading.completed : NO_STEPS_DONE;
          open({
            openAtStep: firstUnresolvedStep(completed) ?? "relay",
            accountScope: undefined,
          });
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

  // The one condition the corpus locks on — read off the answered arm alone, and
  // asked only of an activation that opens group A.
  const isLocked =
    activation !== undefined &&
    activationRequiresRelayChoice(activation) &&
    snapshot.reading.kind === "read" &&
    !snapshot.reading.completed.has("relay");

  return (
    <Dialog.Root
      open={activation !== undefined}
      disablePointerDismissal={isLocked}
      onOpenChange={(nextOpen) => {
        if (nextOpen || isLocked) {
          return;
        }
        setActivation(undefined);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="meridian-onboarding__backdrop" />
        <Dialog.Popup className="meridian-onboarding__popup">
          <Dialog.Title className="meridian-onboarding__heading">Set up this node</Dialog.Title>
          {activation === undefined ? null : (
            <OnboardingWalkthrough
              key={activationSequence}
              flow={models.flow}
              readiness={models.readiness}
              openAtStep={activation.openAtStep}
              accountScope={activation.accountScope}
              onOpenAccountRegistry={() => {
                // The registry's own page owns registration and defaults; this step
                // is a view. Closing first, because leaving the walkthrough open over
                // a rail move would put two surfaces on screen for one act — and
                // landing on the SECTION, because the control names it.
                setActivation(undefined);
                frameStore.navigate({ kind: "settings", page: ACCOUNT_REGISTRY_SECTION });
              }}
            />
          )}
          <Dialog.Close
            className="meridian-onboarding__act meridian-onboarding__act--secondary"
            disabled={isLocked}
          >
            {isLocked ? "Choose a relay to continue" : "Close"}
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function buildModels(bridge: ConsoleSurfaceContext["bridge"]): OnboardingModels {
  return { flow: new OnboardingFlow(bridge), readiness: new ProviderReadinessModel(bridge) };
}
