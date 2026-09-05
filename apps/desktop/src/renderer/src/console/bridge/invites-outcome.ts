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

import type { ConsoleBridge } from "./console-bridge.js";

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
