// One revoke at a time, and what a settled one does to the row it names.
//
// The ledger consumes the revoke REPLY rather than re-reading: the reply carries the
// row's identifier and its new lifecycle state, which are exactly the two fields
// that decide which half of the ledger a row sits in. So the assertions here are
// about a settlement moving a row with no second call on the wire, and about the
// control closing while one is unsettled.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SentInvites } from "./SentInvites.js";
import {
  INVITE_1,
  INVITE_ONE,
  INVITE_TWO,
  SESSION_ID,
  bridgeServing,
  bridgeSettlingRevoke,
  invite,
  pressRevoke,
  settle,
} from "./sent-invites.test-support.js";

describe("sent invites — one revoke at a time", () => {
  /** Every revoke control on screen, read fresh after each render. */
  function revokeControls(container: HTMLElement): readonly HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".meridian-invites__row-action")];
  }

  async function renderTwoPending(): Promise<HTMLElement> {
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([invite({ inviteId: INVITE_ONE }), invite({ inviteId: INVITE_TWO })])}
        sessionId={SESSION_ID}
      />,
    );
    await settle();
    return container;
  }

  it("closes every pending row's control while one revoke is unsettled", async () => {
    const container = await renderTwoPending();
    expect(revokeControls(container).map((control) => control.disabled)).toStrictEqual([
      false,
      false,
    ]);

    // A SYNCHRONOUS act on purpose: the coordinator publishes its pending key
    // before the call it awaits settles, so this reads the tree at exactly the
    // moment one revoke is in flight. An awaiting act would flush the reply first
    // and find the surface back at rest.
    act(() => {
      revokeControls(container)[0]?.click();
    });

    expect(revokeControls(container).map((control) => control.disabled)).toStrictEqual([
      true,
      true,
    ]);
    // The row that was pressed says what it is doing; its neighbour is only shut.
    expect(revokeControls(container)[0]?.textContent).toBe("Revoking…");
    expect(revokeControls(container)[1]?.textContent).toBe("Revoke");
    await settle();
  });

  it("negative control: both controls open again once that revoke settles", async () => {
    // Without this, the case above would pass over a ledger that disabled every
    // revoke control permanently.
    const container = await renderTwoPending();

    await pressRevoke(container);

    expect(container.textContent ?? "").toContain("reply-unscripted");
    expect(revokeControls(container).map((control) => control.disabled)).toStrictEqual([
      false,
      false,
    ]);
  });
});

describe("sent invites — a revoke that settles", () => {
  it("moves the row into the settled ledger from the reply itself", async () => {
    const served = bridgeSettlingRevoke([invite()]);
    const { container } = render(<SentInvites bridge={served.bridge} sessionId={SESSION_ID} />);
    await settle();
    expect(container.querySelector(".meridian-invites__row-action")).not.toBeNull();

    await pressRevoke(container);

    // The row is in the fold now, carrying the state the daemon sent — and the
    // pending half says so rather than still offering a control on it.
    const fold = container.querySelector("details");
    expect(fold?.textContent ?? "").toContain(INVITE_1);
    expect(fold?.textContent ?? "").toContain("revoked");
    expect(container.textContent ?? "").toContain("No invitation is still waiting");
    expect(container.querySelector(".meridian-invites__row-action")).toBeNull();
  });

  it("puts no second read on the wire, because the reply carried the row", async () => {
    const served = bridgeSettlingRevoke([invite()]);
    const { container } = render(<SentInvites bridge={served.bridge} sessionId={SESSION_ID} />);
    await settle();
    expect(served.invitesListCallCount()).toBe(1);

    await pressRevoke(container);

    expect(served.invitesListCallCount()).toBe(1);
  });

  it("negative control: a refused revoke leaves the row pending and offers the control again", async () => {
    // Without this, the two cases above would pass over a ledger that settled every
    // row it was asked about, refusal or not.
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();

    await pressRevoke(container);

    expect(container.textContent ?? "").toContain("reply-unscripted");
    const action = container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
    expect(action).not.toBeNull();
    expect(action?.disabled).toBe(false);
    expect(container.querySelector("details")).toBeNull();
  });
});
