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
//
// AND THE CARD ITSELF ARRIVES ON ITS OWN CHUNK. What is on this module is what nobody
// can wait for: the two subscriptions, the queue, and the notice a person is shown
// without acting. The card is drawn only after a press, which is the question
// `apps/desktop/AGENTS.md` §Module shape makes a registration answer, so it is reached
// through `invite-confirmation-mount.ts` and `invite-confirmation-body.ts` is the split
// point. The mount is rendered from the moment there is a PROMPT rather than from the
// press — which is the same condition the card's own first line already tested, hoisted
// one level up — so the chunk is asked for as the notice appears and is settled by the
// time anybody has reached **Look at it**. What renders while it is in flight is the
// substrate's hidden reserved region and nothing else: no spinner, no skeleton, and
// nothing that moves the layout the notice is drawn in.

import { useCallback, useState } from "react";

import type { GrowthPendingInvite, GrowthPendingInvitePreviewFailure } from "../../bridge/index.js";
import { InlineRefusal } from "../../primitives/index.js";
import type { WindowOverlaySeatProps } from "../../seats/index.js";
import { useModalSurfaceClaim } from "../../store/index.js";
import { inviteNoticeLede } from "./invite-queue-copy.js";
import { inviteConfirmationMount } from "./invite-confirmation-mount.js";
import { useJoinedOutcomeNavigation } from "./joined-outcome-navigation.js";
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
  const { bridge, claimModalSurface, openSession } = props;
  const { snapshot, adapter } = usePendingInvites(bridge);
  // The head a person actually asked to see, and not a flag saying one of them was.
  const [promptLookedAt, setPromptLookedAt] = useState<PendingInvitePrompt | undefined>(undefined);
  useJoinedOutcomeNavigation(snapshot, openSession);

  // ONE HANDLER PER ACT, AND NONE OF THEM CLOSES THE CARD. Whether a press releases
  // the reference or acknowledges a spent one is the card's own branch, because the
  // card already makes it to choose which block it renders; what this owns is what
  // each act does to the lifecycle. The card closes because the prompt it was opened
  // for is GONE — the rule the held prompt below already states — and never because a
  // handler said so on the way out.
  //
  // THAT IS THE WHOLE OF WHY THE RETRY LOOKED DIFFERENT AND IS NOT. It has always been
  // written this way, with a comment explaining that clearing the held prompt would
  // take a REFUSED retry off the screen along with the refusal's own words; the same
  // sentence is true of the two close acts, and they cleared it anyway. A refused
  // dismissal leaves the invitation exactly where it was and puts the reason on the
  // reading, and a local acknowledgement the lifecycle declines — a reference main is
  // still holding — moves nothing at all. Both of them used to take the card away
  // regardless, so the person saw the prompt vanish, the notice return, and no account
  // anywhere of why. A served act releases the head, the head is what the card is open
  // for, and so the card closes on its own with nothing left to say.
  const dismiss = useCallback(() => {
    // Local and silent. `Spec-002 §Required Behavior` mints no decline verb, so what
    // this releases is the reference the main process is holding and nobody is told.
    // The adapter refuses it while an act on the same reference is unsettled, which
    // is why the control that dispatches it closes for that lifetime.
    adapter.dismiss();
  }, [adapter]);
  const acknowledge = useCallback(() => {
    adapter.acknowledge();
  }, [adapter]);
  const confirm = useCallback(() => {
    adapter.confirm();
  }, [adapter]);
  const retry = useCallback(() => {
    adapter.retry();
  }, [adapter]);

  // Whichever of the three states the head is in, there is something to look at.
  const prompt: PendingInvitePrompt | undefined = snapshot.invite ?? snapshot.previewFailure;
  const hasPrompt = prompt !== undefined;
  const isConfirmationOpen = hasPrompt && prompt === promptLookedAt;
  // THE CARD IS OPEN, SO THE WINDOW SAYS SO. `InviteConfirmation` opens under
  // `modal="trap-focus"`, which traps the keyboard and leaves inerting the app root to
  // the shell — and the shell cannot see a view family's card, so without this publish
  // the rail and the whole route surface stayed reachable behind an open confirmation
  // to anyone moving by structure. Nothing renders differently, which is why the
  // register's own cell is the only thing that can report it.
  //
  // ON THIS BOOLEAN AND NOT ON `hasPrompt`, which is the same boolean the card takes as
  // `open`: an arrival draws a notice and never opens the card, and a claim armed on
  // the arrival would inert the window behind a notice a person is meant to be able to
  // ignore. The claim ends with the card on every path this component has — the two
  // close acts, a queue that moves on, a bridge swap that empties the reading, and the
  // unmount — because all of them are this one value going false.
  useModalSurfaceClaim(claimModalSurface, isConfirmationOpen);
  return (
    <>
      {hasPrompt || snapshot.feedRefusal !== undefined ? (
        <div className="meridian-invite-notice" role="status">
          {hasPrompt ? (
            <>
              {/* THE COUNT IS A FLOOR WHERE THE BOUND TURNED SOMETHING AWAY, and the
                  copy module is where that is decided. This notice printed an exact
                  figure off `waitingBehind`, which excludes the arrivals the queue's
                  bound deferred to the replay — so a window holding eleven invitations
                  reported eight as though that were all of them. */}
              <p className="meridian-invite-notice__lede">{inviteNoticeLede(snapshot)}</p>
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
      {/* GATED ON `hasPrompt`, WHICH IS THE CARD'S OWN FIRST LINE AND NOT A NEW RULE.
          `InviteConfirmation` opens with `if (invite === undefined && previewFailure ===
          undefined) return null`, so this renders exactly what it rendered before: a
          window with nothing waiting drew no card, and one with a prompt drew a dialog
          root that paints nothing until it is open. Hoisting that test here is what lets
          the chunk be asked for on the arrival rather than on the press, and it is why
          the mount's lifetime — mounted closed, opened, closed, unmounted with the last
          prompt — is the lifetime the card always had. */}
      {hasPrompt
        ? inviteConfirmationMount.render({
            open: isConfirmationOpen,
            snapshot,
            onConfirm: confirm,
            onRetry: retry,
            onDismiss: dismiss,
            onAcknowledge: acknowledge,
          })
        : null}
    </>
  );
}
