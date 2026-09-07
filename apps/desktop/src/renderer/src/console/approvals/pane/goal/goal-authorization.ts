// Whether this window's participant may change the session's goal — resolved, not
// assumed.
//
// The goal contract makes setting and clearing owner/collaborator operations, so a
// viewer and a runtime contributor are read-only for them. The console does not
// derive that eligibility from anything it happens to be rendering: it reads WHO
// this window is through the caller-identity operation and looks that participant's
// role up in the roster the session's own store already holds. Two facts, one read
// and one lookup, neither guessed.
//
// THE UNKNOWN ANSWER IS ITS OWN ANSWER, not a `false`. A role that is still being
// read and a role that could not be read are different from a role that is known to
// be read-only, so this hook answers `undefined` for both and hands the refusal back
// beside it. A surface renders no control in every one of those cases — the
// fail-closed direction — and renders the refusal's own sentence in the one where
// something actually refused, rather than leaving a person to wonder why a control
// they hold the role for is missing.

import { useCallback, useMemo } from "react";
import type { MembershipRole } from "@ai-sidekicks/contracts";

import {
  membershipRoleOf,
  type ConsoleBridge,
  type SessionGoalProjection,
} from "../../../bridge/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import {
  useCallerMembershipRole,
  type CallerMembershipRoleResult,
  type CallerParticipantReader,
  type SessionStore,
} from "../../../store/index.js";

/**
 * The roles the goal contract admits as mutators, declared once.
 *
 * A set rather than a pair of comparisons so the closed membership is stated in one
 * place; the other two registered roles — viewer and runtime contributor — are
 * read-only for the goal and are absent by being absent, never by a second list.
 */
const GOAL_MUTATING_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  "owner",
  "collaborator",
]);

/** What a goal control may offer, and why it may not know. */
export interface GoalMutationAuthorization {
  /**
   * `true` for a role the goal contract admits, `false` for one it does not, and
   * `undefined` where the role is not known — in flight, refused, or absent from
   * the roster. The control is offered on `true` alone.
   */
  readonly canMutate: boolean | undefined;
  /** Present only where the identity read itself refused; its sentence is rendered. */
  readonly refusal: ConsoleRefusal | undefined;
}

/** Nothing is known yet and nothing refused — the arm both waiting states take. */
const AUTHORIZATION_NOT_READ: GoalMutationAuthorization = {
  canMutate: undefined,
  refusal: undefined,
};

/**
 * Resolve this window's goal authorization for one session.
 *
 * The reader is built here because this is the composition site: the identity read
 * lives on the growth port, which is in `bridge/`, and the hook that chains it to
 * the roster is in `store/` — a family below, which may not reach up for it. It is
 * memoised on the bridge and the store rather than rebuilt per render, because the
 * chaining hook keys its read on the reader's identity and a fresh function every
 * pass would re-read the identity on every pass.
 */
export function useGoalMutationAuthorization(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): GoalMutationAuthorization {
  const sessionId = sessionStore.sessionId;
  const readCallerParticipant = useCallback<CallerParticipantReader>(async () => {
    const outcome = await bridge.growth.callerParticipantRead({ sessionId });
    // A served value answers with the identifier; a refusal IS a `ConsoleRefusal`
    // and travels back untouched, so the reason a role is unknown survives the
    // adaptation instead of becoming a bare absence.
    return outcome.status === "served" ? outcome.value.participantId : outcome;
  }, [bridge, sessionId]);
  // The role is read off the store's own roster entry through the bridge's one
  // narrowing read — the store names no wire member, so the reader is injected.
  const callerRole = useCallerMembershipRole(readCallerParticipant, sessionStore, membershipRoleOf);
  return useMemo(() => authorizationFor(callerRole), [callerRole]);
}

/**
 * Whether the clear control is offered: one predicate, the card and the palette row.
 *
 * The card's clear button and the palette's clear row are the same act, and each
 * used to spell the rule out for itself — `goal.status === "set" && canMutate &&
 * !isMutating` in the row builder, `disabled={isMutating || goal.status !== "set"}`
 * inside an editor that opens only on `canMutate === true`. Same answer today and
 * two expressions of it, which is the shape that drifts silently: whichever half is
 * edited next leaves the other offering an act the surface beside it has withdrawn.
 *
 * `canMutate` is taken as the resolved boolean rather than the three-armed reading,
 * because the fail-closed collapse belongs at the one place that resolves it: an
 * unread role and a refused one are different sentences on screen and the same
 * answer here.
 */
export function canClearSessionGoal(
  goal: SessionGoalProjection,
  canMutate: boolean,
  isMutating: boolean,
): boolean {
  return goal.status === "set" && canMutate && !isMutating;
}

/**
 * The three arms of the role reading, mapped to what a control may do.
 *
 * The `read` arm's own absent role — the read landed and the roster holds no
 * parseable role for that participant — stays `undefined` rather than collapsing to
 * `false`: the participant may hold a role this store has not projected yet, and
 * reporting "not permitted" for a question the roster could not answer would state
 * a decision nothing made. Either way no control is offered.
 */
function authorizationFor(callerRole: CallerMembershipRoleResult): GoalMutationAuthorization {
  if (callerRole.status === "refused") {
    return { canMutate: undefined, refusal: callerRole.refusal };
  }
  if (callerRole.status === "not-loaded" || callerRole.role === undefined) {
    return AUTHORIZATION_NOT_READ;
  }
  return { canMutate: GOAL_MUTATING_ROLES.has(callerRole.role), refusal: undefined };
}
