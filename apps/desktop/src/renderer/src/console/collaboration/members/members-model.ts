// What a membership row is, what changing one costs, and which refusals have a
// remedy worth printing.
//
// THE FOUR ROLES ARE THE WIRE'S FOUR
//
// `MembershipRole` in `packages/contracts/src/session.ts` is
// `owner | viewer | collaborator | runtime contributor`, and `runtime
// contributor` carries the space in its wire form. This module holds the console's
// notes ABOUT those four and never a fifth: the notes table is keyed by the wire
// union, so a role added to the contract fails this file to compile rather than
// rendering as a row with no explanation, and a role invented here has nowhere to
// go.
//
// THE CONSEQUENCE COPY IS THE POINT
//
// `Spec-002 §Default Behavior` gives revocation two different costs depending on
// the role, and neither is recoverable: a runtime contributor's active runs are
// interrupted and their node detaches, and a collaborator's pending interventions
// expire at once with read access ending after a thirty-second grace window. A
// confirmation that says "are you sure" and not WHAT HAPPENS is a dialog that
// trains people to press through it.
//
// WHY A ROW'S MEMBERSHIP ID IS STILL OPTIONAL
//
// `membership.update` is keyed by `membershipId`, and NO registered read returns
// one: `presence.read` answers `{participantId, state, lastSeen}` with no role and
// no membership id, and `SessionReadResponse` carries a snapshot and cursors and
// no memberships at all. `MembershipSummary` — the shape that has all three — is
// returned only by `session.create`. Two sources now answer that between them and
// neither closes it: the `membership.created` fold, which reaches every admission
// this window watched and no earlier one, and the membership roster read on the
// growth port, which refuses on a live build until its wire lands. So a row whose
// membership id is absent still renders its facts and says the controls need an
// identifier nothing hands it, and a row that HAS one offers all four actions.
//
// WHICH SOURCE WINS WHERE THEY BOTH SPEAK
//
// The LOG, for a role or a state it has actually stated; the read fills every fact
// the log did not. That is the reverse of what this module said while the fold
// claimed only `membership.created`: with no fold for the other four kinds the log
// could state no state at all and its role was the ADMISSION role forever, so
// deferring to the read was the only honest reading there was. The fold beside this
// one now claims all five (`membership-projector.ts` says how each fact is read), and
// the ordering follows the ordering of the two sources: the read is answered ONCE, on
// mount, and the log is live. A revocation that lands after the read is the newer
// statement, and a read that outranked it would leave a membership that has ended
// reading as one that has not for the rest of the visit — which is the direction that
// matters, because it is the one that offers acts nobody can perform.
//
// The identifier itself is immutable, so the two can only agree about it.

import type { MembershipRole, MembershipState, MembershipUpdate } from "@ai-sidekicks/contracts";

import type { GrowthMembershipRosterEntry } from "../../bridge/index.js";
import type { ConsoleEntity } from "../../store/index.js";

/** What the console has to say about one role, beyond its name. */
export interface MembershipRoleNotes {
  /** One clause on what the role may do — the row's subtitle. */
  readonly reach: string;
  /**
   * What revoking this role costs, stated in the confirmation.
   *
   * `undefined` where the wire contract names no cost beyond the membership
   * ending — deliberately not an empty string, which would render as a blank
   * line where a person is looking for the consequence.
   */
  readonly revocationCost: string | undefined;
}

/**
 * The four roles and their notes.
 *
 * A `Record` keyed by the wire union rather than an array of pairs: the record is
 * exhaustive by construction, so this table cannot fall behind the contract, and
 * the closed set is declared exactly once for the whole family.
 */
export const MEMBERSHIP_ROLE_NOTES: Readonly<Record<MembershipRole, MembershipRoleNotes>> = {
  owner: {
    reach: "Runs the session and is the only role that can change a membership.",
    revocationCost: undefined,
  },
  collaborator: {
    reach: "Takes part in runs and answers approvals.",
    revocationCost:
      "Pending interventions expire immediately, and read access ends after a thirty-second grace window.",
  },
  "runtime contributor": {
    reach: "Lends a machine this session's agents can run on.",
    revocationCost:
      "Active runs on this contributor's node are interrupted, and the node is detached.",
  },
  viewer: {
    reach: "Watches the session and changes nothing in it.",
    revocationCost: undefined,
  },
};

/**
 * The roles, in the order the role selector offers them.
 *
 * Read off the notes table rather than written a second time. Object key order
 * is insertion order for non-numeric string keys, so the order above IS this
 * order, and the assertion is sound because the table's own type fixes its keys
 * to exactly `MembershipRole`.
 */
