// The projection, the context, and the two-membership cast every membership case runs on.
//
// Hoisted because the section's suite splits by SUBJECT — what a row prints, what the
// last owner is told, one change at a time, and what the supervisor's condition closes
// — and every half needs the same three things: a real store initialised from a
// snapshot, a section context around it, and one cast whose two rows differ in role and
// in state. A second copy of the cast is two files quietly asserting about different
// people; a second copy of `storeHolding` is two files disagreeing about what a
// projected membership even looks like.

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import type { SidebarSectionContext } from "../../seats/index.js";

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

export const SESSION_ID = "session-collaboration";

export const EMPTY_SCENARIO: FixtureScenario = {
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

export function contextFor(
  store: SessionStore,
  bridge?: ConsoleBridge,
  frameStore?: FrameStore,
): SidebarSectionContext {
  return {
    sessionStore: store,
    bridge: bridge ?? createFixtureBridge({ scenario: EMPTY_SCENARIO }),
    // A shell that has reported nothing closes no control, which is the condition
    // every case about the ledger itself is written under. A case about the outage
    // hands in a store it has driven to the condition it asserts.
    frameStore: frameStore ?? new FrameStore(),
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
