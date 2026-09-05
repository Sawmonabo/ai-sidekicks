// What the shelf reads across a set of sessions, and what it draws from it.
//
// A refusal reported beside another session's answer rather than instead of it, the
// rows a served read produces, and the invitation that lapses under a clock the
// console holds rather than under a second read. What a person's HIDES survive and
// which reader an answer belongs to is `InviteShelf.hiding.test.tsx`, over the one
// cast in `invite-shelf.test-support.tsx`.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openStore } from "../sessions.test-support.js";
import { InviteShelf } from "./InviteShelf.js";
import {
  DAY_MILLISECONDS,
  REFUSED,
  frozenClock,
  invite,
  renderShelf,
  served,
  settle,
} from "./invite-shelf.test-support.js";

describe("what the shelf says before it has an answer", () => {
  it("says nothing was asked when there was no session to ask about", async () => {
    const { container } = await renderShelf([]);
    const text = container.textContent ?? "";
    expect(text).toContain("No invitations have been read.");
    expect(text).not.toContain("Nothing is waiting for you to join.");
  });

  it("renders the port's own refusal, code and message, rather than an empty shelf", async () => {
    const { container } = await renderShelf([REFUSED]);
    const text = container.textContent ?? "";
    expect(text).toContain("wire-unregistered");
    expect(text).toContain("Not checked — the invites list read is not registered yet.");
    expect(text).not.toContain("Nothing is waiting for you to join.");
  });

  it("reports one session's refusal beside another's empty answer, not instead of it", async () => {
    // The refusal arm used to turn on how many PENDING invitations survived
    // filtering, so a session that answered with nothing was indistinguishable
    // from one that never answered — and the shelf reported the other session's
    // refusal as its whole result, hiding a served answer.
    const { container } = await renderShelf([served([]), REFUSED]);
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing is waiting for you to join.");
    expect(text).toContain("wire-unregistered");
  });

  it("does the same when the served session carried only settled invitations", async () => {
    const { container } = await renderShelf([
      served([invite({ inviteId: "gone", state: "expired" })]),
      REFUSED,
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing is waiting for you to join.");
    expect(text).toContain("wire-unregistered");
  });

  it("negative control: with nothing served the refusal IS the whole answer", async () => {
    // Without this, both cases above would pass over a shelf that had simply
    // stopped distinguishing the two — rendering the empty state beside every
    // refusal, including one that answers for every session that was asked.
    const { container } = await renderShelf([REFUSED, REFUSED]);
    const text = container.textContent ?? "";
    expect(text).toContain("wire-unregistered");
    expect(text).not.toContain("Nothing is waiting for you to join.");
  });

  it("negative control: a served read with no invitations DOES say the inbox is empty", async () => {
    // Without this, both cases above would pass over a shelf that rendered an
    // absence for every outcome.
    const { container } = await renderShelf([served([])]);
    expect(container.textContent ?? "").toContain("Nothing is waiting for you to join.");
  });
});

describe("what the shelf shows", () => {
  it("renders a pending invitation with its identifier, its state, and its expiry", async () => {
    const { container } = await renderShelf([served([invite()])]);
    const text = container.textContent ?? "";
    expect(text).toContain("invite-1");
    expect(text).toContain("pending");
    expect(container.querySelectorAll(".meridian-invite-shelf__row")).toHaveLength(1);
  });

  it("shows nothing that is not still waiting on somebody", async () => {
    const { container } = await renderShelf([
      served([invite({ inviteId: "gone", state: "expired" })]),
    ]);
    expect(container.textContent ?? "").toContain("Nothing is waiting for you to join.");
  });

  it("counts one invitation once when two sessions both carry it", async () => {
    const { container } = await renderShelf([served([invite()]), served([invite()])]);
    expect(container.querySelectorAll(".meridian-invite-shelf__row")).toHaveLength(1);
  });

  it("shows what was served AND says one session would not answer", async () => {
    const { container } = await renderShelf([REFUSED, served([invite()])]);
    const text = container.textContent ?? "";
    expect(text).toContain("invite-1");
    expect(text).toContain("wire-unregistered");
    expect(container.querySelectorAll(".meridian-invite-shelf__row")).toHaveLength(1);
    // The console's own sentence for a refusal that arrived BESIDE an answer, from
    // `primitives/partial-read.ts` rather than from a copy this file would own: the
    // rows are shown and the claim that they are all of it is withdrawn.
    expect(text).toContain("what is shown here is not the whole of it");
  });

  it("takes the rows away when NO session answered, and says why", async () => {
    // The whole-answer arm. An empty shelf here would read as "you have no
    // invitations", which is a claim nothing this read reached could support.
    const { container } = await renderShelf([REFUSED]);
    const text = container.textContent ?? "";
    expect(text).toContain("none of it is shown here");
    expect(text).toContain("wire-unregistered");
    expect(text).not.toContain("Nothing is waiting for you to join.");
  });

  it("negative control: a fully served read withdraws nothing", async () => {
    // Without this, the two cases above would pass over a shelf that mounted its
    // notice unconditionally — telling a person their inbox may be short every time
    // they look at a complete one.
    const { container } = await renderShelf([served([invite()])]);
    const text = container.textContent ?? "";
    expect(text).not.toContain("not the whole of it");
    expect(text).not.toContain("none of it is shown here");
  });
});

describe("an invitation that lapses while the console holds it", () => {
  it("stops offering it when its expiry passes, with no second read", async () => {
    // The defect this closes: the shelf rendered against the instant of its last
    // read, so an invitation that expired while the window stayed open went on being
    // offered — and **Not now** stayed the only thing a person could do with it.
    const clock = frozenClock();
    const uiStateStore = openStore();
    const { container } = render(
      <InviteShelf
        read={() => Promise.resolve([served([invite()])])}
        uiStateStore={uiStateStore}
        clock={clock}
      />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("invite-1");

    // Past the fixture's expiry, on the clock the shelf armed its wake-up on. No
    // read is performed and none is needed: what changed is what time it is.
    await act(async () => {
      clock.advance(DAY_MILLISECONDS + 1);
      await Promise.resolve();
    });

    const text = container.textContent ?? "";
    expect(text).not.toContain("invite-1");
    expect(text).toContain("Nothing is waiting for you to join.");
  });

  it("negative control: it is still offered right up to the expiry", async () => {
    // Without this, the case above would pass over a shelf that dropped every
    // invitation the moment a timer fired, or that never showed one at all.
    const clock = frozenClock();
    const { container } = render(
      <InviteShelf
        read={() => Promise.resolve([served([invite()])])}
        uiStateStore={openStore()}
        clock={clock}
      />,
    );
    await settle();

    await act(async () => {
      clock.advance(DAY_MILLISECONDS - 1);
      await Promise.resolve();
    });

    expect(container.textContent ?? "").toContain("invite-1");
  });

  it("keeps an invitation whose expiry this console cannot read", async () => {
    // A stamp that does not parse is not evidence that anything lapsed, and a
    // wake-up armed on one would fire immediately and forever.
    const { container } = await renderShelf([
      served([invite({ inviteId: "unreadable-expiry", expiresAt: "whenever" })]),
    ]);
    expect(container.textContent ?? "").toContain("unreadable-expiry");
  });
});
