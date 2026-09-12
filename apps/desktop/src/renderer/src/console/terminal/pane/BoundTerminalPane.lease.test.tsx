// The bound pane folds the lease off the session store's own timeline.
//
// What the line says is what the log said, the transition count is the fold's and not
// a number typed here, and the write gate starts shut — a held lease is another
// window's until an identity read says otherwise, which is
// `BoundTerminalPane.viewer-identity.test.tsx`'s subject.
//
// The emulator mounts anyway, above a line that says in words that no output stream is
// registered — the state that would otherwise read as "the shell printed nothing".

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { leaseBeats, renderPane, storeThrough } from "./TerminalPane.test-support.js";

describe("terminal pane — bound to a session", () => {
  it("folds the holding off the log rather than off a claim", () => {
    // Through the first transition, which is a `taken`. No identity read has landed
    // in this case, so the hold is one this window does not have.
    const region = renderPane(storeThrough(1));
    expect(region.textContent).toContain("Held");
    expect(region.textContent).toContain("The shell is held from another window.");
  });

  it("renders the free lease the log's next transition establishes", () => {
    // The second transition is a `released` carrying an explicit null holder.
    const region = renderPane(storeThrough(2));
    expect(region.textContent).toContain("Free");
    expect(region.textContent).toContain("Nobody holds the shell.");
  });

  it("counts every transition the log carries", () => {
    const disclosure = renderPane(storeThrough(leaseBeats.length)).querySelector(
      ".meridian-lease-line__disclosure",
    );
    // Counted off the scenario rather than written down: the fold's count is the
    // claim, and a number typed here would only restate the fixture.
    expect(leaseBeats.length).toBeGreaterThan(0);
    expect(disclosure?.textContent).toContain(String(leaseBeats.length));
  });

  it("shows no keyboard while the identity read has not landed", () => {
    const region = renderPane(storeThrough(1));
    const host = region.querySelector(".meridian-terminal-host");
    // Fail-closed: a held lease is another window's until a read says otherwise, and
    // the write gate follows that rather than the other way round.
    expect(host?.getAttribute("data-write-enabled")).toBe("false");
    expect(region.textContent).not.toContain("You may type into the shared shell.");
  });

  it("mounts the emulator and says in words that no output stream is registered", async () => {
    const region = renderPane(storeThrough(1));
    expect(region.querySelector(".meridian-terminal-host")).not.toBeNull();
    await waitFor(() => {
      expect(region.textContent).toContain("No output stream");
    });
    // The refusal carried is the port's own: it names the wire that is missing
    // rather than a sentence this pane wrote.
    expect(region.textContent).toContain("terminal pane as a renderer surface");
    expect(region.textContent).toContain("not registered on this build yet");
  });

  it("negative control: it does not render the absence that would look finished", () => {
    const region = renderPane(storeThrough(1));
    const absences = [...region.querySelectorAll(".meridian-nothing")];
    expect(absences.length).toBeGreaterThan(0);
    for (const absence of absences) {
      // `empty` would say the shell printed nothing and the node roster is read. Both
      // are claims this pane has no read behind.
      expect(absence.className).not.toContain("meridian-nothing--empty");
    }
  });
});
