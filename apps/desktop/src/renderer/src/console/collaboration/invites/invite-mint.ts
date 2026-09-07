// One press, one act: the host read, the mint, and the link the two compose.
//
// WHY THE WHOLE ACT IS ONE CALL AND NOT TWO IN A ROW
//
// `InviteCreateResponse` hands the plaintext token back exactly once and only its
// hash is persisted (`Spec-002 §Token Security Properties`). No later read recovers
// it and the invites ledger deliberately carries none, so a settlement dropped here
// is a lost CREDENTIAL rather than a stale row — and that decides the shape twice.
//
// FIRST, THE UNIT THE LATCH HOLDS IS THE WHOLE ACT. The coordinator's single-flight
// latch is what closes the send control, and it opens again the moment the call it
// wraps settles. With the mint alone inside it, the control re-opened while the first
// token was still waiting on the host read: a second press minted a second invitation
// and the two continuations raced for the one reveal slot the form holds, so whichever
// lost was a token nothing could ever show again. Handing the coordinator the whole
// act is what makes the control the form DRAWS and the rule the coordinator ENFORCES
// the same rule rather than two readings of it.
//
// SECOND, THE HOST IS READ BEFORE THE TOKEN EXISTS. Given a single-flight unit either
// order is safe against a second press, so the order is settled on the other question:
// what happens to a token that has already been minted. Read the host afterwards and
// the token is held across another await — a read that hangs, throws, or is superseded
// strands a real invitation whose one-time token nothing on this window can still
// show. Read it first and no token exists until the composition that reveals it can
// run to its end with no further await in front of it, so the failure the other order
// has to argue its way out of has no window to happen in. The price is one host read
// on a press the daemon goes on to refuse: a read nobody needed, against a credential
// nobody has.
//
// A HOST THAT REFUSES IS NOT A FAILED MINT. `Spec-002 §Invite Delivery` writes the
// link as `https://<control-plane-host>/invite/<token>` and this console guesses
// neither half, so a refusing host read travels BESIDE the invitation rather than
// replacing it: the mint still goes and the reveal shows the identifier and says the
// link could not be composed. Refusing the whole act on it would throw away an
// invitation the daemon was willing to issue.

import { type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import { composeInviteLink } from "./invite-draft.js";
import { type MintedInviteLink } from "./InviteLinkReveal.js";
import { type WireMutation } from "../mutation-coordinator.js";

/** Names a refusal the host read itself did not name. */
const INVITE_MINT_ORIGIN = "create-invite";

/**
 * The three members the create reply carries, as this composition consumes them.
 *
 * A CONSTRAINT and not a second declaration of the wire's reply: the mint handed in
 * below is bound to the call door's own registry by its caller, so the registered
 * response has to satisfy this shape at that call site — a reply that stopped
 * carrying the token would fail there rather than compose a link around `undefined`.
 */
export interface InviteMintReply {
  readonly inviteId: string;
  /** The plaintext token, which exists here and nowhere else after this call. */
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * What one settled act produces: the invitation, and the link it is sent as.
 *
 * THE TOKEN IS DELIBERATELY NOT A MEMBER. It is consumed by the composition inside
 * this module and never leaves it, so no caller holds a plaintext credential it has
 * no use for — the reveal renders it only inside the link.
 */
export interface InviteMintReceipt {
  /** Wire-verbatim, from the create reply. */
  readonly inviteId: string;
  /** ISO 8601, wire-verbatim — the reply's own, not the one that was asked for. */
  readonly expiresAt: string;
  readonly link: MintedInviteLink;
}

/** The host this node composes links against, or why it could not be read. */
type ControlPlaneHostReading =
  | { readonly status: "read"; readonly host: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The mint and its link as one call, for the coordinator to hold one latch over.
 *
 * The mint is passed in rather than bound here, so the binding to the call door's own
 * registry stays where every other mutation in this family makes it and this module
 * adds only the composition. Both type parameters are inferred from that argument:
 * the request travels through untouched, and the reply is held to
 * {@link InviteMintReply} at the call site.
 */
export function inviteMintWithLink<TRequest, TReply extends InviteMintReply>(
  bridge: ConsoleBridge,
  mint: WireMutation<TRequest, TReply>,
): WireMutation<TRequest, InviteMintReceipt> {
  return async (request) => {
    const host = await readControlPlaneHost(bridge);
    const reply = await mint(request);
    if (reply.status === "refused") {
      // The daemon's own refusal, unchanged. A host that refused before it is not
      // mentioned: nothing was minted, so there is no link to have failed to compose
      // and reporting one would name a second reason for a single refusal.
      return reply;
    }
    return {
      status: "served",
      value: {
        inviteId: reply.value.inviteId,
        expiresAt: reply.value.expiresAt,
        link: inviteLinkFrom(host, reply.value.token),
      },
    };
  };
}

/**
 * This node's control-plane host, asked once per press.
 *
 * The port's contract is that it RESOLVES with an outcome, so a rejection has no arm
 * in that vocabulary and is widened into one here rather than left to propagate: an
 * unhandled rejection would take the whole act down with it and mint nothing, which
 * turns a link this console could not compose into an invitation it refused to issue.
 */
async function readControlPlaneHost(bridge: ConsoleBridge): Promise<ControlPlaneHostReading> {
  try {
    const outcome = await bridge.growth.controlPlaneHostRead({});
    return outcome.status === "served"
      ? { status: "read", host: outcome.value.host }
      : { status: "refused", refusal: outcome };
  } catch (rejection: unknown) {
    return { status: "refused", refusal: consoleRefusalFrom(rejection, INVITE_MINT_ORIGIN) };
  }
}

/** The link this token is sent as, or the reason there is not one. */
function inviteLinkFrom(host: ControlPlaneHostReading, token: string): MintedInviteLink {
  return host.status === "read"
    ? { status: "composed", url: composeInviteLink(host.host, token) }
    : { status: "refused", refusal: host.refusal };
}
