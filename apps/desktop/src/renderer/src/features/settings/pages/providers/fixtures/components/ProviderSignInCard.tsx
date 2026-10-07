import type { ProviderAccountLoginResponse } from "@ai-sidekicks/contracts/provider/account/sign-in";
import type { ReactNode } from "react";

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatDuration, formatWireString } from "#renderer/lib/wire/figures.js";
import { useOpenSignInPage } from "../hooks/useOpenSignInPage.js";
import { useSignInTimeLeft } from "../hooks/useSignInTimeLeft.js";
import type { ProviderSignInFlowState } from "../sign-in/flow.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/**
 * What a person needs to finish the provider's own sign-in: the code, the line under it saying how
 * long it has left, or once it has expired `Sign in again`, which starts the same account's
 * sign-in afresh, `Open the sign-in page` with the address beside it in a read-only field, and
 * `Cancel`; or, where it did not finish,
 * that line with the provider's own reason, the row's `Sign in` still there to start again.
 *
 * It is no verdict about the account: whether the account ended up signed in is the registry's to
 * say. The address is drawn always, so a browser that did not open is not a dead end.
 */
export function ProviderSignInCard(props: {
  readonly flow: ProviderSignInFlowState;
  readonly onCancel: () => void;
  readonly onSignInAgain: () => void;
}): ReactNode {
  const { flow, onCancel, onSignInAgain } = props;
  if (flow.kind === "idle" || flow.kind === "starting") {
    return null;
  }
  if (flow.kind === "unfinished") {
    return (
      <AnnouncedLine
        element="div"
        className="meridian-settings-page__state meridian-settings-page__state--failed"
        words={
          flow.failureReason === undefined
            ? SIGN_IN_UNFINISHED
            : `${SIGN_IN_UNFINISHED} ${formatWireString(flow.failureReason)}`
        }
        politeness="assertive"
      >
        <p>{SIGN_IN_UNFINISHED}</p>
        {flow.failureReason === undefined ? null : (
          <p className="meridian-settings-page__aside">
            <WireFigure value={flow.failureReason} />
          </p>
        )}
      </AnnouncedLine>
    );
  }
  return (
    <SignInInProgress
      attempt={flow.attempt}
      isCanceling={flow.kind === "canceling"}
      onCancel={onCancel}
      onSignInAgain={onSignInAgain}
    />
  );
}

/** The live card. Its own component so the countdown and the browser hand-off run as hooks. */
function SignInInProgress(props: {
  readonly attempt: ProviderAccountLoginResponse;
  readonly isCanceling: boolean;
  readonly onCancel: () => void;
  readonly onSignInAgain: () => void;
}): ReactNode {
  const { attempt, isCanceling, onCancel, onSignInAgain } = props;
  const timeLeftMilliseconds = useSignInTimeLeft(attempt.expiresAt);
  const { refusal, openSignInPage } = useOpenSignInPage();
  return (
    <div className="meridian-accounts__signin">
      {attempt.userCode === undefined ? null : (
        <p className="meridian-settings-page__state">
          <WireFigure value={attempt.userCode} />
        </p>
      )}
      {attempt.userCode === undefined || timeLeftMilliseconds === undefined ? null : (
        <p className="meridian-settings-page__aside">
          {timeLeftMilliseconds > 0 ? (
            <>
              This code expires in <DerivedFigure text={formatDuration(timeLeftMilliseconds)} />.
            </>
          ) : (
            <>
              Code expired · <TryAgainButton word="Sign in again" onPress={onSignInAgain} />
            </>
          )}
        </p>
      )}
      <p className="meridian-settings-page__state">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={() => {
            openSignInPage(attempt.verificationUri);
          }}
        >
          Open the sign-in page
        </button>{" "}
        <input
          className="meridian-form__input meridian-form__input--wire"
          readOnly
          value={attempt.verificationUri}
          aria-label="Sign-in address"
        />
      </p>
      {refusal === undefined ? null : (
        // No live role: the refusal announces itself through the app's announcer.
        <p className="meridian-settings-page__state meridian-settings-page__state--failed">
          <InlineRefusal {...refusal} />
        </p>
      )}
      <button
        type="button"
        className="meridian-settings-page__action meridian-action-button"
        disabled={isCanceling}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

/** What a sign-in that ended without signing in says, above the provider's own reason. */
const SIGN_IN_UNFINISHED = "Sign-in did not finish.";
