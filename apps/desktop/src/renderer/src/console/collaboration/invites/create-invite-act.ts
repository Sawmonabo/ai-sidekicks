// One press of the send control: what it is allowed to put, what it composes, and
// what it does with what comes back.
//
// SPLIT FROM `CreateInvite.tsx`, which owns the FORM — the two choices a person makes,
// the one-time reveal, and where each refusal renders. This owns the ACT, and they are
// two jobs with two audiences: the form is read by somebody asking what the surface
// looks like, and this by somebody asking what a press costs. THE SEAM IS THE WHOLE
// REASON, and the size of the file the two once made is none of it — a split taken on a
// line count puts the next thing anybody adds on whichever side has room, which is how
// two files come to hold one job. What is here is the ORDERING a press runs in and
// nothing that renders: the supervisor guard, the control-plane host read, the mint, the
// ledger write, and the second guard after the await. `CreateInvite.tsx` states none of
// that ordering and reaches all of it through `useInviteMintAct` below, so the two never
// have to be read together — which is what a seam is for and what a page count is not.
//
// AND THE LINK IS COMPOSED FROM A SECOND READ, TAKEN INSIDE THE SAME ACT
//
// `Spec-002 §Invite Delivery` writes the link as
// `https://<control-plane-host>/invite/<token>`, and nothing on the shipped bridge
// tells this renderer its own control-plane host. That is the growth port's
// `controlPlaneHostRead`, asked at the PRESS rather than on mount: a read performed for
// every visit to this section would ask a question no one needed answered, and an
// intent to invite somebody is what makes the answer worth having. It is asked as part
// of the mint rather than after it, and `invite-mint.ts` is where that act lives and
// where the ordering argument is written down — the short of it being that the
// coordinator's latch has to cover the whole act, and that reading the host FIRST is
// what lets a host that refuses end the act before a token exists. So a refused host
// mints nothing at all: no row reaches the ledger, the read's own refusal renders on
// the send control like any other, and pressing again is the whole retry.
//
// THE SUPERVISOR IS ASKED TWICE, AT THE TWO MOMENTS IT CAN ANSWER DIFFERENTLY. A block
// derived in a render is the block of the last COMMITTED render, so a report landing
// between that render and a press leaves the guard reading `undefined` while the
// runtime has stopped — the press is admitted and a write goes out to a supervisor that
// is not serving. So the store is read where the call is put, and read again inside the
// act after the host read, which is a real await the runtime can stop across. What the
// render-time block is for is the CONTROL: it draws it closed and rides it as its
// disabled reason, and the section above says the sentence once.
//
// AND THE SHELL'S OWN ABORT LEAVES NO REFUSAL BEHIND. The act's second re-check ends the
// press on the refused arm, but the reason it carries is the store's live condition and
// not this press's outcome: the hosting section already prints it, and it stops being
// true the moment the runtime comes back — which the store publishes and a retained
// copy would not follow. So the coordinator is told to retain no shell-block refusal,
// and what a person sees through the outage is the section's one sentence and a closed
// control; what they see after it is an open control and nothing left over.

import { useCallback, useEffect, useMemo } from "react";
import type { JoinMode } from "@ai-sidekicks/contracts";

import {
  callDaemon,
  consoleClockFor,
  heldIdAsWireId,
  type ConsoleBridge,
  type DaemonRequestOf,
} from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import {
  currentShellBlock,
  isShellBlockRefusal,
  useShellBlockFor,
  type FrameStore,
  type ShellMutationBlock,
} from "../../store/index.js";
import { inviteExpiryChoice, inviteExpiryInstant } from "./invite-draft.js";
import { inviteMintWithLink, type InviteMintReceipt } from "./invite-mint.js";
import {
  WireMutationCoordinator,
  type CollaborationMutation,
  type CollaborationMutationMethod,
  useWireMutation,
} from "../mutation-coordinator.js";

/**
 * The wire method the send control calls, through the daemon gateway.
 *
 * The `satisfies` IS the binding, on `onboarding/provider-readiness/`'s precedent:
 * `store/shell/shell-mutation-block.ts` is the console's registration of what a supervisor's
 * condition closes, so an invitation mint that ever left that tuple stops compiling
 * here rather than quietly going back to being dispatchable through a stopped shell.
 * The literal type survives it, which is what `callDaemon` needs to type the request
 * and the reply; a wider annotation would take both.
 */
const INVITE_CREATE_METHOD = "invite.create" satisfies CollaborationMutationMethod;

/** The coordinator's subject key. One mint at a time, so one key. */
const CREATE_INVITE_KEY = "create-invite";

/** What one press has to know before it can compose a request at all. */
export interface InviteMintActOptions {
  readonly bridge: ConsoleBridge;
  /** Where this window's shell condition is published, read at every dispatch. */
  readonly frameStore: FrameStore;
  /** The session an invitation would be into. `undefined` closes the act. */
  readonly sessionId: string | undefined;
  /**
   * Which participant this window is, or `undefined` while that is unknown.
   *
   * The request's fourth member, and the act refuses without it rather than guessing:
   * `CreateInvite.tsx` owns the read that answers it and says why it is taken on mount.
   */
  readonly inviterParticipantId: string | undefined;
  readonly joinMode: JoinMode;
  readonly expiryId: string;
  /** What a settled mint produced. Called once per mint, in the settling turn. */
  readonly onMinted: (receipt: InviteMintReceipt) => void;
}

