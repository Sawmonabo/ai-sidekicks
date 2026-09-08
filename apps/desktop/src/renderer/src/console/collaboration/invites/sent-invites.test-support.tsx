// The cast all three sent-invite suites drive the ledger with.
//
// Hoisted because the module's suite splits on the module's own seam — what the read
// draws, what one revoke at a time does, and which session a row and a control belong
// to — and the three halves share one set of wire ids, one invite builder, and four
// bridge builders. A second copy of the id table is two rows accidentally sharing an
// id; a second copy of `settle` is two files disagreeing about how many passes the
// read chain needs without either one failing.

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act } from "@testing-library/react";
import { vi } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge, ServedInvite } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { settle as settleReactWork } from "../../core/settle.test-support.js";

/**
 * The ids this file sends over the wire, and the labels they stand for.
 *
 * UUIDs rather than readable strings, because the call door parses the REQUEST
 * against the registered schema before it sends: `sessionId` and `inviteId` are both
 * branded UUID scalars, so a readable id is refused as `request-unsendable` and the
 * revoke never reaches the daemon at all. Named here so the cases still read as
 * "the accepted one" rather than as a hex string, and grouped rather than inlined so
 * two rows cannot accidentally share one.
 */
export const INVITE_1 = "019b7910-0001-7000-8000-000000000001";
export const INVITE_2 = "019b7910-0001-7000-8000-000000000002";
export const INVITE_ACCEPTED = "019b7910-0002-7000-8000-000000000001";
export const INVITE_PENDING = "019b7910-0002-7000-8000-000000000002";
export const INVITE_EXPIRED = "019b7910-0002-7000-8000-000000000003";
export const INVITE_REVOKED = "019b7910-0002-7000-8000-000000000004";
export const INVITE_ONE = "019b7910-0003-7000-8000-000000000001";
export const INVITE_TWO = "019b7910-0003-7000-8000-000000000002";
export const INVITE_FROM_A = "019b7910-0004-7000-8000-000000000001";
export const INVITE_FROM_B = "019b7910-0004-7000-8000-000000000002";
export const SESSION_ID = "019b7910-0000-7000-8000-000000000001";
export const SESSION_A = "019b7910-0000-7000-8000-00000000000a";
export const SESSION_B = "019b7910-0000-7000-8000-00000000000b";

/**
 * The participant every bridge here answers the caller-identity read with.
 *
 * SERVED rather than left to the scenario, and the reason is the session ids above:
 * these cases drive the surface at `SESSION_ID`, `SESSION_A`, and `SESSION_B`, while
 * a scenario plays exactly one session — so the fixture's own identity read, which is
 * scoped to the session being played, would refuse for at least two of the three. The
 * create form above the ledger composes its request from that read, and a refusal
 * there would stand an unrelated absence over every case in these suites.
 */
export const VIEWING_PARTICIPANT = "019b7910-0005-7000-8000-000000000001";

/**
 * The identity read, served, in every bridge these suites build.
 *
 * Declared once and spread, so a builder added later cannot arrive without it and
 * quietly reintroduce the refusal.
 */
const SERVED_IDENTITY = {
  callerParticipantRead: growthServing({ participantId: VIEWING_PARTICIPANT }),
};

export const EMPTY_SCENARIO: ConsoleScenario = unscriptedScenario("collaboration-invites-test");

export function invite(overrides: Partial<ServedInvite> = {}): ServedInvite {
  return {
    inviteId: INVITE_1,
    state: "pending",
    expiresAt: "2026-01-08T10:05:00.000Z",
    joinMode: "collaborator",
    ...overrides,
  };
}

/**
 * The real fixture bridge, with the one growth operation this surface reads REFUSING.
 *
 * The fixture serves `invitesList` — a scenario answers it from its own script and
 * otherwise from the empty ledger — so the refusal this surface has to render is a
 * fact about the LIVE bridge rather than about a scenario that scripts nothing. The
 * refusal is the shipped port's own `growthUnavailable`, not a hand-written envelope,
 * so what this asserts is what a release build actually produces.
 */
export function bridgeRefusingInvites(): ConsoleBridge {
  return fixtureBridgeWithGrowth(EMPTY_SCENARIO, {
    ...SERVED_IDENTITY,
    invitesList: growthRefusing("invitesList"),
  });
}

/** The real fixture bridge, with the one growth operation this surface reads served. */
export function bridgeServing(invites: readonly ServedInvite[]): ConsoleBridge {
  return fixtureBridgeWithGrowth(EMPTY_SCENARIO, {
    ...SERVED_IDENTITY,
    invitesList: growthServing(invites),
  });
}

/**
 * A scenario whose only scripted reply is the one `invite.revoke` answers with.
 *
 * The reply is the shipped `InviteRevokeResponse` shape — `{inviteId, state}` and
 * nothing else — so what the ledger consumes here is what the daemon actually sends.
 */
function scenarioSettlingRevoke(inviteId: string): ConsoleScenario {
  return {
    ...unscriptedScenario("collaboration-invites-revoke-test"),
    replies: [{ call: "invite.revoke", result: { inviteId, state: "revoked" } }],
  };
}

/** The bridge for a revoke that settles, with every `invitesList` call counted. */
export function bridgeSettlingRevoke(invites: readonly ServedInvite[]): {
  readonly bridge: ConsoleBridge;
  readonly invitesListCallCount: () => number;
} {
  const invitesList = vi.fn(growthServing(invites));
  return {
    bridge: fixtureBridgeWithGrowth(scenarioSettlingRevoke(INVITE_1), {
      ...SERVED_IDENTITY,
      invitesList,
    }),
    invitesListCallCount: () => invitesList.mock.calls.length,
  };
}

/** Press the one revoke control on screen and let its reply land. */
export async function pressRevoke(container: HTMLElement): Promise<void> {
  const revoke = container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
  await act(async () => {
    revoke?.click();
    await crossMacrotaskBoundary();
  });
  await settle();
}

/** Let the one-shot read and the effects it schedules land. */
export async function settle(): Promise<void> {
  await settleReactWork();
}
