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
// AND THAT ORDER IS WHAT LETS A REFUSING HOST END THE ACT BEFORE ANYTHING IS SPENT.
// `Spec-002 §Invite Delivery` writes the link as `https://<control-plane-host>/invite/
// <token>` and this console guesses neither half, so a host it could not read is a
// link it cannot write. Minting anyway and reporting the missing half beside the
// invitation sounds like the generous reading — the daemon was willing to issue it —
// but what it actually produces is an ACTIVE invitation nobody can ever send: the
// token is gone the moment this window stops holding it, the ledger carries none, no
// later read recovers one, and the row stays pending against the session's own cap
// until somebody notices and revokes it. So the refusal travels instead of the mint:
// nothing is created, the host's own refusal renders on the control that was pressed,
// and the control re-opens. Pressing again IS the retry, and it costs nothing, because
// the first press left nothing behind to reconcile.
//
// AND THE SUPERVISOR IS ASKED AGAIN AT THAT SAME BOUNDARY, for the reason the ordering
// argument above already establishes: the host read is a real round trip, so a runtime
// that was serving when the press was admitted may have stopped by the time it answers.
// A press is guarded where it is dispatched, and that guard reads a value as old as the
// render that offered the control; this second reading is taken after the await and
// before the mint, so a stopped runtime ends the act on the abort path the refusing host
// already takes rather than receiving a write it cannot serve.
//
// WHICH IS WHY A MINTED TOKEN IS NEVER HELD ANYWHERE. Past both aborts a host has
// answered, so {@link composeInviteLink} runs in the same turn the reply lands in,
// with no await in front of it: the link exists by the time the receipt does, and the
// plaintext leaves this module inside it and in no other form.

import { type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import { shellBlockRefusal, type ShellMutationBlock } from "../../store/index.js";
import { composeInviteLink } from "./invite-draft.js";
import { type WireMutation } from "../mutation-coordinator.js";

/** Names a refusal the host read itself did not name. */
const INVITE_MINT_ORIGIN = "create-invite";

// THE SHELL'S OWN REFUSAL IS NOT THIS MODULE'S TO NAME, and it used to be: the origin
// string and the predicate that recognises one both lived here, which was right while
// this was the only act that aborted on a block. It is not — the ledger's ask answer
// aborts on the same condition — so both moved to `store/shell-mutation-block.ts`,
// which owns the condition, and this module composes the refusal through
// `shellBlockRefusal` rather than spelling an origin of its own.

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
 * THE TOKEN IS DELIBERATELY NOT A MEMBER HERE, and after the abort above it does not
 * need to be: an act that settles has read a host, so the composition inside this
 * module consumed the plaintext and never let it out. What a caller holds is the
 * link — the one form of the credential anybody has a use for — so no surface above
 * this one is holding a token it cannot spend.
 */
export interface InviteMintReceipt {
  /** Wire-verbatim, from the create reply. */
  readonly inviteId: string;
  /** ISO 8601, wire-verbatim — the reply's own, not the one that was asked for. */
  readonly expiresAt: string;
  /** `https://<control-plane-host>/invite/<token>`, composed and complete. */
  readonly link: string;
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
 *
 * `readShellBlock` is the SECOND ask of a question the caller already asked once, and
 * the await above is why there has to be one: the host read is a real round trip, and a
 * supervisor that was serving when the press was admitted can have stopped by the time
 * it answers. Read as a function rather than taken as a value for the same reason — a
 * block handed in here is the caller's render-time answer, which is exactly the stale
 * reading this re-check exists to replace.
 */
export function inviteMintWithLink<TRequest, TReply extends InviteMintReply>(
  bridge: ConsoleBridge,
  mint: WireMutation<TRequest, TReply>,
  readShellBlock: () => ShellMutationBlock | undefined,
): WireMutation<TRequest, InviteMintReceipt> {
  return async (request) => {
    const host = await readControlPlaneHost(bridge);
    if (host.status === "refused") {
      // BEFORE the mint, which is the whole point of reading the host first: an
      // invitation issued here could never be sent, so the act refuses whole and the
      // console's ledger, the session's pending cap, and the daemon are all left
      // exactly as this press found them.
      return { status: "refused", refusal: host.refusal };
    }
    const shellBlock = readShellBlock();
    if (shellBlock !== undefined) {
      // The same abort, for the same reason, at the other boundary this act crosses:
      // the runtime stopped while the host read was out, so the mint below would be a
      // write put through a supervisor that is no longer serving. It ends here rather
      // than in a refusal from the daemon, which is not reachable to give one — and
      // nothing has been spent, so pressing again once the runtime is back IS the
      // retry, exactly as it is for a host that could not be read.
      //
      // REFUSED, AND NOT RETAINED. The refused arm is what ends the act with nothing
      // put; the refusal it carries is the shell's own words, which the store publishes
      // and the hosting section prints once — so the act's coordinator is told, through
      // `isShellBlockRefusal`, to keep no copy. A copy would be a second register of a
      // condition the store owns, and the one that outlived it: the store clears when
      // the runtime comes back, and a retained refusal would keep saying stopped beside
      // a send control drawn open again.
      return {
        status: "refused",
        refusal: shellBlockRefusal(shellBlock),
      };
    }
    const reply = await mint(request);
    if (reply.status === "refused") {
      // The daemon's own refusal, unchanged. Nothing is added to it: the host
      // answered, so there is no second reason to name.
      return reply;
    }
    return {
      status: "served",
      value: {
        inviteId: reply.value.inviteId,
        expiresAt: reply.value.expiresAt,
        link: composeInviteLink(host.host, reply.value.token),
      },
    };
  };
}

/**
 * This node's control-plane host, asked once per press.
 *
 * The port's contract is that it RESOLVES with an outcome, so a rejection has no arm
 * in that vocabulary and is widened into one here rather than left to propagate: an
 * unhandled rejection would take the whole act down without a sentence anywhere,
 * which is the one failure worse than the refusal it is standing in for.
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