/** The act, as the form reads and drives it. */
export interface InviteMintAct {
  /** Whether a mint this form put is still running. What closes the control. */
  readonly isSending: boolean;
  /**
   * Why the shell closes the send control, or `undefined` while nothing does.
   *
   * The RENDER-time answer, subscribed so a supervisor going down or coming back moves
   * the control. It decides how the control is drawn and never whether a press is
   * admitted — see this module's header on why those are two questions.
   */
  readonly block: ShellMutationBlock | undefined;
  /** The refusal standing against the last press, or `undefined`. */
  readonly refusal: ConsoleRefusal | undefined;
  /** Put one invitation, or refuse the press where it stands. */
  readonly send: () => void;
  /** Drop the refusal a person dismissed. */
  readonly dismissRefusal: () => void;
}

/** One form's mint: its single-flight latch, its shell guards, and its settlement. */
export function useInviteMintAct(options: InviteMintActOptions): InviteMintAct {
  const { bridge, frameStore, sessionId, inviterParticipantId, joinMode, expiryId, onMinted } =
    options;

  const coordinator = useMemo(() => {
    // The door call sits HERE, where exactly one method is named, rather than behind
    // a binder generic over the family's methods: one call site naming one method is
    // what lets the read-signal gate read the deliberate absence of a cancellation
    // signal as deliberate. A mint that has reached the daemon has HAPPENED, so
    // there is nothing this window may abandon it with.
    const createInvite: CollaborationMutation<typeof INVITE_CREATE_METHOD> = async (request) =>
      await callDaemon(bridge, INVITE_CREATE_METHOD, request);
    return new WireMutationCoordinator({
      // The MINT AND ITS LINK, not the mint alone. The latch this coordinator holds
      // is what closes the send control, so an act that settled halfway would
      // re-open the control over a token still waiting to be revealed.
      //
      // The act carries the shell re-check with it because the boundary it guards is
      // INSIDE the act: the host read is an await the supervisor can stop across, and
      // only the act knows when that read has answered. A closure over the store
      // rather than a derived block — the whole point is that it is read late.
      perform: inviteMintWithLink(bridge, createInvite, () =>
        currentShellBlock(frameStore, INVITE_CREATE_METHOD),
      ),
      describeWhat: "The invitation",
      // The shell's abort ends the act and is recorded NOWHERE on this form: the block
      // is the window's condition, published by the store and printed once by the
      // hosting section, and `invite-mint.ts` says at the arm why a copy here would
      // outlive it. Every other refusal — the host read's, the daemon's — stands
      // against the control until the next press or a dismissal, as before.
      retains: (refusal) => !isShellBlockRefusal(refusal),
    });
    // Keyed on the subject for the ledger's reason: an unsettled mint in the session
    // being left must not close the send control in the session being entered.
  }, [bridge, frameStore, sessionId]);
  const mutation = useWireMutation(coordinator);
  // SUBSCRIBED, so a supervisor going down or coming back moves the control without
  // waiting for some other read to settle, and asked per METHOD through the one seam
  // that knows which calls an outage closes.
  const block = useShellBlockFor(frameStore, INVITE_CREATE_METHOD);

  useEffect(() => {
    // Superseded rather than dropped: an unsettled call whose caller has gone would
    // otherwise resolve into whichever form is on screen now.
    return () => {
      coordinator.supersede();
    };
  }, [coordinator]);

  const send = useCallback(() => {
    // Fail-closed at the dispatch site and not only on the control: the button is
    // disabled from the render-time block, so this is the guard rather than the
    // affordance, and it reads the store NOW for the reason in this module's header.
    if (
      sessionId === undefined ||
      inviterParticipantId === undefined ||
      currentShellBlock(frameStore, INVITE_CREATE_METHOD) !== undefined
    ) {
      return;
    }
    const choice = inviteExpiryChoice(expiryId);
    const request: InviteCreateRequest = {
      sessionId: heldIdAsWireId(sessionId),
      inviter: heldIdAsWireId(inviterParticipantId),
      joinMode,
      expiresAt: inviteExpiryInstant(consoleClockFor(bridge).now(), choice.days),
    };
    void coordinator.run(CREATE_INVITE_KEY, request).then((settlement) => {
      // `undefined` is the refused arm and the superseded one. Either way the reason
      // is on the coordinator's snapshot beside the control that asked, or there is
      // no control left to put one beside.
      if (settlement === undefined) {
        return;
      }
      // NOTHING IS AWAITED HERE, and that is the guarantee rather than a tidiness:
      // the token's link was composed inside the act the coordinator held its latch
      // over, so the reveal is published in the same turn the control re-opens in and
      // there is no window in which a minted token is neither on screen nor in flight.
      onMinted(settlement);
    });
  }, [
    bridge,
    coordinator,
    expiryId,
    frameStore,
    inviterParticipantId,
    joinMode,
    onMinted,
    sessionId,
  ]);

  const dismissRefusal = useCallback(() => {
    coordinator.dismiss(CREATE_INVITE_KEY);
  }, [coordinator]);

  return {
    isSending: mutation.pendingKey !== undefined,
    block,
    refusal: mutation.refusalByKey[CREATE_INVITE_KEY],
    send,
    dismissRefusal,
  };
}

/** What one mint asks for, read off the call door's own registry rather than declared. */
type InviteCreateRequest = DaemonRequestOf<typeof INVITE_CREATE_METHOD>;
