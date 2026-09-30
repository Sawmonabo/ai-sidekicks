// What a region does with an announcement: it is subscribed rather than replaced, and a message
// reaches only the region its politeness names. Driven directly, not through the provider.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { LiveRegion } from "./LiveRegion.js";
import { regionsOf } from "@test/helpers/live-region.js";

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
    // Identity, not count: a replaced region is inserted carrying its text, which most readers
    // skip.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("puts a message in the region its politeness names and leaves the other silent", () => {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    const { container } = render(<LiveRegion announcer={announcer} />);

    act(() => {
      announcer.announce("the panes were reordered");
    });

    const [polite, assertive] = regionsOf(container);
    expect(polite?.textContent).toBe("the panes were reordered");
    expect(assertive?.textContent).toBe("");
  });
});
