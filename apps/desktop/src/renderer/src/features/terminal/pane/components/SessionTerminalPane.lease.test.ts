// The bound pane folds the lease off the session store's timeline, and the write gate starts
// shut: a held lease is another device's until an identity read says otherwise.

import { describe, expect, it } from "vitest";

import { renderPane, storeThrough } from "./TerminalPane.test-support.js";

describe("terminal pane — bound to a session", () => {
  it("folds the holding off the log rather than off a take", () => {
    // The first transition is a `taken`, and no identity read has landed, so the hold is not
    // this device's.
    const region = renderPane(storeThrough(1));
    expect(region.textContent).toContain("Held");
    expect(region.textContent).toContain("The shell is held from another device.");
  });

  it("renders the free lease the log's next transition establishes", () => {
    // The second transition is an automatic release carrying an explicit null holder.
    const region = renderPane(storeThrough(2));
    expect(region.textContent).toContain("Free");
    expect(region.textContent).toContain("Nobody holds the shell.");
  });

  it("shows no keyboard while the identity read has not landed", () => {
    const region = renderPane(storeThrough(1));
    const mountPoint = region.querySelector(".meridian-terminal-mount-point");
    // Fail-closed: the write gate follows the identity read, not the other way round.
    expect(mountPoint?.getAttribute("data-write-enabled")).toBe("false");
    expect(region.textContent).not.toContain("You may type into the shared shell.");
  });
});
