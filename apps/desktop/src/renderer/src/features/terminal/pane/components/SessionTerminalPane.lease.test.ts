// The bound pane folds the lease off the session store's own timeline.
//
// What the line says is what the log said, and the write gate starts shut: a held lease
// is another device's until an identity read says otherwise.

import { describe, expect, it } from "vitest";

import { renderPane, storeThrough } from "./TerminalPane.test-support.js";

describe("terminal pane — bound to a session", () => {
  it("folds the holding off the log rather than off a take", () => {
    // Through the first transition, which is a `taken`. No identity read has landed
    // in this case, so the hold is one this device does not have.
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
    // Fail-closed: a held lease is another device's until a read says otherwise, and
    // the write gate follows that rather than the other way round.
    expect(mountPoint?.getAttribute("data-write-enabled")).toBe("false");
    expect(region.textContent).not.toContain("You may type into the shared shell.");
  });
});
