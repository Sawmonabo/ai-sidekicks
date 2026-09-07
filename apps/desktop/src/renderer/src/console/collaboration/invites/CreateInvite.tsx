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
// AND THE LINK IS COMPOSED FROM A SECOND READ, ASKED AT THE MINT
//
// `Spec-002 §Invite Delivery` writes the link as
// `https://<control-plane-host>/invite/<token>`, and nothing on the shipped bridge
// tells this renderer its own control-plane host. That is the growth port's
// `controlPlaneHostRead`, asked AFTER a token exists rather than on mount: a read
// performed for every visit to this section would ask a question no one needed
// answered, and the token is what makes the answer worth having. A host that refuses
// leaves the invitation minted and real — the reveal then shows the token's own
// identifier and says the link could not be composed, which is the truth rather than
// a link with a guessed host in it.
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
  type GrowthOutcome,
  type GrowthReading,
} from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { consoleRefusalFrom, useGrowthReadOnMount } from "../../seats/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import {
  DEFAULT_INVITE_EXPIRY_ID,
  INVITE_EXPIRY_CHOICES,
  JOIN_MODES,
  JOIN_MODE_NOTES,
  composeInviteLink,
  inviteExpiryChoice,
  inviteExpiryInstant,
} from "./invite-draft.js";
import { inviteCreateRemedy } from "./invite-refusal-copy.js";
import { InviteLinkReveal, type MintedInvite } from "./InviteLinkReveal.js";
import {
  WireMutationCoordinator,
  daemonMutation,
  useWireMutation,
} from "../mutation-coordinator.js";

/** The wire method the send control calls, through the daemon gateway. */
const INVITE_CREATE_METHOD = "invite.create";

/** The coordinator's subject key. One mint at a time, so one key. */
const CREATE_INVITE_KEY = "create-invite";

/** Names a refusal the call itself did not name. */
const CREATE_INVITE_ORIGIN = "create-invite";

/**
 * The least this form will offer to grant.
 *
 * Fail-closed rather than convenient: a person who sends without reading the options
 * has invited somebody to watch, and widening that afterwards is a membership change
 * they make deliberately. The reverse default would hand out participation by
 * inattention.
 */
const DEFAULT_JOIN_MODE: JoinMode = "viewer";

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

  // Both held against the exact subject they belong to, on the ledger's rule beside
  // this form: an identity read answers about ONE session's roster, and a minted
  // token belongs to the session it was minted in — a window that moves while either
  // is unsettled must not show the arriving session what the one it left produced.
  // Through the growth-read seat rather than a hand-rolled effect: this is exactly
  // the ask-once-per-subject read four surfaces in two view families already share,
  // and a second copy would be a second answer to when a read is re-asked.
  const identity = callerIdentityFrom(
    useGrowthReadOnMount({
      bridge,
      subject: sessionId,
      request: sessionId === undefined ? undefined : { sessionId },
      origin: CREATE_INVITE_ORIGIN,
      ask: (readBridge, request) => readBridge.growth.callerParticipantRead(request),
    }),
  );
  const { value: minted, publish: publishMinted } = useSubjectScopedState<MintedInvite | undefined>(
    bridge,
    sessionId,
    () => undefined,
  );

  const coordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        perform: daemonMutation(bridge, INVITE_CREATE_METHOD),
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
    void coordinator
      .run(CREATE_INVITE_KEY, {
        sessionId: heldIdAsWireId(sessionId),
        inviter: heldIdAsWireId(identity.participantId),
        joinMode,
        expiresAt,
      })
      .then(async (settlement) => {
        // `undefined` is the refused arm and the superseded one. Either way the
        // reason is on the coordinator's snapshot beside the control that asked, or
        // there is no control left to put one beside.
        if (settlement === undefined) {
          return;
        }
        publishMinted({
          inviteId: settlement.inviteId,
          expiresAt: settlement.expiresAt,
          joinMode,
          link: await readInviteLink(bridge, settlement.token),
        });
        onMinted();
      });
  }, [bridge, coordinator, expiryId, identity, joinMode, onMinted, publishMinted, sessionId]);

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
        onCopy={(link) => bridge.sidekicks.native.copyToClipboard(link)}
        onDone={() => {
          publishMinted(undefined);
        }}
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

/**
 * The link this token is sent as, or why it could not be composed.
 *
 * Asked once per mint. A refusing host read is not a failed mint — the invitation
 * exists and its identifier is on screen — so the refusal travels beside the token
 * rather than replacing it.
 */
async function readInviteLink(bridge: ConsoleBridge, token: string): Promise<MintedInvite["link"]> {
  try {
    const outcome = await bridge.growth.controlPlaneHostRead({});
    return outcome.status === "served"
      ? { status: "composed", url: composeInviteLink(outcome.value.host, token) }
      : { status: "refused", refusal: outcome };
  } catch (rejection: unknown) {
    return { status: "refused", refusal: consoleRefusalFrom(rejection, CREATE_INVITE_ORIGIN) };
  }
}