export const MEMBERSHIP_ROLES: readonly MembershipRole[] = Object.keys(
  MEMBERSHIP_ROLE_NOTES,
) as readonly MembershipRole[];

/** Whether a value is one of the wire's four roles. */
export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && Object.hasOwn(MEMBERSHIP_ROLE_NOTES, value);
}

/**
 * The four membership states, as the wire declares them.
 *
 * A record for the same reason the roles are one: `MembershipState` is
 * `pending | active | suspended | revoked`, and the console's business with it is
 * to say whether the membership is still doing anything — a suspended member is
 * visibly still a row, which is the whole reason the state renders beside the
 * role instead of removing the row.
 */
export const MEMBERSHIP_STATE_IS_LIVE: Readonly<Record<MembershipState, boolean>> = {
  pending: true,
  active: true,
  suspended: false,
  revoked: false,
};

/** One membership as the section renders it. */
export interface MembershipRow {
  /** Wire-verbatim, and the row's identity on screen. */
  readonly participantId: string;
  /** Present only when a read carried one; the four actions need it. */
  readonly membershipId: string | undefined;
  readonly role: MembershipRole | undefined;
  readonly state: MembershipState | undefined;
}

/** Whether a value is one of the wire's four membership states. */
export function isMembershipState(value: unknown): value is MembershipState {
  return typeof value === "string" && Object.hasOwn(MEMBERSHIP_STATE_IS_LIVE, value);
}

/** The four things an owner can ask of one membership. */
export const MEMBERSHIP_ACTIONS = ["change_role", "suspend", "reactivate", "revoke"] as const;

/** One membership action. Derived from the enumeration, never restated. */
export type MembershipAction = (typeof MEMBERSHIP_ACTIONS)[number];

/**
 * The actions whose request carries nothing beyond the membership it names.
 *
 * Subtracted from the wire union rather than re-listed, so an arm that later
 * grows a second member leaves this type by itself instead of continuing to be
 * dispatched without the member it now needs. A control that has no second
 * member to collect is the only kind a menu press can send outright.
 */
export type ArgumentFreeMembershipAction = Exclude<
  MembershipUpdate,
  { newRole: MembershipRole }
>["action"];

/** What each action's control says, and how loudly. */
export interface MembershipActionNotes {
  readonly label: string;
  /** `true` where the act is not undone by pressing the opposite control. */
  readonly isDestructive: boolean;
}

export const MEMBERSHIP_ACTION_NOTES: Readonly<Record<MembershipAction, MembershipActionNotes>> = {
  change_role: { label: "Change role", isDestructive: false },
  suspend: { label: "Suspend", isDestructive: false },
  reactivate: { label: "Reactivate", isDestructive: false },
  revoke: { label: "Revoke", isDestructive: true },
};

/**
 * Remedies for the refusals this surface can provoke, keyed by wire code.
 *
 * A RENDERING table, never a producer: the daemon's code renders verbatim
 * whatever it is, and a code absent from this table simply gets no extra
 * sentence. Nothing here is ever sent, so the console cannot invent a refusal by
 * knowing about one. `Spec-002 §Required Behavior` is what makes the last-owner
 * remedy printable — transfer ownership first — and it is the one refusal a
 * person cannot act on without being told.
 */
export const MEMBERSHIP_REFUSAL_REMEDIES: Readonly<Record<string, string>> = {
  "membership.permission_denied": "Only an owner can change a membership.",
  "membership.last_owner":
    "This is the last owner. Make somebody else an owner first, then this membership can be given up.",
  "membership.not_found": "That membership is gone. The list is out of date.",
};

/** The remedy for a refusal code, or `undefined` where the console has nothing to add. */
export function membershipRefusalRemedy(code: string): string | undefined {
  return Object.hasOwn(MEMBERSHIP_REFUSAL_REMEDIES, code)
    ? MEMBERSHIP_REFUSAL_REMEDIES[code]
    : undefined;
}

/**
 * Whether this row is the only owner left.
 *
 * Rendered as a NOTE and never as a reason to withhold a control: the daemon
 * decides, and `membership.last_owner` is the answer a person is entitled to see
 * in place. Counting here would be a second authority on a rule whose inputs this
 * console does not fully hold — a row whose role never arrived is counted as no
 * owner, which is exactly why the note is advisory.
 */
export function isLastRemainingOwner(row: MembershipRow, rows: readonly MembershipRow[]): boolean {
  if (row.role !== "owner") {
    return false;
  }
  return rows.filter((candidate) => candidate.role === "owner").length === 1;
}

