// The recovery prompt: the three actions the request admits, each behind a confirm.
//
// A recovery prompt offering `retry`, `interrupt`, and `abandon`. The inspect reply's
// `escalate` suggestion renders as guidance text, never as a fourth button, because the
// request contract admits three actions.
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
//
// AND A RECEIPT IS THE ONE MOMENT NO REFRESH SIGNAL NAMES. The readings above this
// prompt refresh on focus, on reconnect, and on the three run terminals — and a
// `retry` the node accepted moves a stuck run back to a LIVE state, so it changes no
// subject and sends no terminal. Without this the page held its old `stuck-suspected`
// inspection and every recovery control beside a receipt reporting the run resumed.
// So a receipt is reported upward, and the read-out sends it through its own scheduler
// — never a re-read raised here, which would be a second reader of four wires this
// component does not own.
//
// A RECEIPT AND NOT A REFUSAL. A request the node declined moved nothing, so re-reading
// after one would ask four wires to confirm that nothing happened. A receipt naming the
// same state twice IS reported: the node acted, and what its readings say afterwards is
// the node's to answer rather than this surface's to infer from a state pair.

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

export interface RecoveryPromptProps {
  readonly bridge: ConsoleBridge;
  readonly runId: string;
  /**
   * The node answered a recovery request with a RECEIPT.
   *
   * Raised on that arm alone, and named for what happened rather than for what the
   * caller does with it: whoever owns the readings decides whether that is a re-read
   * and which scheduler it goes through, which is not this prompt's to know.
   */
  readonly onRecoveryReceipt: () => void;
}

export function RecoveryPrompt(props: RecoveryPromptProps): ReactNode {
  const { bridge, onRecoveryReceipt, runId } = props;
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
                void requestRecovery(bridge, runId, action).then((settlement) => {
                  publishSettlement(settlement);
                  if (settlement.kind === "settled") {
                    // Reported even where the publish above was dropped as retired.
                    // What the reading answers is addressed by the subjects the page
                    // holds NOW, so the question a re-read puts is the current one
                    // either way — and a run this window stopped watching is still a
                    // run this node has just acted on.
                    onRecoveryReceipt();
                  }
                });
              }}
            />
          );
        })}
      </div>
      <RecoveryOutcomeLine outcome={outcome} />
    </div>
  );
}
