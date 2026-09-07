// Minting one invitation: who it is for, how long it lasts, and the link it becomes.
//
// WHAT THE FORM NEEDS BEFORE IT CAN ASK ANYTHING
//
// `InviteCreate` is `{sessionId, inviter, joinMode, expiresAt}`. Three of those the
// form has — the session it is mounted in, and the two a person picks. The fourth is
// the CALLER'S OWN participant id, which no session read marks: a projected roster
// says who is here, not which of them this window is. That is the growth port's
// `callerParticipantRead`, and it is read once per (bridge, session) on mount rather
// than at the press, so a person is never told the console does not know who it is
// half a second after they asked it to send something.
//
// A read still in flight closes the send control; a refused read closes it and says
// why. Neither is a permission check — the read is the request's own missing member,
// and a form that offered a control it could not compose a request for would produce
// a refusal from nowhere.
//
// ELIGIBILITY IS STILL THE DAEMON'S. `Spec-002 §Invite Revocation` makes issuing
// owner-only, and this form does not resolve the caller's role to hide itself: the
// members section beside it states the rule this follows — a control hidden to avoid
// provoking a refusal replaces an answer a person can act on with a control they
// cannot find. `invite.permission_denied` renders where it was raised, with the one
// remedy the console has for it.
//
// THE TOKEN EXISTS EXACTLY ONCE, WHICH DECIDES THE WHOLE SHAPE OF THE SETTLEMENT
//
// `InviteCreateResponse` carries the plaintext token, and only its hash is persisted
// (`Spec-002 §Token Security Properties`): no later read can recover it, and the
// invites list deliberately does not carry one. So a mint does not simply add a row
// and finish — it produces something that is on screen or gone, and the reveal below
// is the only moment the link exists. Putting the invitation away is therefore a
// deliberate act with a sentence attached, never a settlement that fades.
//
// AND THE LINK IS COMPOSED FROM A SECOND READ, TAKEN INSIDE THE SAME ACT
//
// `Spec-002 §Invite Delivery` writes the link as
// `https://<control-plane-host>/invite/<token>`, and nothing on the shipped bridge
// tells this renderer its own control-plane host. That is the growth port's
// `controlPlaneHostRead`, asked at the PRESS rather than on mount: a read performed
// for every visit to this section would ask a question no one needed answered, and an
// intent to invite somebody is what makes the answer worth having. It is asked as
// part of the mint rather than after it, and `invite-mint.ts` is where that act lives
// and where the ordering argument is written down — the short of it being that the
// coordinator's latch has to cover the whole act, and that a token held across one
// more await is a credential that can be stranded. A host that refuses leaves the
// invitation minted and real: the reveal shows the token's own identifier and says
// the link could not be composed, which is the truth rather than a link with a
// guessed host in it — and it offers the one act that still fixes it, a retry of the
// host read composing from the token the reveal is holding. `use-minted-invite.ts`
// owns that holding, and says why the token outlives the press that produced it.
//
// THE LEDGER IS RE-READ RATHER THAN WRITTEN INTO. `InviteCreateResponse` carries no
// `state` and no `joinMode`, so folding a row in would mean the renderer composing
// two members the wire did not send. One re-read at the moment a person acted is the
// honest alternative, and it is not a scheduled refresh — nothing here polls.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import type { JoinMode } from "@ai-sidekicks/contracts";

import {
  consoleClockFor,
  heldIdAsWireId,
  type ConsoleBridge,
  type DaemonRequestOf,
  type GrowthOutcome,
  type GrowthReading,
} from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { useGrowthReadOnMount } from "../../seats/index.js";
import {
  DEFAULT_INVITE_EXPIRY_ID,
  DEFAULT_JOIN_MODE,
  INVITE_EXPIRY_CHOICES,
  JOIN_MODES,
  JOIN_MODE_NOTES,
  inviteExpiryChoice,
  inviteExpiryInstant,
} from "./invite-draft.js";
import { inviteMintWithLink } from "./invite-mint.js";
import { inviteCreateRemedy } from "./invite-refusal-copy.js";
import { InviteLinkReveal } from "./InviteLinkReveal.js";
import { useMintedInvite } from "./use-minted-invite.js";
import {
  WireMutationCoordinator,
  daemonMutation,
  useWireMutation,
} from "../mutation-coordinator.js";

