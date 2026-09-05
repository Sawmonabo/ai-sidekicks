// The received-invite shelf: what it shows, what it hides, and what it refuses to
// conclude from a refusal.
//
// The property worth the most here is the last one. `pruneAgainst` runs only on a
// served read, so a refused read must leave a person's set-aside invitations
// alone — and that failure would be silent, because everything would simply come
// back as if they had never pressed anything.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { frozenStartMilliseconds } from "../../core/frozen-instant.test-support.js";
import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import type { UiStateStore } from "../../persistence/index.js";
import { openStore, openStoreOver } from "../sessions.test-support.js";
import { InviteShelf, type InviteShelfReader, type ReceivedInvite } from "./InviteShelf.js";
import { HIDDEN_INVITES_KEY } from "./hidden-invites.js";
import { settle as settlePasses } from "../../core/settle.test-support.js";

type ShelfOutcome = Awaited<ReturnType<InviteShelfReader>>[number];

function invite(overrides: Partial<ReceivedInvite> = {}): ReceivedInvite {
  return {
    inviteId: "invite-1",
    state: "pending",
    expiresAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  };
}

function served(invites: readonly ReceivedInvite[]): ShelfOutcome {
  return { status: "served", value: invites };
}

const REFUSED: ShelfOutcome = {
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
async function settle(): Promise<void> {
  await settlePasses(4);
}

/** The gap between the frozen start and the fixture invitation's own expiry. */
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * The clock the shelf arms its expiry wake-up on.
 *
 * Frozen and driven, never the wall clock: the shelf stops offering an invitation
 * the moment its expiry passes, so a case that read real time would turn on when it
 * ran. One per render for the same reason a store is — two cases sharing a clock
 * would share its pending timers.
 */
function frozenClock(): ManualClock {
  return new ManualClock(frozenStartMilliseconds());
}

/** Render the shelf and let its one-shot read and its hydrate settle. */
async function renderShelf(
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

describe("Not now", () => {
  it("is a local hide, offered instead of a decline the wire does not have", async () => {
    const { container } = await renderShelf([served([invite()])]);
    const labels = [...container.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).toContain("Not now");
    expect(labels.some((label) => /decline|reject|refuse/iu.test(label))).toBe(false);
  });

  it("sets the invitation aside and writes the hide through the durable store", async () => {
    const uiStateStore = openStore();
    const { container } = await renderShelf([served([invite()])], uiStateStore);

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-shelf__row-action")?.click();
    });
    await settle();

    expect(container.textContent ?? "").toContain("1 set aside");
    const record = await uiStateStore.readGlobal(HIDDEN_INVITES_KEY);
    expect(record?.value).toStrictEqual(["invite-1"]);
  });

  it("is reversible from the shelf's own disclosure", async () => {
    const { container } = await renderShelf([served([invite()])]);
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-shelf__row-action")?.click();
    });
    await settle();
    const bringBack = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Bring it back",
    );
    expect(bringBack).not.toBeUndefined();
    act(() => {
      bringBack?.click();
    });
    await settle();
    expect(container.textContent ?? "").not.toContain("set aside");
  });
});

describe("what a refusal must not do to a person's hides", () => {
  it("leaves the set-aside invitations alone when the read refused", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const seeded = openStoreOver(adapter);
    await seeded.writeGlobal(HIDDEN_INVITES_KEY, "expansion", ["invite-1"]);

    await renderShelf([REFUSED], openStoreOver(adapter));

    const record = await seeded.readGlobal(HIDDEN_INVITES_KEY);
    expect(record?.value).toStrictEqual(["invite-1"]);
  });

  it("leaves them alone when only SOME sessions answered", async () => {
    // The partial read is the case the served result now renders through, and it
    // is still not evidence an invitation is gone: the session that refused may
    // hold the very one the pending list does not name.
    const adapter = new MemoryPersistenceAdapter();
    const seeded = openStoreOver(adapter);
    await seeded.writeGlobal(HIDDEN_INVITES_KEY, "expansion", ["invite-1"]);

    await renderShelf([served([]), REFUSED], openStoreOver(adapter));

    const record = await seeded.readGlobal(HIDDEN_INVITES_KEY);
    expect(record?.value).toStrictEqual(["invite-1"]);
  });

  it("negative control: a served read that no longer lists it DOES prune the hide", async () => {
    // Without this, the cases above would pass over a shelf that never pruned at
    // all, which is a different defect wearing the same green tick.
    const adapter = new MemoryPersistenceAdapter();
    const seeded = openStoreOver(adapter);
    await seeded.writeGlobal(HIDDEN_INVITES_KEY, "expansion", ["invite-1"]);

    await renderShelf([served([])], openStoreOver(adapter));

    const record = await seeded.readGlobal(HIDDEN_INVITES_KEY);
    expect(record?.value).toStrictEqual([]);
  });
});

