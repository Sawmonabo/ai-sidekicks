// The membership ledger's harness: the probe that performs the section body's one
// derivation, and the stores and contexts every ledger case is written against.
//
// It is here rather than in either test file because BOTH of them drive the same
// surface through the same real derivation, and a second copy of `storeHolding`
// would be a second answer to what a projected membership looks like. Its readers
// are `Memberships.test.tsx` (what a row says) and `Memberships.acts.test.tsx`
// (what a person can do to one).

import type { ReactElement } from "react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import type { SidebarSectionContext } from "../../seats/index.js";
import { deriveMembershipRows } from "./members-model.js";
import { Memberships as MembershipsSurface } from "./Memberships.js";
import type { PendingInviteConfirmation } from "../invites/InviteConfirmation.js";

/**
 * The surface, with the rows its section body derives.
 *
 * The rows moved up to `MembersSectionBody` when the roster read landed, because the
 * roster above and this ledger below read the same three facts about the same people
 * and two derivations would put two answers on one screen. The cases here are about
 * the LEDGER, so this probe performs the section body's one derivation — through the
 * real `deriveMembershipRows`, never a stand-in for it — and hands the result over.
 */
export function Memberships(props: {
  readonly context: SidebarSectionContext;
  readonly pendingInvite?: PendingInviteConfirmation | undefined;
  readonly rosterEntries?: ReadonlyMap<string, never> | undefined;
  readonly rosterRefusal?: ConsoleRefusal | undefined;
  readonly isLastKnown?: boolean;
}): ReactElement {
  const rows = deriveMembershipRows(
    props.context.sessionStore.snapshot().partitions.participant,
    props.rosterEntries,
  );
  return (
    <MembershipsSurface
      context={props.context}
      rows={rows}
      rosterRefusal={props.rosterRefusal}
      isLastKnown={props.isLastKnown ?? false}
      pendingInvite={props.pendingInvite}
    />
  );
}

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

export const SESSION_ID: string = "session-collaboration";

const EMPTY_SCENARIO: FixtureScenario = {
  id: "collaboration-members-test",
  label: "Memberships, with nothing scripted",
  purpose: "Drives the membership ledger against a bridge that scripts no reply.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

export interface ProjectedMembership {
  readonly participantId: string;
  readonly role?: string;
  readonly membershipId?: string;
  readonly state?: string;
}

/**
 * A store holding exactly the memberships a case is about.
 *
 * The REAL store, initialised from a snapshot — not a stand-in for it. What the
 * section derives from a projection is the thing under test, so the projection
 * has to be the real one.
 */
export function storeHolding(memberships: readonly ProjectedMembership[]): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: 0,
    participantJoinLog: memberships.map((membership) => membership.participantId),
    entities: memberships.map((membership) => ({
      kind: "participant" as const,
      id: membership.participantId,
      ...(membership.state === undefined ? {} : { state: membership.state }),
      body: {
        ...(membership.role === undefined ? {} : { role: membership.role }),
        ...(membership.membershipId === undefined ? {} : { membershipId: membership.membershipId }),
      },
    })),
  });
  return store;
}

export function contextFor(store: SessionStore, bridge?: ConsoleBridge): SidebarSectionContext {
  return {
    sessionStore: store,
    bridge: bridge ?? createFixtureBridge({ scenario: EMPTY_SCENARIO }),
    openPane: () => undefined,
    isOpen: true,
  };
}

export const OWNER_AND_COLLABORATOR: readonly ProjectedMembership[] = [
  {
    participantId: "participant-you",
    role: "owner",
    membershipId: "019b7912-0001-7000-8000-000000000001",
    state: "active",
  },
  {
    participantId: "participant-priya",
    role: "collaborator",
    membershipId: "019b7912-0001-7000-8000-000000000002",
    state: "suspended",
  },
];
