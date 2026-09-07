// The recovery prompt: the three actions the request admits, each behind a confirm.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "A recovery prompt
// offering `retry`, `interrupt`, and `abandon`. The inspect reply's `escalate`
// suggestion renders as guidance text, never as a fourth button, because the request
// contract admits three actions."
//
// THE CONTROL SET IS THE WIRE VOCABULARY, MAPPED. The buttons are built by walking
// `GROWTH_RECOVERY_ACTIONS`, so a fourth action registered upstream arrives as a
// missing key in the copy table — a compile error — rather than as a wire value with
// no way to send it. Writing three buttons by hand would make that a silent gap.
//
// EVERY OUTCOME COMES FROM THE REPLY. The receipt carries the state the run was in and
// the state it is in now, and the prompt renders that pair. It does not re-read the
// run, does not say "interrupted" because the button said interrupt, and does not
// assume a request that was accepted moved anything: a request whose receipt reports
// the same state twice says so on screen.
//
// AND IT IS ALWAYS AVAILABLE. The section's refusal state requires it: "Refusals:
// rendered on the control that raised them, with the recovery prompt left available."
// So a failed status read, a refused inspection, and an unreadable policy each render
// their own absence and none of them disables these controls — eligibility is the
// daemon's, and the way this surface learns a request is not allowed is by putting it
// and rendering what came back.
//
// AND THE OUTCOME BELONGS TO `(bridge, runId)` RATHER THAN TO THE MOUNT. The read-out
// above keeps this component mounted and moves the run under it whenever a terminal
// event makes a different one the newest live candidate — so a request put for the
// previous run answers into a surface that is now about another. Re-seeding the value
// during the render that re-addresses cleared what was on SCREEN and left the callback
// alone, which is the half that matters: the retired run's receipt still installed, and
// where the live run had its own request out it also cleared that pending arm and
// re-offered three irreversible controls mid-flight.
//
// So the holder decides, exactly as `runs/pane/controls/StepIn.tsx` takes it for the
// same shape one family over: the value is held under `(bridge, runId)` so a re-address
// seeds the new run's own idle state during that render, and the publisher is the
// captured `settle()` so a settlement measured against a retired visit is DROPPED
// rather than rendered. The subject is the pair and not the run alone, because a
// replaced transport retires the request just as surely as a replaced run does — and
// remounting the prompt by run identity would say only the second of those, through a
// second mechanism for a rule this console already has one door for.

import type { ReactNode } from "react";

import { ConfirmationDialog, WireFigure } from "../../../../primitives/index.js";
import { GROWTH_RECOVERY_ACTIONS, type ConsoleBridge } from "../../../../bridge/index.js";
import { useSubjectScopedState } from "../../../../store/index.js";
import { settingsActionClassFor } from "../../../shared/settings-action-class.js";
import { RECOVERY_ACTION_COPY } from "../health-vocabulary.js";
import { RecoveryOutcomeLine } from "./RecoveryOutcomeLine.js";
import {
  IDLE_RECOVERY_OUTCOME,
  requestRecovery,
  type RecoveryOutcome,
} from "./recovery-request.js";

export function RecoveryPrompt(props: {
  readonly bridge: ConsoleBridge;
  readonly runId: string;
}): ReactNode {
  const { bridge, runId } = props;
  const { value: outcome, settle: captureVisit } = useSubjectScopedState<RecoveryOutcome>(
    bridge,
    runId,
    () => IDLE_RECOVERY_OUTCOME,
  );
  const isPending = outcome.kind === "pending";
  return (
    <div className="meridian-recovery-prompt">
      <p className="meridian-recovery-prompt__lede">
        Three ways out, and each asks first. Whether this machine will take one is its decision — a
        request that is not allowed comes back refused rather than being greyed out here.
      </p>
      <div className="meridian-recovery-prompt__actions">
        {GROWTH_RECOVERY_ACTIONS.map((action) => {
          const copy = RECOVERY_ACTION_COPY[action];
          return (
            <ConfirmationDialog
              key={action}
              triggerLabel={copy.label}
              triggerAriaLabel={`${copy.label} this run`}
              triggerClassName={settingsActionClassFor(copy.tone)}
              tone={copy.tone}
              isDisabled={isPending}
              title={copy.confirmTitle}
              description={
                <>
                  {copy.consequence} The run is <WireFigure value={runId} />.
                </>
              }
              keepLabel="Not now"
              confirmLabel={copy.label}
              onConfirm={() => {
                // Captured BEFORE the call rather than after it, so the publisher names
                // the visit that dispatched: a settlement arriving once the run has
                // moved is dropped by the holder instead of being installed as the run
                // now on screen.
                const publishSettlement = captureVisit();
                publishSettlement({ kind: "pending", action });
                void requestRecovery(bridge, runId, action).then(publishSettlement);
              }}
            />
          );
        })}
      </div>
      <RecoveryOutcomeLine outcome={outcome} />
    </div>
  );
}
