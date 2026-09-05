// Setting an invitation aside: local, reversible, and pruned only against an answer.
//
// The rule that matters most here is the last one. A refused read is not evidence
// that an invitation is gone, so pruning against it would clear a person's whole
// set on a wire that never answered — and that failure would be invisible, because
// the invitations would simply come back.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import { PERSISTENCE_GLOBAL_PARTITION, UiStateStore } from "../../persistence/index.js";
import { HIDDEN_INVITES_KEY, HiddenInviteStore, narrowHiddenInviteIds } from "./hidden-invites.js";

function openStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

describe("the set-aside set", () => {
  it("writes through the chokepoint under the expansion class", async () => {
    const store = openStore();
    const hidden = new HiddenInviteStore(store);
    await hidden.hide("invite-1");

    expect(hidden.isHidden("invite-1")).toBe(true);
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, HIDDEN_INVITES_KEY);
    expect(record?.valueClass).toBe("expansion");
    expect(record?.value).toStrictEqual(["invite-1"]);
  });

  it("is reversible, which is what makes it safe to press", async () => {
    const hidden = new HiddenInviteStore(openStore());
    await hidden.hide("invite-1");
    await hidden.reveal("invite-1");
    expect(hidden.hiddenInviteIds).toStrictEqual([]);
  });

  it("hides once, so a second press is not a second entry", async () => {
    const hidden = new HiddenInviteStore(openStore());
    await hidden.hide("invite-1");
    await hidden.hide("invite-1");
    expect(hidden.hiddenInviteIds).toStrictEqual(["invite-1"]);
  });

  it("drops the oldest hide past the cap, so the invitation comes back rather than vanishing", async () => {
    const hidden = new HiddenInviteStore(openStore(), 2);
    await hidden.hide("invite-1");
    await hidden.hide("invite-2");
    await hidden.hide("invite-3");
    expect(hidden.hiddenInviteIds).toStrictEqual(["invite-2", "invite-3"]);
  });
});

describe("pruning", () => {
  it("drops a hide the daemon no longer lists an invitation for", async () => {
    const hidden = new HiddenInviteStore(openStore());
    await hidden.hide("invite-1");
    await hidden.hide("invite-2");
    await hidden.pruneAgainst(["invite-2"]);
    expect(hidden.hiddenInviteIds).toStrictEqual(["invite-2"]);
  });

  it("negative control: pruning against the same set writes nothing away", async () => {
    // Without this, the case above would pass over a prune that cleared the set
    // whatever it was handed.
    const hidden = new HiddenInviteStore(openStore());
    await hidden.hide("invite-1");
    await hidden.pruneAgainst(["invite-1", "invite-9"]);
    expect(hidden.hiddenInviteIds).toStrictEqual(["invite-1"]);
  });
});

describe("reading a record this build did not write", () => {
  it("keeps the identifiers and drops what is not one", () => {
    expect(narrowHiddenInviteIds(["invite-1", 7, null, "invite-2"])).toStrictEqual([
      "invite-1",
      "invite-2",
    ]);
  });

  it("refuses a record that is not a list at all", () => {
    expect(narrowHiddenInviteIds({ "invite-1": true })).toBeUndefined();
  });
});
