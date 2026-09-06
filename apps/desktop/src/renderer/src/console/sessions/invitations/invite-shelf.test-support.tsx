// The cast both invite-shelf suites drive the read with.
//
// Hoisted because the suite splits on the shelf's own seam — what it reads across a
// session set, and what a person's hides survive — and both halves need the same
// reader stub, the same frozen clock, and the same durable store. A second copy of
// the reader is two files disagreeing about what a served read looks like.

import { render } from "@testing-library/react";

import { ManualClock } from "../../core/index.js";
import { frozenStartMilliseconds } from "../../core/frozen-instant.test-support.js";

import type { UiStateStore } from "../../persistence/index.js";
import { openStore } from "../sessions.test-support.js";
import { InviteShelf, type InviteShelfReader, type ServedInvite } from "./InviteShelf.js";

import { settle as settlePasses } from "../../core/settle.test-support.js";

export type ShelfOutcome = Awaited<ReturnType<InviteShelfReader>>[number];

export function invite(overrides: Partial<ServedInvite> = {}): ServedInvite {
  return {
    inviteId: "invite-1",
    state: "pending",
    expiresAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  };
}

export function served(invites: readonly ServedInvite[]): ShelfOutcome {
  return { status: "served", value: invites };
}

export const REFUSED: ShelfOutcome = {
  status: "unavailable",
  code: "wire-unregistered",
  origin: "growth-port",
  detail: "Not checked — the invites list read is not registered yet.",
  operationId: "invitesList",
  slateRow: "invites-list",
  owningDocument: "Spec-002",
};

/**
 * Let every pending microtask land and every effect they schedule run.
 *
 * Two independent asynchronous arrivals feed this component — the invites read and
 * the durable hide set — and each settles an effect that can schedule the next, so
 * one flush is not enough and the count is the depth of that chain rather than a
 * number picked to make a test pass.
 */
export async function settle(): Promise<void> {
  await settlePasses(4);
}

/**
 * An expiry that has already passed by the time a delayed read lands.
 *
 * The fixture invitation expires a day after the frozen start; this one expires
 * twenty minutes after it, so a shelf whose clock has moved an hour is looking at an
 * invitation nobody can accept any more.
 */
export const LAPSED_EXPIRY = "2026-01-01T10:20:00.000Z";

/**
 * A reader whose fan-out the case settles, so the clock can move first.
 *
 * The defect this exists for is only reachable in an ORDER — a mount, an hour with
 * nothing armed, and then an answer — and a reader that resolved on the next
 * microtask could not put the advance between the last two.
 */
export function createDeferredOutcomes(): {
  readonly read: InviteShelfReader;
  readonly settle: (outcomes: readonly ShelfOutcome[]) => void;
} {
  let settle!: (outcomes: readonly ShelfOutcome[]) => void;
  const answered = new Promise<readonly ShelfOutcome[]>((resolveOutcomes) => {
    settle = resolveOutcomes;
  });
  return { read: () => answered, settle };
}

/**
 * The clock the shelf arms its expiry wake-up on.
 *
 * Frozen and driven, never the wall clock: the shelf stops offering an invitation
 * the moment its expiry passes, so a case that read real time would turn on when it
 * ran. One per render for the same reason a store is — two cases sharing a clock
 * would share its pending timers.
 */
export function frozenClock(): ManualClock {
  return new ManualClock(frozenStartMilliseconds());
}

/** Render the shelf and let its one-shot read and its hydrate settle. */
export async function renderShelf(
  outcomes: readonly ShelfOutcome[],
  uiStateStore: UiStateStore = openStore(),
): Promise<ReturnType<typeof render>> {
  const view = render(
    <InviteShelf
      read={() => Promise.resolve(outcomes)}
      uiStateStore={uiStateStore}
      clock={frozenClock()}
    />,
  );
  await settle();
  return view;
}