/**
 * Rows from the session store's projected participants, and from the roster read.
 *
 * Neither source is filled in from the other and nothing is defaulted: `undefined`
 * is the honest value for a fact neither an event nor a read has stated, and the row
 * renders it as an absence rather than as a role somebody has. A value the read
 * carried but the console cannot recognise — a fifth role, a fifth state — is
 * treated as unstated for the same reason, because a chip drawn from an unrecognised
 * string is the console asserting a vocabulary it does not have.
 *
 * The ORDER is the store's, then whoever the read named and the store did not. A
 * person the read names and the log never saw is a membership like any other, and
 * dropping them would hide exactly the rows this read exists to reach.
 */
export function deriveMembershipRows(
  participantEntities: Readonly<Record<string, ConsoleEntity>>,
  rosterEntries: ReadonlyMap<string, GrowthMembershipRosterEntry> = new Map(),
): readonly MembershipRow[] {
  const projected = Object.values(participantEntities).map((entity) =>
    mergeMembershipRow(rowFromEntity(entity), rosterEntries.get(entity.id)),
  );
  const projectedIds = new Set(projected.map((row) => row.participantId));
  const readOnly = [...rosterEntries.values()]
    .filter((entry) => !projectedIds.has(entry.participantId))
    .map((entry) => mergeMembershipRow(unprojectedRow(entry.participantId), entry));
  return [...projected, ...readOnly];
}

/**
 * Whether this membership is one a session can still address.
 *
 * `undefined` IS LIVE, and that asymmetry is the whole rule. A state neither source
 * has stated is exactly the ordinary case — `membership.created` states none by
 * design, and the roster read refuses until its wire lands — so reading absence as
 * "not live" would empty every surface that asks this question in a console that is
 * working. What the predicate is for is the row that has been stated ENDED, and
 * `MEMBERSHIP_STATE_IS_LIVE` is where those two values are declared.
 */
export function isLiveMembership(row: MembershipRow): boolean {
  return row.state === undefined || MEMBERSHIP_STATE_IS_LIVE[row.state];
}

/**
 * The participants of this session's live memberships, from the log alone.
 *
 * The one derivation behind every surface that offers an ACT against another member —
 * the direct-channel picker is the first — as opposed to the surfaces that report on
 * memberships, which render the ended ones too because a suspended membership is
 * still a row. Both go through {@link deriveMembershipRows}, so a surface offering an
 * act and a surface reporting one can never disagree about who is in the session.
 *
 * The roster read is deliberately not a parameter: the picker's own section holds no
 * membership read, and a second call to the one the members section already performs
 * would be two reads answering one question in one window.
 */
export function liveMembershipParticipantIds(
  participantEntities: Readonly<Record<string, ConsoleEntity>>,
): readonly string[] {
  return deriveMembershipRows(participantEntities)
    .filter(isLiveMembership)
    .map((row) => row.participantId);
}

/** What the log alone says about one participant. */
function rowFromEntity(entity: ConsoleEntity): MembershipRow {
  const body = entity.body;
  const membershipId = body?.["membershipId"];
  const role = body?.["role"];
  return {
    participantId: entity.id,
    membershipId: typeof membershipId === "string" ? membershipId : undefined,
    role: isMembershipRole(role) ? role : undefined,
    state: isMembershipState(entity.state) ? entity.state : undefined,
  };
}

/**
 * One row's two sources, resolved by the rule the header states.
 *
 * Written as one function rather than three coalescing expressions at the call site
 * so the precedence is stated once: an entry that carried nothing leaves the log's
 * row exactly as it was, which is what makes a refused read cost the ledger nothing.
 *
 * The log leads on role and state and the read fills the absences, because the read
 * is answered once on mount and the log keeps arriving. `undefined` on the logged side
 * is the honest "the log has not said", never "the log says nothing is there", so the
 * fallback is a coalesce rather than a branch on which source is present.
 */
function mergeMembershipRow(
  logged: MembershipRow,
  entry: GrowthMembershipRosterEntry | undefined,
): MembershipRow {
  if (entry === undefined) {
    return logged;
  }
  return {
    participantId: logged.participantId,
    membershipId: entry.membershipId,
    role: logged.role ?? (isMembershipRole(entry.role) ? entry.role : undefined),
    state: logged.state ?? (isMembershipState(entry.state) ? entry.state : undefined),
  };
}

/** A row the log never projected: the participant, and three facts it cannot state. */
function unprojectedRow(participantId: string): MembershipRow {
  return { participantId, membershipId: undefined, role: undefined, state: undefined };
}
