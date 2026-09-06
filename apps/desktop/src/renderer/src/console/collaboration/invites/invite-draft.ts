// What a person chooses when they mint an invitation, and what the wire does with it.
//
// The create form's model, with no React in it: the two closed vocabularies a
// person picks from, the one composition that turns a choice into the registered
// request, the one that turns a minted token into the link it is sent as, and the
// remedy sentence each refusal the create path can take has. A case drives every one
// of them without mounting anything.
//
// WHY THE INVITER IS READ AND NEVER CHOSEN. `InviteCreate` requires `inviter`, and
// `Spec-002 §Interfaces And Contracts` binds it server-side to the authenticated
// caller — the body's value is not trusted. So the console supplies the id the
// caller-identity read gave it for ITSELF, which is the one value that cannot
// disagree with what the daemon resolves; a form that offered a choice of inviter
// would be offering a claim the wire discards.
//
// WHY THE EXPIRY IS A CLOSED LIST AND NOT A DATE FIELD. The wire takes an instant,
// and the only anchor the corpus fixes is the `7d` default
// (`Spec-002 §Default Behavior`). A free-form entry would put a calendar, a time,
// and a timezone in front of a person to express a duration — three chances to send
// an invitation that expires in the past.

import type { JoinMode } from "@ai-sidekicks/contracts";

import { MILLISECONDS_PER_DAY } from "../../core/index.js";

/** What one join mode gives the person who accepts it. */
export interface JoinModeNotes {
  /** One sentence, present tense. What they will be able to do. */
  readonly grants: string;
}

/**
 * The three join modes, and what each one grants.
 *
 * A `Record` keyed by the contract's own `JoinMode`, on the membership-role notes'
 * precedent next door: the compiler holds the table to exactly the wire's three
 * values, so a mode added to the enum fails here rather than rendering as a bare
 * identifier with no sentence beside it.
 *
 * NOT THE MEMBERSHIP ROLES. `JoinMode` is `viewer | collaborator | runtime
 * contributor` and `MembershipRole` carries `owner` beside those three — an
 * invitation cannot grant ownership, and a form that read from the role table would
 * offer it.
 */
export const JOIN_MODE_NOTES: Readonly<Record<JoinMode, JoinModeNotes>> = {
  viewer: { grants: "Watches the session and changes nothing in it." },
  collaborator: { grants: "Takes part in runs and answers approvals." },
  "runtime contributor": { grants: "Lends a machine this session's agents can run on." },
};

/**
 * The modes, in the order the form offers them.
 *
 * Read off the notes table rather than written a second time — object key order is
 * insertion order for non-numeric string keys, and the table's own type fixes its
 * keys to exactly `JoinMode`, which is what makes the assertion sound.
 */
export const JOIN_MODES: readonly JoinMode[] = Object.keys(JOIN_MODE_NOTES) as readonly JoinMode[];

/** One expiry a person can pick, and how far ahead it puts the instant. */
export interface InviteExpiryChoice {
  /** Stable across renders; what the radio group's value is. */
  readonly id: string;
  readonly label: string;
  readonly days: number;
}

/**
 * The expiries the form offers, shortest first.
 *
 * Three rather than one, because the default is a default and not a rule: an
 * invitation handed over in person wants a day and one sent to somebody on leave
 * wants a month. Three rather than many, because every extra row is a decision a
 * person has to make about a value the wire does not constrain.
 */
export const INVITE_EXPIRY_CHOICES: readonly InviteExpiryChoice[] = [
  { id: "1d", label: "A day", days: 1 },
  { id: "7d", label: "A week", days: 7 },
  { id: "30d", label: "A month", days: 30 },
];

/**
 * The one the form starts on: `Spec-002 §Default Behavior`'s `7d`.
 *
 * Named rather than "the middle row", so re-ordering the list above cannot silently
 * move the default off the value the corpus fixes.
 */
export const DEFAULT_INVITE_EXPIRY_ID = "7d";

/** The choice with this id, or the default where a caller holds a stale one. */
export function inviteExpiryChoice(id: string): InviteExpiryChoice {
  return (
    INVITE_EXPIRY_CHOICES.find((choice) => choice.id === id) ??
    // Total by construction: the default id is one of the three above, and a caller
    // holding an id from a list that has since changed gets the corpus's own default
    // rather than a crash or an invitation with no expiry at all.
    INVITE_EXPIRY_CHOICES[1]!
  );
}

/**
 * The instant an invitation picked now stops working, in the wire's own form.
 *
 * `toISOString` is the Z-suffixed UTC form, which is what `z.iso.datetime({offset:
 * true})` accepts — the offset option WIDENS the accepted set rather than requiring
 * one. The clock is passed in rather than read here, so the fixture's frozen clock
 * produces a stable instant and a screenshot of a minted invitation does not change
 * every time it is taken.
 */
export function inviteExpiryInstant(nowMilliseconds: number, days: number): string {
  return new Date(nowMilliseconds + days * MILLISECONDS_PER_DAY).toISOString();
}

/**
 * The link an invitation is actually sent as.
 *
 * `Spec-002 §Invite Delivery` fixes the form — `https://<control-plane-host>/invite/
 * <token>` — and this is the console's one composition of it. The host arrives from
 * the node's own read and the token from the create reply, so neither half is
 * guessed; a host carrying a scheme or a path would produce a malformed link, which
 * is why the read that supplies it is contracted to answer a bare host.
 */
export function composeInviteLink(host: string, token: string): string {
  return `https://${host}/invite/${token}`;
}