/** The wire method the send control calls, through the daemon gateway. */
const INVITE_CREATE_METHOD = "invite.create";

/** The coordinator's subject key. One mint at a time, so one key. */
const CREATE_INVITE_KEY = "create-invite";

/** Names a refusal the identity read itself did not name. */
const CREATE_INVITE_ORIGIN = "create-invite";

/** What one mint asks for, read off the call door's own registry rather than declared. */
type InviteCreateRequest = DaemonRequestOf<typeof INVITE_CREATE_METHOD>;

/** What one `callerParticipantRead` answers, and the arms around that answer. */
type CallerIdentityReading = GrowthReading<GrowthOutcome<{ readonly participantId: string }>>;

/** Which participant this window is, or why that could not be read. */
type CallerIdentity =
  | { readonly status: "read"; readonly participantId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The identity read, projected onto what this form asks of it.
 *
 * `undefined` stays the not-yet-answered absence the seat publishes, so the form
 * still tells "still coming" from "the port said no" — the two renderings below are
 * different shapes and collapsing them would close the send control with no sentence.
 */
function callerIdentityFrom(
  reading: CallerIdentityReading | undefined,
): CallerIdentity | undefined {
  if (reading === undefined) {
    return undefined;
  }
  if (reading.kind === "unreadable") {
    return { status: "refused", refusal: reading.refusal };
  }
  return reading.outcome.status === "served"
    ? { status: "read", participantId: reading.outcome.value.participantId }
    : { status: "refused", refusal: reading.outcome };
}

export interface CreateInviteProps {
  readonly bridge: ConsoleBridge;
  /** The session an invitation would be into. `undefined` means nothing to invite to. */
  readonly sessionId: string | undefined;
  /** Ask the ledger beside this form to read itself again. Called once per mint. */
  readonly onMinted: () => void;
}

export function CreateInvite(props: CreateInviteProps): React.JSX.Element {
  const { bridge, sessionId, onMinted } = props;
  const [joinMode, setJoinMode] = useState<JoinMode>(DEFAULT_JOIN_MODE);
  const [expiryId, setExpiryId] = useState<string>(DEFAULT_INVITE_EXPIRY_ID);

  // Held against the exact subject it belongs to, on the ledger's rule beside this
  // form: an identity read answers about ONE session's roster, so a window that moves
  // while it is unsettled must not show the arriving session what the one it left was
  // told. Through the growth-read seat rather than a hand-rolled effect: this is
  // exactly the ask-once-per-subject read four surfaces in two view families already
  // share, and a second copy would be a second answer to when a read is re-asked.
  const identity = callerIdentityFrom(
    useGrowthReadOnMount({
      bridge,
      subject: sessionId,
      request: sessionId === undefined ? undefined : { sessionId },
      origin: CREATE_INVITE_ORIGIN,
      ask: (readBridge, request) => readBridge.growth.callerParticipantRead(request),
    }),
  );
  // And what the mint produced, which is the same rule over a longer-lived value —
  // its own module, because a token that outlives the press has a lifetime worth
  // stating rather than a `useState` a reader has to reconstruct.
  const {
    minted,
    isComposingLink,
    hold: holdMinted,
    release,
    composeLink,
  } = useMintedInvite(bridge, sessionId);

  const coordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        // The MINT AND ITS LINK, not the mint alone. The latch this coordinator holds
        // is what closes the send control, so an act that settled halfway would
        // re-open the control over a token still waiting to be revealed.
        perform: inviteMintWithLink(bridge, daemonMutation(bridge, INVITE_CREATE_METHOD)),
        describeWhat: "The invitation",
      }),
    // Keyed on the subject for the ledger's reason: an unsettled mint in the session
    // being left must not close the send control in the session being entered.
    [bridge, sessionId],
  );
  const mutation = useWireMutation(coordinator);

  useEffect(() => {
    // Superseded rather than dropped: an unsettled call whose caller has gone would
    // otherwise resolve into whichever form is on screen now.
    return () => {
      coordinator.supersede();
    };
  }, [coordinator]);

  const send = useCallback(() => {
    if (sessionId === undefined || identity?.status !== "read") {
      return;
    }
    const choice = inviteExpiryChoice(expiryId);
    const expiresAt = inviteExpiryInstant(consoleClockFor(bridge).now(), choice.days);
    const request: InviteCreateRequest = {
      sessionId: heldIdAsWireId(sessionId),
      inviter: heldIdAsWireId(identity.participantId),
      joinMode,
      expiresAt,
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
      holdMinted({
        inviteId: settlement.inviteId,
        expiresAt: settlement.expiresAt,
        joinMode,
        link: settlement.link,
      });
      onMinted();
    });
  }, [bridge, coordinator, expiryId, holdMinted, identity, joinMode, onMinted, sessionId]);

  if (sessionId === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="There is no session to invite anyone to."
        detail="An invitation is issued into one session, and this section is not holding one."
      />
    );
  }

  if (minted !== undefined) {
    return (
      <InviteLinkReveal
        minted={minted}
        isComposingLink={isComposingLink}
        onCopy={(link) => bridge.sidekicks.native.copyToClipboard(link)}
        onComposeLink={composeLink}
        onDone={release}
      />
    );
  }

  const refusal = mutation.refusalByKey[CREATE_INVITE_KEY];
  const isSending = mutation.pendingKey !== undefined;

  return (
    <section className="meridian-invite-create" aria-label="Invite someone to this session">
      <h4 className="meridian-invite-create__title">Invite someone</h4>

      <RadioGroup
        className="meridian-invite-create__choices"
        aria-label="What the invitation grants"
        value={joinMode}
        onValueChange={(value: unknown) => {
          if (isJoinMode(value)) {
            setJoinMode(value);
          }
        }}
      >
        {JOIN_MODES.map((mode) => (
          <label key={mode} className="meridian-invite-create__choice">
            <Radio.Root value={mode} className="meridian-invite-create__control">
              <Radio.Indicator className="meridian-invite-create__indicator" />
            </Radio.Root>
            <span className="meridian-invite-create__text">
              <span className="meridian-invite-create__label">{mode}</span>
              <span className="meridian-invite-create__note">{JOIN_MODE_NOTES[mode].grants}</span>
            </span>
          </label>
        ))}
      </RadioGroup>

      <RadioGroup
        className="meridian-invite-create__choices meridian-invite-create__choices--inline"
        aria-label="How long the link works"
        value={expiryId}
        onValueChange={(value: unknown) => {
          if (typeof value === "string") {
            setExpiryId(value);
          }
        }}
      >
        {INVITE_EXPIRY_CHOICES.map((choice) => (
          <label key={choice.id} className="meridian-invite-create__choice">
            <Radio.Root value={choice.id} className="meridian-invite-create__control">
              <Radio.Indicator className="meridian-invite-create__indicator" />
            </Radio.Root>
            <span className="meridian-invite-create__label">{choice.label}</span>
          </label>
        ))}
      </RadioGroup>

      <div className="meridian-invite-create__acts">
        <button
          type="button"
          className="meridian-invite-create__send"
          onClick={send}
          disabled={isSending || identity?.status !== "read"}
        >
          {isSending ? "Minting…" : "Create a link"}
        </button>
      </div>

      {identity === undefined ? (
        <Nothing
          kind="not-loaded"
          placement="inline"
          title="Reading which participant this window is."
        />
      ) : null}
      {identity?.status === "refused" ? (
        <InlineRefusal code={identity.refusal.code} detail={identity.refusal.detail} />
      ) : null}
      {refusal === undefined ? null : (
        <>
          <InlineRefusal
            code={refusal.code}
            detail={refusal.detail}
            action={
              <button
                type="button"
                className="meridian-invite-create__refusal-dismiss"
                onClick={() => {
                  coordinator.dismiss(CREATE_INVITE_KEY);
                }}
              >
                Dismiss
              </button>
            }
          />
          {inviteCreateRemedy(refusal.code) === undefined ? null : (
            <p className="meridian-invite-create__remedy">{inviteCreateRemedy(refusal.code)}</p>
          )}
        </>
      )}
    </section>
  );
}

/** Whether a value is one of the wire's three join modes. */
function isJoinMode(value: unknown): value is JoinMode {
  return typeof value === "string" && Object.hasOwn(JOIN_MODE_NOTES, value);
}
