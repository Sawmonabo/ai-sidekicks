// What a region does with an announcement.
//
// `live-announcer.test.ts` owns the queue, the coalescing, and the clock, and
// `LiveAnnouncerProvider.test.tsx` owns who builds an announcer and who disposes
// it. What is left here is the pair of claims only the region can be wrong about:
// it is SUBSCRIBED rather than replaced when the announcement changes, and a
// message reaches the region its politeness names and no other.
//
// Driven against the region directly rather than through the provider, because the
// provider is not what these are about: a region rebuilt on every announcement
// would still pass a test that only counted the regions afterwards.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { LiveRegion } from "./LiveRegion.js";
import { regionsOf } from "./live-region.test-support.js";

afterEach(() => {
  cleanup();
});

describe("LiveRegion — the pair speaks without being replaced", () => {
  it("keeps both regions mounted while it speaks, rather than creating one to speak through", () => {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    const { container } = render(<LiveRegion announcer={announcer} />);
    const before = regionsOf(container);

    act(() => {
      announcer.announce("that node refused the attach", "assertive");
    });

    const after = regionsOf(container);
    expect(after).toHaveLength(2);
    // Identity, not just count: a region replaced between announcements is a region
    // inserted carrying its text, which most readers do not announce at all.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("puts a message in the region its politeness names and leaves the other silent", () => {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    const { container } = render(<LiveRegion announcer={announcer} />);

    act(() => {
      announcer.announce("the deck was reordered");
    });

    const [polite, assertive] = regionsOf(container);
    expect(polite?.textContent).toBe("the deck was reordered");
    expect(assertive?.textContent).toBe("");
  });
});
