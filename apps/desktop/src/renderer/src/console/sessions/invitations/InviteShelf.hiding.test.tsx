// What a person sets aside, and which reader an answer belongs to.
//
// The local hide offered in place of a decline the wire does not carry, the hides a
// refusal must leave alone, and the answer that lands after the session set it was
// asked of has been replaced. What the shelf READS is
// `InviteShelf.reading.test.tsx`, over the one cast in `invite-shelf.test-support.tsx`.
import type { InviteShelfReader } from "./InviteShelf.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import { openStore, openStoreOver } from "../sessions.test-support.js";
import { InviteShelf } from "./InviteShelf.js";
import { HIDDEN_INVITES_KEY } from "./hidden-invites.js";
import {
  REFUSED,
  frozenClock,
  invite,
  renderShelf,
  served,
  settle,
} from "./invite-shelf.test-support.js";
import type { ShelfOutcome } from "./invite-shelf.test-support.js";

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
