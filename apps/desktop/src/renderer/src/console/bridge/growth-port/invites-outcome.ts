// What one `invitesList` call answers, declared where both its consumers can reach it.
//
// Two sibling view families read this operation — `collaboration/` draws the invites
// a session has SENT, `sessions/` draws the ones it has RECEIVED — and each declared
// the outcome and its served row itself, under two names (`SentInvite`,
// `ReceivedInvite`) for one type. Sibling families may not import each other, which
// is exactly the signal that the type belongs below both.
//
// The cost of the two declarations is not hypothetical. Narrow the `invitesList`
// growth signature so the served value is an object rather than a bare array, and
// each family's `["value"][number]` independently resolves to `never`, in a different
// PR, while both go on claiming to derive it from the same operation. Fix one and
// the two families disagree about what a served invite is with nothing to say so.
//
// EVERY MEMBER IS DERIVED FROM THE GROWTH SIGNATURE and none is restated: the door
// exports the bridge and not the port's vocabulary, and a hand-written copy of an
// outcome shape is a second declaration nothing checks against the first.
//
// WHY THIS DIRECTORY AND NOT `growth-values/`. That directory's own door states the
// admission rule this shape satisfies — a shape lands there once it has a second
// reader — so the reason it is not there is mechanical rather than a matter of taste.
// Every member here is derived from `ConsoleBridge`, and `console-bridge.ts` reaches
// `growth-values/index.js` by the path `growth-port/index.js` → `growth-port.ts` →
// `growth-signatures/index.js` → `ledger.ts`. A module in `growth-values/` that
// imported `../console-bridge.js` would close that path into a cycle `no-circular`
// fails, so the next per-operation outcome derived from the bridge belongs here too.

import { parseInstant } from "../../core/index.js";
import type { ConsoleBridge } from "../console-bridge.js";

/** What one `invitesList` call answers: a served list, or the port's refusal. */
export type InvitesListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["invitesList"]>>;

/**
 * One invitation as the port serves it.
 *
 * One name for one type. A sent invitation and a received one are the same wire row
 * read by two surfaces, and naming them apart was what let the two copies drift.
 */
export type ServedInvite = Extract<
  InvitesListOutcome,
  { readonly status: "served" }
>["value"][number];

/** The refusal arm. A `ConsoleRefusal`, so it renders through the one refusal grammar. */
export type InvitesListRefusal = Extract<InvitesListOutcome, { readonly status: "unavailable" }>;

/**
 * When each of these invitations stops working, as instants a wake-up can be armed on.
 *
 * BOTH FAMILIES THAT READ THIS OPERATION NEED IT, which is why it sits beside the row
 * shape rather than in either of them: `sessions/` arms on the invitations a person
 * has RECEIVED and `collaboration/` on the ones a session has SENT, siblings that may
 * not import each other, and the second copy of a parse-and-filter over one wire member
 * is two families disagreeing about which stamps are armable with nothing to say so.
 *
 * Unreadable stamps are dropped rather than defaulted: an expiry this console cannot
 * read is not evidence that the invitation has lapsed, and a `NaN` handed to the
 * wake-up would arm a timer that fires immediately and forever. Such a row keeps
 * rendering as its own state says and shows the wire's own spelling, which is the
 * honest reading of a stamp nobody here could parse.
 *
 * WHICH ROWS ARE PASSED IN IS THE CALLER'S, and it is not the same question on both
 * sides — the shelf arms on what is still waiting, the sent ledger on what the wire
 * calls `pending` — so this filters nothing but unreadable stamps.
 */
export function expiryDeadlinesOf(invites: readonly ServedInvite[]): readonly number[] {
  return invites
    .map((invite) => parseInstant(invite.expiresAt).epochMilliseconds)
    .filter((epochMilliseconds): epochMilliseconds is number => epochMilliseconds !== undefined);
}
