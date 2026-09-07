// What came back from a recovery request, in one line under the controls.
//
// ITS OWN MODULE because the package rule is one component per `.tsx`, and the split
// is the honest one: this component is pure over the outcome union and touches no
// bridge, so a test can drive all four arms without a transport — including the arm
// that is the whole reason the receipt carries two states.
//
// THE PAIR IS THE RECEIPT. A request that was accepted is not evidence that anything
// moved, so the two arms below read the reply's own `previousState` and `newState`
// rather than the button that was pressed: a node that took the action and left the
// run where it was says so, in as many words. Reporting "interrupted" because the
// control said interrupt would be this console answering its own question.
//
// AND THE ACTION IS THE NODE'S WORD. `actionTaken` is rendered verbatim rather than
// the label from the control, because they can differ — a node is entitled to say it
// did something other than what was asked, and the whole point of a receipt is that
// it is allowed to.

import type { ReactNode } from "react";

import { InlineRefusal, WireFigure } from "../../../../primitives/index.js";
import type { RecoveryOutcome } from "./recovery-request.js";

export function RecoveryOutcomeLine(props: { readonly outcome: RecoveryOutcome }): ReactNode {
  const { outcome } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "pending") {
    return (
      <p className="meridian-recovery-prompt__outcome" aria-busy="true">
        Asking this machine to <WireFigure value={outcome.action} />…
      </p>
    );
  }
  if (outcome.kind === "refused") {
    return (
      <p className="meridian-recovery-prompt__outcome" role="alert">
        <InlineRefusal {...outcome.refusal} />
      </p>
    );
  }
  const { receipt } = outcome;
  return (
    <p className="meridian-recovery-prompt__outcome" role="status">
      {receipt.previousState === receipt.newState ? (
        <>
          This machine took <WireFigure value={receipt.actionTaken} /> and reports the run still in{" "}
          <WireFigure value={receipt.newState} />. Nothing moved.
        </>
      ) : (
        <>
          This machine took <WireFigure value={receipt.actionTaken} />. The run went from{" "}
          <WireFigure value={receipt.previousState} /> to <WireFigure value={receipt.newState} />.
        </>
      )}
    </p>
  );
}
