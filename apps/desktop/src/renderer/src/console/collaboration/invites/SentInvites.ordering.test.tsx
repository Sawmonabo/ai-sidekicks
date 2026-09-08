// Which answer this ledger keeps when two of them are out at once.
//
// WHAT THE DEFECT WAS. Three things re-ask this ledger — a mint, a pending row
// crossing its expiry, and the surface being re-addressed — and every settlement went
// through one publisher carrying no stamp at all. So the last reply to ARRIVE won,
// which is not the same as the newest one asked. Two shapes follow, and neither is
// visible on screen:
//
//   • A mint's read overtakes the read it displaced, the minted ledger is drawn, and
//     the older snapshot lands afterwards and paints the surface back to before the
//     mint.
//   • A refresh is already on the wire when a revoke settles. The receipt moves the
//     row to `revoked`; the older read then answers with the row it saw, and the
//     invitation is `pending` again with its Revoke control offered — over a reply
//     the daemon had already given, for as long as the window stays open.
//
// DRIVEN BY HOLDING THE READS OPEN, which is the only way to reach either: a reply
// delivered on the next microtask settles before anything can be made to overlap it,
// and every ordering then looks correct. What is scripted here is WHEN each read
// answers and nothing else — the mint, the revoke, and the ledger are the shipped
// path, over the real fixture bridge.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge, InvitesListOutcome, ServedInvite } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { bridgeFor, pressSend, scenarioMinting } from "./create-invite.test-support.js";
import { SentInvites } from "./SentInvites.js";
import {
  INVITE_1,
  INVITE_ONE,
  INVITE_TWO,
  SESSION_ID,
  invite,
  pressRevoke,
  settle,
} from "./sent-invites.test-support.js";

/** A bridge whose ledger reads all hang, and the means to answer them out of order. */
interface HeldLedgerReads {
  readonly bridge: ConsoleBridge;
  /** How many `invitesList` calls have been issued, in issue order. */
  readonly issuedCount: () => number;
  /** Answer the read issued Nth, counting from one. */
  readonly answer: (ordinal: number, invites: readonly ServedInvite[]) => void;
}

/**
 * The real fixture bridge for this surface, with every ledger read held open.
 *
 * `bridgeFor` is the create suite's builder and it is the one this surface needs: the
 * form above the ledger takes two growth reads of its own, and a bridge that served
 * only `invitesList` would stand an unrelated absence over the send control every
 * case here presses.
 */
function bridgeHoldingLedgerReads(scenario: ConsoleScenario): HeldLedgerReads {
  const answers: ((outcome: InvitesListOutcome) => void)[] = [];
  const { bridge } = bridgeFor(scenario, {
    invitesList: async () =>
      await new Promise<InvitesListOutcome>((resolve) => {
        answers.push(resolve);
      }),
  });
  return {
    bridge,
    issuedCount: () => answers.length,
    answer: (ordinal, invites) => {
      const resolve = answers[ordinal - 1];
      if (resolve === undefined) {
        throw new Error(`no ledger read was issued at ordinal ${String(ordinal)}`);
      }
      resolve({ status: "served", value: invites });
    },
  };
}

/** Answer one held read and let whatever it published land. */
async function answerRead(
  held: HeldLedgerReads,
  ordinal: number,
  invites: readonly ServedInvite[],
): Promise<void> {
  await act(async () => {
    held.answer(ordinal, invites);
    await crossMacrotaskBoundary();
  });
  await settle();
}

/**
 * The mint's scenario, with the revoke reply the second block needs beside it.
 *
 * Composed from the shipped mint scenario rather than declared beside it: the reply
 * shapes are the registered `InviteCreateResponse` and `InviteRevokeResponse`, and a
 * second scenario literal would be a second place either of them is spelled out.
 */
