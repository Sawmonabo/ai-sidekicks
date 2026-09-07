// The deep-link invite lifecycle, hosted once per window.
//
// WHY IT IS HERE AND NOT IN THE MEMBERS SECTION, WHICH IS WHERE IT STARTED
//
// An invitation delivered on `sidekicks://invite/<token>` is about a session this
// window is NOT in, and the person it reaches most often is the one who has opened
// no session at all — a first-time recipient following a link into a fresh window.
// Mounted under the members section, the two feeds opened only while a session view
// was on screen: with no active session neither feed opened, so nothing arrived and
// nothing could surface. `Plan-023` T-023r-6-3 states the placement directly — the
// confirmation is "hosted by the console frame rather than by a session view,
// because a deep link can fire before any session view is mounted".
//
// EXACTLY ONE PER WINDOW, STRUCTURALLY. The lifecycle owns two live subscriptions and
// a single-use reference queue, so a second instance would be a second window's worth
// of channels inside one window and two cards competing to answer one invitation. The
// window overlay seat holds one occupant, the frame renders it once, and nothing else
// in the tree calls `usePendingInvites` — which is what makes "one" a property of the
// composition rather than a rule somebody has to remember.
//
// AN ARRIVAL DRAWS A NOTICE; IT NEVER OPENS THE CARD
//
// The arrival is on somebody else's schedule: mid-approval, mid-run, mid-sentence. A
// dialog that opened itself would take the screen from whatever was being done, which
// is the one thing every console surface is forbidden to do. So an arrival draws a
// notice — unmissable, persistent, and out of the way — and the confirmation opens on
// a press, one gesture later and never a moment the person did not choose.
//
// THE NOTICE ALSO CARRIES THE CHANNEL'S OWN FAILURE, and that is why it renders for a
// feed refusal with no invitation waiting: "we cannot tell you whether one arrived" is
// a different fact from "none has", and a window that drew nothing would be saying the
// second while the first was true.

import { useCallback, useState } from "react";

import { InlineRefusal } from "../../primitives/index.js";
import type { WindowOverlaySeatProps } from "../../seats/index.js";
import { InviteConfirmation } from "./InviteConfirmation.js";
import { useJoinedOutcomeNavigation } from "./joined-outcome-navigation.js";
import { usePendingInvites } from "./use-pending-invites.js";

export type InviteLifecycleOverlayProps = WindowOverlaySeatProps;

export function InviteLifecycleOverlay(
  props: InviteLifecycleOverlayProps,
): React.JSX.Element | null {
  const { bridge, openSession } = props;
  const { snapshot, adapter } = usePendingInvites(bridge);
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);
  useJoinedOutcomeNavigation(snapshot, openSession);

  // ONE HANDLER FOR EVERY WAY THE CARD CAN BE PUT AWAY. Whether the press releases
  // the reference or acknowledges a spent one is the card's own branch, because the
  // card already makes it to choose which block it renders; what this owns is what
  // each of the two acts does to the lifecycle and to the card's open state.
  const dismiss = useCallback(() => {
    // Local and silent. `Spec-002 §Required Behavior` mints no decline verb, so what
    // this releases is the reference the main process is holding and nobody is told.
    // The adapter refuses it while an act on the same reference is unsettled, which
    // is why the control that dispatches it closes for that lifetime.
    adapter.dismiss();
    setIsConfirmationOpen(false);
  }, [adapter]);
  const acknowledge = useCallback(() => {
    adapter.acknowledge();
    setIsConfirmationOpen(false);
  }, [adapter]);
  const confirm = useCallback(() => {
    adapter.confirm();
  }, [adapter]);
  const retry = useCallback(() => {
    adapter.retry();
  }, [adapter]);

  const hasNotice = snapshot.invite !== undefined || snapshot.feedRefusal !== undefined;
  return (
    <>
      {hasNotice ? (
        <div className="meridian-invite-notice" role="status">
          {snapshot.invite === undefined ? null : (
            <>
              <p className="meridian-invite-notice__lede">
                {snapshot.waitingBehind > 0
                  ? `You have ${String(snapshot.waitingBehind + 1)} invitations waiting.`
                  : "You have an invitation waiting."}
              </p>
              <button
                type="button"
                className="meridian-invite-notice__open"
                onClick={() => {
                  setIsConfirmationOpen(true);
                }}
              >
                Look at it
              </button>
            </>
          )}
          {snapshot.feedRefusal === undefined ? null : (
            <InlineRefusal code={snapshot.feedRefusal.code} detail={snapshot.feedRefusal.detail} />
          )}
        </div>
      ) : null}
      <InviteConfirmation
        open={isConfirmationOpen && snapshot.invite !== undefined}
        snapshot={snapshot}
        onConfirm={confirm}
        onRetry={retry}
        onDismiss={dismiss}
        onAcknowledge={acknowledge}
      />
    </>
  );
}
