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
//
// AND IT ANNOUNCES A PREVIEW THAT PRODUCED NO INVITATION, on the same reading. The
// pending feed carries three states and only one of them is an invitation: a link the
// control plane refused and one that could not be put at all reach this window too,
// and while the notice drew for the ready arm alone both of those arrived, were held
// by the lifecycle, and were surfaced by nothing — so an expired link looked exactly
// like a link nobody had followed, and the retry the `unavailable` arm carries the
// handle for was reachable from no control on any screen. All three open the SAME
// card, because they are one question about one deep link.
//
// SO WHAT IS OPEN IS A PROMPT AND NOT A DIALOG. Held as a flag, the open state
// outlived the prompt it was opened for: the lifecycle's queue moves on its own — a
// served retry releases its head and a fresh frame takes its place — and with anything
// waiting behind, the card swapped straight to the next arrival, which is a prompt
// nobody had pressed **Look at it** for. Holding the HEAD the gesture was made for
// makes that impossible to express rather than something to remember: the card is open
// exactly while the head is still the one a person asked to see, so the queue advancing
// closes it, a head that has not moved — a refused retry, an outcome arriving against
// the invitation on screen — keeps it open with its own words, and every new prompt
// costs the same one gesture the first one did.

import { useCallback, useState } from "react";

import type { GrowthPendingInvite, GrowthPendingInvitePreviewFailure } from "../../bridge/index.js";
import { InlineRefusal } from "../../primitives/index.js";
import type { WindowOverlaySeatProps } from "../../seats/index.js";
import { InviteConfirmation } from "./InviteConfirmation.js";
import { useJoinedOutcomeNavigation } from "./joined-outcome-navigation.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import { usePendingInvites } from "./use-pending-invites.js";

export type InviteLifecycleOverlayProps = WindowOverlaySeatProps;

/**
 * The head, whichever of the three states it arrived in.
 *
 * The reading splits one head across two mutually exclusive members, so this is that
 * split read back — and it is compared by IDENTITY rather than by a composed key
 * because the refused arm carries no handle at all (`pending-invite-arrivals.ts` says
 * why it cannot be given one), and two refusals with the same code would collide under
 * any key derived from their fields. The arrival object is the queue's own: admitted
 * once, carried unchanged, and dropped when the head is released, so identity answers
 * "is this still the prompt that was opened" exactly and for all three arms.
 */
type PendingInvitePrompt = GrowthPendingInvite | GrowthPendingInvitePreviewFailure;

export function InviteLifecycleOverlay(
  props: InviteLifecycleOverlayProps,
): React.JSX.Element | null {
  const { bridge, openSession } = props;
  const { snapshot, adapter } = usePendingInvites(bridge);
  // The head a person actually asked to see, and not a flag saying one of them was.
  const [promptLookedAt, setPromptLookedAt] = useState<PendingInvitePrompt | undefined>(undefined);
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
    setPromptLookedAt(undefined);
  }, [adapter]);
  const acknowledge = useCallback(() => {
    adapter.acknowledge();
    setPromptLookedAt(undefined);
  }, [adapter]);
  const confirm = useCallback(() => {
    adapter.confirm();
  }, [adapter]);
  // NOT A CLOSE PATH, unlike the two above it, and that is a property of what a retry
  // ANSWERS. Its answer is a fresh preview state on the pending feed rather than
  // anything this card can render, so the lifecycle releases the head it was
  // dispatched on when the call is served — and the card closes because the prompt it
  // was opened for is gone, not because this handler said so. Clearing the held prompt
  // here would take a REFUSED retry off the screen along with the refusal's own words,
  // on the one arm where the head has not moved at all.
  const retry = useCallback(() => {
    adapter.retry();
  }, [adapter]);

  // Whichever of the three states the head is in, there is something to look at.
  const prompt: PendingInvitePrompt | undefined = snapshot.invite ?? snapshot.previewFailure;
  const hasPrompt = prompt !== undefined;
  const isConfirmationOpen = hasPrompt && prompt === promptLookedAt;
  return (
    <>
      {hasPrompt || snapshot.feedRefusal !== undefined ? (
        <div className="meridian-invite-notice" role="status">
          {hasPrompt ? (
            <>
              <p className="meridian-invite-notice__lede">{noticeLede(snapshot)}</p>
              <button
                type="button"
                className="meridian-invite-notice__open"
                onClick={() => {
                  setPromptLookedAt(prompt);
                }}
              >
                Look at it
              </button>
            </>
          ) : null}
          {snapshot.feedRefusal === undefined ? null : (
            <InlineRefusal code={snapshot.feedRefusal.code} detail={snapshot.feedRefusal.detail} />
          )}
        </div>
      ) : null}
      <InviteConfirmation
        open={isConfirmationOpen}
        snapshot={snapshot}
        onConfirm={confirm}
        onRetry={retry}
        onDismiss={dismiss}
        onAcknowledge={acknowledge}
      />
    </>
  );
}

/**
 * What the notice says about the head, in one sentence.
 *
 * The two readings are genuinely different claims and neither can stand in for the
 * other: "an invitation is waiting" is an offer, and "a link did not open" is a
 * report. The count behind the head rides both, because a person deciding whether to
 * look now is deciding about the queue rather than about its first entry.
 */
function noticeLede(snapshot: PendingInviteSnapshot): string {
  const { waitingBehind } = snapshot;
  if (snapshot.invite === undefined) {
    return waitingBehind > 0
      ? `An invitation link did not open. ${String(waitingBehind)} more ${
          waitingBehind === 1 ? "is" : "are"
        } waiting.`
      : "An invitation link did not open.";
  }
  return waitingBehind > 0
    ? `You have ${String(waitingBehind + 1)} invitations waiting.`
    : "You have an invitation waiting.";
}