function scenarioMintingAndRevoking(): ConsoleScenario {
  const minting = scenarioMinting();
  return {
    ...minting,
    replies: [
      ...minting.replies,
      { call: "invite.revoke", result: { inviteId: INVITE_1, state: "revoked" } },
    ],
  };
}

/** Mount the surface with its first ledger read issued and still unanswered. */
function renderWithHeldReads(held: HeldLedgerReads): HTMLElement {
  const { container } = render(<SentInvites bridge={held.bridge} sessionId={SESSION_ID} />);
  return container;
}

describe("sent invites — two ledger reads out at once", () => {
  it("keeps the newest read's rows when the read it displaced answers last", async () => {
    const held = bridgeHoldingLedgerReads(scenarioMinting());
    const container = renderWithHeldReads(held);
    await settle();
    expect(held.issuedCount()).toBe(1);

    // The mint is what puts a second read on the wire while the first is still out.
    await pressSend(container);
    expect(held.issuedCount()).toBe(2);

    await answerRead(held, 2, [invite({ inviteId: INVITE_TWO })]);
    expect(container.textContent ?? "").toContain(INVITE_TWO);

    // The displaced read answers now, with the snapshot it took before the mint.
    await answerRead(held, 1, [invite({ inviteId: INVITE_ONE })]);

    expect(container.textContent ?? "").toContain(INVITE_TWO);
    expect(container.textContent ?? "").not.toContain(INVITE_ONE);
  });

  it("negative control: the newest read still installs when it answers last", async () => {
    // Without this the case above would pass over a ledger that discarded every
    // settlement after the first — the same green for the opposite defect, and a
    // surface that never showed a minted invitation at all.
    const held = bridgeHoldingLedgerReads(scenarioMinting());
    const container = renderWithHeldReads(held);
    await settle();
    await pressSend(container);

    await answerRead(held, 1, [invite({ inviteId: INVITE_ONE })]);
    await answerRead(held, 2, [invite({ inviteId: INVITE_TWO })]);

    expect(container.textContent ?? "").toContain(INVITE_TWO);
    expect(container.textContent ?? "").not.toContain(INVITE_ONE);
  });
});

describe("sent invites — a receipt against a read that was already out", () => {
  /**
   * Mount, settle the first read on one pending row, and leave a second read open.
   *
   * The order is the whole point: the refresh is issued BEFORE the revoke is
   * dispatched, so nothing about the receipt could have stopped it being put.
   */
  async function surfaceWithRefreshInFlight(): Promise<{
    readonly container: HTMLElement;
    readonly held: HeldLedgerReads;
  }> {
    const held = bridgeHoldingLedgerReads(scenarioMintingAndRevoking());
    const container = renderWithHeldReads(held);
    await settle();
    await answerRead(held, 1, [invite({ inviteId: INVITE_1 })]);
    await pressSend(container);
    expect(held.issuedCount()).toBe(2);
    return { container, held };
  }

  it("keeps the row revoked when the older read answers with it still pending", async () => {
    const { container, held } = await surfaceWithRefreshInFlight();

    await pressRevoke(container);
    expect(container.querySelector("details")?.textContent ?? "").toContain("revoked");

    // The read that was already out answers with the row as it stood before the
    // revoke — which is exactly what used to restore it.
    await answerRead(held, 2, [invite({ inviteId: INVITE_1 })]);

    expect(container.querySelector("details")?.textContent ?? "").toContain("revoked");
    expect(container.textContent ?? "").toContain("No invitation is still waiting");
    expect(container.querySelector(".meridian-invites__row-action")).toBeNull();
  });

  it("negative control: with no receipt, that same read draws the row pending", async () => {
    // Without this the case above would pass over a ledger that dropped every read
    // issued before any settlement — including the ordinary refresh nobody revoked
    // anything during, which is the one this surface exists to perform.
    const { container, held } = await surfaceWithRefreshInFlight();

    await answerRead(held, 2, [invite({ inviteId: INVITE_1 })]);

    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".meridian-invites__row-action")).not.toBeNull();
  });
});
