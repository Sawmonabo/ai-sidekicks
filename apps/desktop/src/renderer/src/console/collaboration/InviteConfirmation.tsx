// One deliberate confirmation, and nothing else on screen while it is up.
//
// WHAT ARRIVES HERE, AND WHAT THE DESIGN'S END STATE WANTS TO ARRIVE HERE
//
// The end state is an opaque, single-use, main-confined reference: main holds the
// token from the operating-system deep link, hands the renderer a reference, and
// `invite.confirmPending` / `invite.retryPending` / `invite.dismissPending` /
// `invite.subscribePending` / `invite.subscribeOutcome` / `invite.preview` do the
// rest. NONE of those six is registered anywhere the console can reach: they are
// on no bridge namespace in `packages/contracts`, and — unlike the invites list —
// they are on NO row of `Plan-023 §Console growth slate`, so the growth port has
// no operation to refuse with either. A port entry for them is not this lane's to
// mint.
//
// So this component takes what the shipped acceptance path actually takes: the
// opaque token, from whichever caller holds one. That is a deviation from the
// end-state contract on the TRANSPORT and on nothing else — the design's own note
// says as much, that what changes around the shipped component is "the wiring on
// either side of it, a main-confined reference in place of a renderer-held token
// and a main-process acceptance in place of a direct daemon call".
//
// WHAT IS PRESERVED FROM THE SHIPPED COMPONENT, BY IMPORTING IT
//
// Acceptance starts idle and is button-triggered, so no mount can burn a
// single-use invite; and a synchronous throw from the bridge normalizes into the
// same rejected state as an asynchronous rejection. Both are the shipped
// component's, unaltered — the console mounts it through the frame's absorption
// helper, which also carries the fixture guard, because that component reads the
// installed bridge directly and the console's fixture cannot stand in for it.
//
// WHAT THIS COMPONENT WILL NOT DO
//
//   • It never accepts on mount. The only thing that accepts is the absorbed
//     control, and a person presses it.
//   • It never auto-focuses that control and never accepts a bare return key.
//     Nothing here is a form, and no `autoFocus` is set anywhere below.
//   • It never renders a raw inviter identifier when the display name is absent —
//     the fallback is the session's own identity, which is what the confirmation
//     identifies the session by.
//   • It renders no facts it was not given. The session name, the inviter's
//     display name, the join mode, and the expiry are each independently
//     nullable, and each absent one renders as an absence naming the preview that
//     would have carried it, never as a blank or a guess.

import type { JoinMode } from "@ai-sidekicks/contracts";

import { renderAbsorbedInviteAcceptance } from "../frame/legacy-surfaces.js";
import type { ConsoleBridgeSource } from "../bridge/index.js";
import { Chip, Nothing, WireFigure, formatDateTime } from "../primitives/index.js";

/**
 * What a caller holding a pending invitation hands this surface.
 *
 * Everything but the token and the session is optional because the preview that
 * would supply it is unregistered, and every member of that preview is
 * independently nullable in the contract that describes it.
 */
export interface PendingInviteConfirmation {
  /** The opaque invite credential. Rendered nowhere; passed to the absorbed control. */
  readonly token: string;
  /** Wire-verbatim. The identity the confirmation falls back to naming. */
  readonly sessionId: string;
  readonly sessionName?: string | undefined;
  readonly inviterDisplayName?: string | undefined;
  readonly joinMode?: JoinMode | undefined;
  readonly expiresAtIso?: string | undefined;
}

export interface InviteConfirmationProps {
  /** `undefined` renders nothing at all: no pending invite, no surface. */
  readonly pending: PendingInviteConfirmation | undefined;
  readonly bridgeSource: ConsoleBridgeSource;
  /**
   * **Not now** — a local hide that sends no decline verb anywhere, because
   * declining is implicit and `InviteState` has no `declined` member to move to.
   */
  readonly onDismiss: () => void;
}

export function InviteConfirmation(props: InviteConfirmationProps): React.JSX.Element | null {
  const { pending } = props;
  if (pending === undefined) {
    return null;
  }
  return (
    <section
      className="meridian-invite-confirmation"
      aria-label="Confirm this invitation"
      role="group"
    >
      <header className="meridian-invite-confirmation__head">
        <h2 className="meridian-invite-confirmation__title">
          {pending.sessionName ?? "You have been invited to a session."}
        </h2>
        <p className="meridian-invite-confirmation__identity">
          <WireFigure value={pending.sessionId} />
        </p>
      </header>

      <dl className="meridian-invite-confirmation__facts">
        <div className="meridian-invite-confirmation__fact">
          <dt>Invited by</dt>
          <dd>
            {pending.inviterDisplayName ?? (
              <Nothing
                kind="not-checked"
                placement="inline"
                title="Not named"
                detail="The preview that carries the inviter's display name is not registered, and the raw identifier is not a name."
              />
            )}
          </dd>
        </div>
        <div className="meridian-invite-confirmation__fact">
          <dt>Joining as</dt>
          <dd>
            {pending.joinMode === undefined ? (
              <Nothing
                kind="not-checked"
                placement="inline"
                title="Not read"
                detail="The join mode comes from the anonymous invite preview, which is not registered on any transport this console has."
              />
            ) : (
              <Chip label={pending.joinMode} mono />
            )}
          </dd>
        </div>
        <div className="meridian-invite-confirmation__fact">
          <dt>Stops working</dt>
          <dd>
            {pending.expiresAtIso === undefined ? (
              <Nothing
                kind="not-checked"
                placement="inline"
                title="Not read"
                detail="The expiry comes from the same unregistered preview."
              />
            ) : (
              <WireFigure
                value={formatDateTime(pending.expiresAtIso)}
                title={pending.expiresAtIso}
              />
            )}
          </dd>
        </div>
      </dl>

      <div className="meridian-invite-confirmation__acts">
        <div className="meridian-invite-confirmation__accept">
          {renderAbsorbedInviteAcceptance(props.bridgeSource, pending.token)}
        </div>
        <button
          type="button"
          className="meridian-invite-confirmation__dismiss"
          onClick={props.onDismiss}
        >
          Not now
        </button>
      </div>

      <p className="meridian-invite-confirmation__footnote">
        Not now simply puts this away. Nobody is told, because there is no decline to send.
      </p>
    </section>
  );
}
