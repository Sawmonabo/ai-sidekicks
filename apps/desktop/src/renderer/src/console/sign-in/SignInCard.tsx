// The signed-out card: one action, one honest note, and whatever the ceremony said.
//
// `Spec-023` gives the flow a start and does not name a screen for it, so the shape
// is this console's: a single card with the passkey action and the standing fact
// that a local session needs no account at all. Density is one card and one primary
// action, and the browser hand-off appears only when the host's probe says it must —
// never as a second way in offered beside the first.
//
// EVERY STATE RENDERS SOMETHING, and the states are the flow's, not this file's.
// What this component decides is which of them is a card body and which is a
// refusal: `Spec-023 §Console Design (Meridian)` rule 9 puts a refusal inline on the
// control that produced it, and rule 8 keeps "we asked and were told no" apart from
// "this build has no ceremony" — the first is an error and the second is _not
// checked_.
//
// A REFUSED ENROLMENT IS RENDERED INSIDE THE SIGNED-IN BODY and never in place of
// it, which is rule 9 taken literally: the control that produced it is _Add another
// passkey_, that control belongs to a session nothing revoked, and the refusal goes
// beside it in the inline shape with the session's own line still above. The way in
// is the other case — a refusal there has no session behind it, so it stands in for
// the body rather than sitting under one.

import { InlineRefusal, Nothing } from "../primitives/index.js";
import { DeviceGrantCard } from "./DeviceGrantCard.js";
import {
  CUSTODY_NOTES,
  LOCAL_SESSION_NOTE,
  PROBE_RESULT_NOTES,
  REFUSAL_REASON_NOTES,
  describeEnrolmentRefusal,
} from "./sign-in-copy.js";
import type { SignInState } from "./sign-in-flow.js";

export interface SignInCardProps {
  readonly state: SignInState;
  /** Whether a ceremony is unsettled, so the action waits rather than restarts. */
  readonly isBusy: boolean;
  readonly onSignIn: () => void;
  readonly onRegisterAnother: () => void;
  /** Opens the verification address in the system browser and starts the wait. */
  readonly onOpenBrowser: () => void;
  readonly onDismissRefusal: () => void;
}

export function SignInCard(props: SignInCardProps): React.JSX.Element {
  return (
    <section className="meridian-sign-in" aria-label="Sign in">
      <h2 className="meridian-sign-in__title">Sign in</h2>
      {renderBody(props)}
    </section>
  );
}

function renderBody(props: SignInCardProps): React.ReactNode {
  const { state } = props;
  switch (state.kind) {
    case "signed-out":
      return (
        <>
          <p className="meridian-sign-in__note">{LOCAL_SESSION_NOTE}</p>
          <button
            type="button"
            className="meridian-sign-in__act"
            onClick={props.onSignIn}
            disabled={props.isBusy}
          >
            Sign in with a passkey
          </button>
        </>
      );
    case "passkey-in-flight":
      return (
        <Nothing
          kind="computing"
          placement="surface"
          title="Waiting for the passkey prompt"
          detail="This machine is asking its authenticator. Nothing has been sent anywhere yet."
        />
      );
    case "handing-off":
      return (
        <>
          <p className="meridian-sign-in__note">{PROBE_RESULT_NOTES[state.probeResult]}</p>
          <DeviceGrantCard
            handoff={state.handoff}
            isWaiting={false}
            onOpenBrowser={props.onOpenBrowser}
          />
        </>
      );
    case "awaiting-callback":
      return (
        <DeviceGrantCard handoff={state.handoff} isWaiting onOpenBrowser={props.onOpenBrowser} />
      );
    case "signed-in":
      return (
        <>
          <p
            className={
              state.custody === "memory-only"
                ? "meridian-sign-in__note meridian-sign-in__note--degraded"
                : "meridian-sign-in__note"
            }
          >
            {CUSTODY_NOTES[state.custody]}
          </p>
          <button
            type="button"
            className="meridian-sign-in__act meridian-sign-in__act--secondary"
            onClick={props.onRegisterAnother}
            disabled={props.isBusy}
          >
            Add another passkey
          </button>
          {state.enrolmentRefusal === undefined ? null : (
            <InlineRefusal
              {...describeEnrolmentRefusal(state.enrolmentRefusal)}
              action={
                <button
                  type="button"
                  className="meridian-sign-in__act meridian-sign-in__act--secondary"
                  onClick={props.onDismissRefusal}
                >
                  Dismiss
                </button>
              }
            />
          )}
        </>
      );
    case "refused":
      return (
        <>
          <Nothing
            kind="error"
            placement="surface"
            title="Not signed in"
            detail={REFUSAL_REASON_NOTES[state.reason]}
          />
          <button
            type="button"
            className="meridian-sign-in__act meridian-sign-in__act--secondary"
            onClick={props.onDismissRefusal}
          >
            Back
          </button>
        </>
      );
    case "unavailable":
      // NOT AN ERROR, AND THE CODE IS STILL SHOWN. Rule 8 separates "we asked and
      // were told no" from "this build could not ask": the first is the arm above,
      // and this is _not checked_. The refusal is rendered in the console's own
      // inline shape beneath it rather than with the code as a heading — a bare wire
      // code as a title reads as the name of a state a person could act on.
      return (
        <>
          <Nothing
            kind="not-checked"
            placement="surface"
            title="This build could not run a sign-in ceremony."
            detail="The host process answered nothing this window could read, so nothing was asked of an authenticator and nothing was signed in."
          />
          <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
          <button
            type="button"
            className="meridian-sign-in__act meridian-sign-in__act--secondary"
            onClick={props.onDismissRefusal}
          >
            Back
          </button>
        </>
      );
  }
}
