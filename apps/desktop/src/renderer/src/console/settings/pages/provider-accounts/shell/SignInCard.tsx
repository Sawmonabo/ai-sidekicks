import type { ReactNode } from "react";

import {
  DerivedFigure,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatDateTime,
} from "../../../../primitives/index.js";
import type { SignInFlowState } from "./signin-flow.js";

/**
 * The card a brokered sign-in is watched from: where to finish it, the code to type,
 * and when it stops working.
 *
 * IT APPEARS ONLY WHILE A FLOW IS LIVE. The idle arm renders nothing at all rather
 * than an empty frame — there is no sign-in to watch, and a persistent card would read
 * as a step somebody has to take.
 *
 * NOTHING HERE IS A VERDICT ABOUT THE ACCOUNT. The daemon runs the provider's own
 * unmodified sign-in binary and reads nothing it writes, so what this card reports is
 * the state of the FLOW: started, live, cancelled, or refused. Whether the account
 * ended up authenticated is a registry question, and the page says so in the same
 * breath rather than implying it.
 *
 * THE VERIFICATION URI IS RENDERED AND NEVER FOLLOWED. It is a wire string in mono,
 * exactly as it arrived — this console opens nothing and copies nothing on the
 * operator's behalf, because a URL a page navigates to on its own is a flow the
 * operator did not choose to start.
 */
export function SignInCard(props: {
  readonly flow: SignInFlowState;
  readonly onCancel: () => void;
}): ReactNode {
  const { flow, onCancel } = props;
  if (flow.kind === "idle") {
    return null;
  }
  if (flow.kind === "starting") {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="Asking the daemon to start the provider’s sign-in."
      />
    );
  }
  if (flow.kind === "refused") {
    return (
      <p
        className="meridian-settings-page__state meridian-settings-page__state--failed"
        role="alert"
      >
        <InlineRefusal {...flow.refusal} />
      </p>
    );
  }
  if (flow.kind === "ended") {
    return <p className="meridian-settings-page__state">{flow.because}</p>;
  }
  const { attempt } = flow;
  return (
    <div className="meridian-accounts__signin" role="group" aria-label="Sign-in in progress">
      <p className="meridian-settings-page__state">
        Finish the sign-in at <WireFigure value={attempt.verificationUri} />.
      </p>
      {attempt.userCode === undefined ? null : (
        <p className="meridian-settings-page__state">
          Type this code there: <WireFigure value={attempt.userCode} />
        </p>
      )}
      {attempt.expiresAt === undefined ? null : (
        <p className="meridian-settings-page__aside">
          The attempt stops working at <DerivedFigure text={formatDateTime(attempt.expiresAt)} />.
        </p>
      )}
      <p className="meridian-settings-page__aside">
        When the flow ends, this page reads the registry again to find out what became of the
        account. The flow ending is not itself a claim that it worked.
      </p>
      <button
        type="button"
        className="meridian-settings-page__action"
        disabled={flow.kind === "cancelling"}
        onClick={onCancel}
      >
        Cancel sign-in
      </button>
    </div>
  );
}
