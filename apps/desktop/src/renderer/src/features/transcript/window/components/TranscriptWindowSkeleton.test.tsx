// Drives a real store, not a stub: the claim is that the skeleton follows `initialized` and
// `degradedCause`, and a fixture that published those itself would pass over a component reading
// neither.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TranscriptWindowSkeleton } from "./TranscriptWindowSkeleton.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

function openStore(): SessionStore {
  return new SessionStore({ sessionId: "session-1" });
}

function skeletonOf(sessionStore: SessionStore): HTMLElement {
  return render(<TranscriptWindowSkeleton sessionStore={sessionStore} />).container;
}

describe("before the first read lands", () => {
  it("draws a window of skeleton rows rather than an empty session", () => {
    const container = skeletonOf(openStore());
    expect(container.querySelectorAll(".meridian-transcript-window-skeleton__row")).toHaveLength(
      12,
    );
  });

  it("announces itself as a read in flight", () => {
    const skeleton = skeletonOf(openStore()).querySelector(".meridian-transcript-window-skeleton");
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
  });
});

describe("when the first read itself failed", () => {
  it("draws no skeleton rows for a read that is already over", () => {
    // A failed first read leaves the store uninitialized with `read-failed` standing; the
    // skeleton must not stay up over a read that is over.
    const sessionStore = openStore();
    sessionStore.markReadFailed();

    const container = skeletonOf(sessionStore);

    expect(container.querySelectorAll(".meridian-transcript-window-skeleton__row")).toHaveLength(0);
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });
});

describe("once the window has been read", () => {
  it("draws nothing at all", () => {
    const sessionStore = openStore();
    sessionStore.initialize({ cursor: 0, entities: [] });
    expect(skeletonOf(sessionStore).textContent).toBe("");
  });
});