/** A reader that answers when a case decides to, so a replacement can stall. */
function heldReader(): {
  readonly read: InviteShelfReader;
  readonly answer: (outcomes: readonly ShelfOutcome[]) => void;
} {
  let settle: (outcomes: readonly ShelfOutcome[]) => void = () => undefined;
  const held = new Promise<readonly ShelfOutcome[]>((resolve) => {
    settle = resolve;
  });
  return { read: () => held, answer: (outcomes) => settle(outcomes) };
}

describe("an answer that belongs to the session set it was asked of", () => {
  it("shows the reading arm rather than the previous set's invitations", async () => {
    // The defect: the outcomes went on describing the previous session set until the
    // replacement fan-out settled, and if it stalls that is forever — so the shelf
    // offered **Not now** on an invitation read for a set this console has replaced.
    const uiStateStore = openStore();
    const view = render(
      <InviteShelf
        read={() => Promise.resolve([served([invite()])])}
        uiStateStore={uiStateStore}
        clock={frozenClock()}
      />,
    );
    await settle();
    expect(view.container.textContent ?? "").toContain("invite-1");

    const replacement = heldReader();
    view.rerender(
      <InviteShelf read={replacement.read} uiStateStore={uiStateStore} clock={frozenClock()} />,
    );
    await settle();

    const text = view.container.textContent ?? "";
    expect(text).not.toContain("invite-1");
    expect(text).toContain("Reading your invitations.");
  });

  it("shows the reading arm rather than a definitive empty inbox", async () => {
    // The other half of the same fact, and the one a person cannot tell from the
    // truth: an empty shelf under a stalled replacement read says "nothing is
    // waiting for you", which is a claim about a set nobody has answered for.
    const uiStateStore = openStore();
    const view = render(
      <InviteShelf
        read={() => Promise.resolve([served([])])}
        uiStateStore={uiStateStore}
        clock={frozenClock()}
      />,
    );
    await settle();
    expect(view.container.textContent ?? "").toContain("Nothing is waiting for you to join.");

    const replacement = heldReader();
    view.rerender(
      <InviteShelf read={replacement.read} uiStateStore={uiStateStore} clock={frozenClock()} />,
    );
    await settle();

    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Nothing is waiting for you to join.");
    expect(text).toContain("Reading your invitations.");
  });

  it("drops the previous set's answer when it lands after the reader changed", async () => {
    // The read this console has left is not cancellable, so it settles whenever it
    // settles. What it may not do is install itself over the set now being read for.
    const uiStateStore = openStore();
    const abandoned = heldReader();
    const view = render(
      <InviteShelf read={abandoned.read} uiStateStore={uiStateStore} clock={frozenClock()} />,
    );
    await settle();

    const replacement = heldReader();
    view.rerender(
      <InviteShelf read={replacement.read} uiStateStore={uiStateStore} clock={frozenClock()} />,
    );
    await settle();

    abandoned.answer([served([invite({ inviteId: "invite-from-the-set-we-left" })])]);
    await settle();

    const text = view.container.textContent ?? "";
    expect(text).not.toContain("invite-from-the-set-we-left");
    expect(text).toContain("Reading your invitations.");
  });

  it("negative control: the replacement's own answer IS rendered", async () => {
    // Without this, the cases above would pass over a shelf that had stopped
    // rendering answers altogether — which would leave every session set reading
    // forever.
    const uiStateStore = openStore();
    const view = render(
      <InviteShelf
        read={() => Promise.resolve([served([])])}
        uiStateStore={uiStateStore}
        clock={frozenClock()}
      />,
    );
    await settle();

    const replacement = heldReader();
    view.rerender(
      <InviteShelf read={replacement.read} uiStateStore={uiStateStore} clock={frozenClock()} />,
    );
    await settle();

    replacement.answer([served([invite({ inviteId: "invite-from-the-set-we-arrived-at" })])]);
    await settle();

    const text = view.container.textContent ?? "";
    expect(text).toContain("invite-from-the-set-we-arrived-at");
    expect(text).not.toContain("Reading your invitations.");
  });
});
