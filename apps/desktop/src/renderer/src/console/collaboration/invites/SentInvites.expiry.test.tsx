// The ledger is re-asked at a pending invitation's own expiry, and not only on mount.
//
// WHAT THE DEFECT WAS. `invitesList` was read once per mount and once per mint, so a
// page left open past an invitation's `expiresAt` went on drawing the row the read had
// seen: `pending`, in the accent chip, with Revoke offered on it. Nothing was wrong
// with the wire — the daemon (and the fixture that stands in for it) answers `expired`
// for any read taken at or after that stamp — and nothing asked it again.
//
// DRIVEN OVER THE SCENARIO'S OWN FROZEN CLOCK, which is the only way to reach the
// defect at all: the expiry is forty seconds past tick zero, the surface resolves its
// clock from the bridge, and the fixture's invite ledger ages a pending row against
// the instant a call settles at. Advancing that clock is therefore the whole
// mechanism under test — the timer arming, the wake-up publishing, the effect asking
// again, and the reply answering differently — rather than a stub of any part of it.
//
// AND THE CASES BELOW ASSERT THE WITHDRAWAL AS WELL AS THE WORD. A row that says
// `expired` beside a live Revoke control is the same defect wearing the new state:
// the control is the act, and the act is what the daemon would refuse.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { quietShell } from "../../store/shell-condition.test-support.js";
import { SentInvites } from "./SentInvites.js";
import { settle } from "./sent-invites.test-support.js";
import { COLLABORATION_SCENARIO } from "../../bridge/scenarios/collaboration.js";
import { INVITE_EXPIRING } from "../../bridge/scenarios/collaboration/identifiers.js";
import { createFixtureBridge } from "../../bridge/fixture/call-plane/bridge.js";
import type { ConsoleBridge } from "../../bridge/index.js";

/** How far past tick zero the room's pending invitation declares its expiry. */
const INVITE_EXPIRY_MS = 40_000;

/** The room, mounted at tick zero with its first ledger read settled. */
async function renderRoomLedger(): Promise<{
  readonly container: HTMLElement;
  readonly bridge: ConsoleBridge;
}> {
  const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
  const { container } = render(
    <SentInvites
      bridge={bridge}
      sessionId={COLLABORATION_SCENARIO.sessionId}
      frameStore={quietShell()}
    />,
  );
  await settle();
  return { container, bridge };
}

/** The chips on the expiring invitation's own row, in the order it draws them. */
function expiringRowChips(container: HTMLElement): readonly string[] {
  const row = [...container.querySelectorAll<HTMLElement>(".meridian-invites__row")].find(
    (candidate) => (candidate.textContent ?? "").includes(INVITE_EXPIRING),
  );
  return [...(row?.querySelectorAll<HTMLElement>(".meridian-chip") ?? [])].map(
    (chip) => chip.textContent ?? "",
  );
}

/** Whether a control exists to revoke the expiring invitation. */
function offersRevokeOnExpiringRow(container: HTMLElement): boolean {
  return container.querySelector(`[aria-label="Revoke invitation ${INVITE_EXPIRING}"]`) !== null;
}

/**
 * How many timers the room's frozen clock is holding.
 *
 * Read off the scenario's own clock rather than counted here, so what this asserts is
 * the arming the shipped hook performed and not a tally this file kept. Narrowed by
 * `instanceof` rather than cast: a bridge whose clock is not the manual one would
 * answer every count here with `undefined` under a cast and read as a passing zero.
 */
function pendingTimerCount(bridge: ConsoleBridge): number {
  const clock = bridge.scenarioEngine?.clock;
  expect(clock).toBeInstanceOf(ManualClock);
  return clock instanceof ManualClock ? clock.pendingCount : Number.NaN;
}

/** Move the room's frozen clock, letting the wake-up and the re-read it triggers land. */
async function advanceTo(bridge: ConsoleBridge, deltaMilliseconds: number): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(deltaMilliseconds);
    await crossMacrotaskBoundary();
  });
  await settle();
}

describe("sent invites — a pending row's expiry re-asks the ledger", () => {
  it("draws the row as expired and withdraws Revoke once the clock reaches the expiry", async () => {
    const { container, bridge } = await renderRoomLedger();
    expect(expiringRowChips(container)).toContain("pending");
    expect(offersRevokeOnExpiringRow(container)).toBe(true);

    await advanceTo(bridge, INVITE_EXPIRY_MS);

    expect(expiringRowChips(container)).toContain("expired");
    expect(expiringRowChips(container)).not.toContain("pending");
    // The state alone is not the fix. A ledger that re-read and kept the control
    // would still be offering an act the daemon can only refuse.
    expect(offersRevokeOnExpiringRow(container)).toBe(false);
  });

  it("negative control: one millisecond short of the expiry, nothing has been re-asked", async () => {
    // Without this the case above would pass over a surface that re-read on every
    // clock advance, or over one whose row aged locally rather than on the wire —
    // neither of which is a wake-up armed at the deadline the row itself declares.
    const { container, bridge } = await renderRoomLedger();

    await advanceTo(bridge, INVITE_EXPIRY_MS - 1);

    expect(expiringRowChips(container)).toContain("pending");
    expect(offersRevokeOnExpiringRow(container)).toBe(true);
  });

  it("arms exactly one timer while a row is pending and none once the last one settles", async () => {
    // Both halves of the chain, because either alone is satisfied by doing nothing:
    // a surface that armed no timer at all would pass the "none left" assertion, and
    // one that re-armed on a deadline already behind would ask again forever.
    const { container, bridge } = await renderRoomLedger();
    expect(pendingTimerCount(bridge)).toBe(1);

    await advanceTo(bridge, INVITE_EXPIRY_MS);
    expect(pendingTimerCount(bridge)).toBe(0);

    await advanceTo(bridge, INVITE_EXPIRY_MS * 4);
    expect(pendingTimerCount(bridge)).toBe(0);
    expect(expiringRowChips(container)).toContain("expired");
    expect(offersRevokeOnExpiringRow(container)).toBe(false);
  });
});
