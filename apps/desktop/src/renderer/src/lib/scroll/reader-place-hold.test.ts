// The reader's place held through items a nested window resized above the fold: each pass's
// changes are summed and written once, after the pass, against a real scroll controller over a
// detached container.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { ReaderPlaceHold } from "#renderer/lib/scroll/reader-place-hold.js";

describe("the reader's place held inside a row", () => {
  it("moves the scroller once per pass, by the sum of the pass's changes", async () => {
    // Writing per item would judge every later item of the pass against an offset the earlier
    // ones already moved.
    const scroll = new ScrollController({ clock: new ManualClock() });
    const scrollContainer = createCountingScrollContainer({ initialScrollTop: 1_000 });
    scroll.attach(scrollContainer);
    const hold = new ReaderPlaceHold(scroll);

    hold.add(30);
    hold.add(-10);
    hold.add(20);
    expect(scrollContainer.scrollTop).toBe(1_000);
    await Promise.resolve();
    expect(scrollContainer.scrollTop).toBe(1_040);
    expect(scroll.writeCount("measurement-compensation")).toBe(1);

    // The next pass starts from nothing held.
    hold.add(5);
    await Promise.resolve();
    expect(scrollContainer.scrollTop).toBe(1_045);
    expect(scroll.writeCount("measurement-compensation")).toBe(2);
  });

  it("judges each resized item where it stood as the pass began", async () => {
    // A window whose reader stands 1,000 px into it: two items above, then one the reader reads.
    const scroll = new ScrollController({ clock: new ManualClock() });
    const scrollContainer = createCountingScrollContainer({ initialScrollTop: 1_000 });
    scroll.attach(scrollContainer);
    const hold = new ReaderPlaceHold(scroll);

    hold.holdThroughResizedItem(500, 300, 1_000);
    // The second item ended at 1,000 as the pass began; the first one's change moved it to 1,300.
    hold.holdThroughResizedItem(1_300, 200, 1_000);
    // The item the reader reads across, moved by both, grows below the reader's place.
    hold.holdThroughResizedItem(1_800, 100, 1_000);
    await Promise.resolve();
    expect(scrollContainer.scrollTop).toBe(1_500);
  });
});
