import type { ReactNode } from "react";

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import type { ProviderSignInFlowState } from "../provider-sign-in-flow.js";

/**
 * The card a brokered sign-in is watched from: where to finish it, the code to type, and when
 * it stops working.
 *
 * It appears only while a flow is live; idle renders nothing. It is no verdict about the
 * account: the daemon runs the provider's own unmodified sign-in binary and reads nothing it
 * writes, so the card reports the flow's state, and whether the account ended up authenticated
 * is a registry question. The verification URI is rendered and never followed, since a URL a
 * page navigates to on its own is a flow the person did not choose to start.
 */
export function ProviderSignInCard(props: {
  readonly flow: ProviderSignInFlowState;
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
        title="Asking the background service to start the provider’s sign-in."
      />
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
        className="meridian-settings-page__action meridian-action-button"
        disabled={flow.kind === "canceling"}
        onClick={onCancel}
      >
        Cancel sign-in
      </button>
    </div>
  );
}
