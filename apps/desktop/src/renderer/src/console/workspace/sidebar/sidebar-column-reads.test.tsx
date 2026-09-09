// The sentence the sidebar says when its saved arrangement settles — once, per session.
//
// The workspace stays MOUNTED across a navigation between two open sessions, and the
// sidebar's model is re-minted with the session it is about. A memory that lived for the
// life of the mount therefore described the first session's settlement forever: the
// second session's saved open-section state, or its restore refusal, changed the column
// in front of somebody and was never said out loud.
//
// AND THE HARD CASE IS THE ONE WHERE THE TWO SESSIONS AGREE. The hook composes over
// `primitives/reading-announcement.ts`'s one latch, whose memory is the SENTENCE and
// lives for the mount — so two sessions that restored the same arrangement say the same
// words, and a composition that only handed the latch its sentence would have the second
// silently swallowed. That case is the planted control below, and it is the reason the
// unsettled arm hands over an empty array rather than `undefined`.
//
// The real hook over a real `SidebarModel` and the real announcer, because what is being
// checked is which settlement the memory is about — and a stand-in for either would be a
// second implementation of the thing whose identity is the whole question. What a person
// would HEAR is the polite region's text, so that is what these cases read, and the
// announcer runs on frozen time: a message clears on a real timer otherwise, and "was it
// said again" becomes a question about how fast the runner happened to be.

import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../../core/index.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../primitives/index.js";
import { politeText } from "../../primitives/announce/live-region.test-support.js";
import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from "../../seats/index.js";
import { SIDEBAR_DEFAULT_WIDTH_PERCENT } from "../workspace-bounds.js";
import { type DecodedSidebarLayout } from "./model/sidebar-layout-record.js";
import { SidebarModel } from "./model/sidebar-model.js";
import { useSidebarSettlementAnnouncement } from "./sidebar-column-reads.js";

/** What the second session shut, so its sentence cannot be mistaken for the first's. */
const SECOND_SESSION_SHUT: readonly SidebarSectionId[] = ["goal", "runs"];

/** A settled arrangement with the named sections shut, so its sentence is distinctive. */
function restoredWithShut(sectionIds: readonly SidebarSectionId[]): DecodedSidebarLayout {
  return {
    state: {
      widthPercent: SIDEBAR_DEFAULT_WIDTH_PERCENT,
      isCollapsed: false,
      collapsedSectionIds: new Set(sectionIds),
    },
    refusals: [],
  };
}

/** The column's one settlement read, driven without the column's markup. */
function SidebarSettlementProbe(props: { readonly model: SidebarModel }): React.JSX.Element {
  const snapshot = useSyncExternalStore(
    (listener) => props.model.subscribe(listener),
    () => props.model.snapshot,
  );
  useSidebarSettlementAnnouncement(props.model, snapshot);
  return <div />;
}

/** What the probe hands a case: what has been said, the route, and the hold window. */
interface MountedProbe {
  /** The polite region's text right now — what a reader would have heard. */
  readonly spoken: () => string;
  /** Re-render the mounted column around a re-minted model, as a route does. */
  readonly route: (next: SidebarModel) => void;
  /**
   * Let the standing announcement expire, so the next reading is about the next thing
   * said rather than about what is still on the region from before.
   */
  readonly drain: () => void;
}

/** Mount the probe over an announcer this suite drives. */
function mountProbe(model: SidebarModel): MountedProbe {
  const clock = new ManualClock();
  const announcer = new LiveAnnouncer({ clock });
  const view = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <SidebarSettlementProbe model={model} />
    </LiveAnnouncerProvider>,
  );
  return {
    spoken: () => politeText(view.container),
    route: (next) => {
      act(() => {
        view.rerender(
          <LiveAnnouncerProvider announcer={announcer}>
            <SidebarSettlementProbe model={next} />
          </LiveAnnouncerProvider>,
        );
      });
    },
    drain: () => {
      act(() => {
        clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      });
    },
  };
}

describe("useSidebarSettlementAnnouncement — the settlement it describes is one session's", () => {
  afterEach(cleanup);

  it("says the next session's settlement too, rather than staying latched on the first", async () => {
    // The defect: a mount-lifetime boolean. It went true on the first session's
    // settlement and stayed true, so the second session's arrangement arrived on screen
    // in silence — the one case a live region exists for.
    const firstSession = new SidebarModel();
    const probe = mountProbe(firstSession);
    await act(async () => {
      firstSession.restore(restoredWithShut(["goal"]));
    });
    expect(probe.spoken()).toContain(
      `1 of its ${String(SIDEBAR_SECTION_IDS.length)} sections collapsed`,
    );
    probe.drain();

    // The route: the sidebar's model is re-minted with the session, and the column is
    // not remounted around it.
    const secondSession = new SidebarModel();
    probe.route(secondSession);
    await act(async () => {
      secondSession.restore(restoredWithShut(SECOND_SESSION_SHUT));
    });

    // The second sentence is the SECOND session's, not the first's said again: the two
    // arrangements shut a different number of sections, so the count names which one.
    expect(probe.spoken()).toContain(
      `${String(SECOND_SESSION_SHUT.length)} of its ${String(SIDEBAR_SECTION_IDS.length)} sections collapsed`,
    );
  });

  it("says the next session's settlement even where the two sessions read the same", async () => {
    // THE PLANTED CONTROL for the composition, and the case above it cannot make: the
    // shared latch's memory is the SENTENCE and outlives the model, so a hook that
    // handed it the settled sentence and nothing else is green above and silent here.
    // Two sessions restoring the identical arrangement say identical words, and the
    // second person still has to hear them.
    const firstSession = new SidebarModel();
    const probe = mountProbe(firstSession);
    await act(async () => {
      firstSession.restore(restoredWithShut(["goal"]));
    });
    const firstSentence = probe.spoken();
    expect(firstSentence).not.toBe("");
    probe.drain();
    expect(probe.spoken()).toBe("");

    const secondSession = new SidebarModel();
    probe.route(secondSession);
    await act(async () => {
      secondSession.restore(restoredWithShut(["goal"]));
    });

    expect(probe.spoken()).toBe(firstSentence);
  });

  it("still says one session's settlement exactly once, however often the column renders", async () => {
    // The half the memory is FOR, and the reason the fix is a keyed holder rather than a
    // deleted guard: a person opening a section re-renders this column, and a sentence
    // repeated on every act spends the window's one polite lane on nothing. The words
    // are also the ones the session SETTLED with, captured at the transition rather than
    // recomputed — a toggle after the fact moves the column and not the sentence.
    const session = new SidebarModel();
    const probe = mountProbe(session);
    await act(async () => {
      session.restore(restoredWithShut(["goal"]));
    });
    expect(probe.spoken()).not.toBe("");
    probe.drain();

    for (let pass = 0; pass < 3; pass += 1) {
      probe.route(session);
    }
    await act(async () => {
      session.toggleSection("channels");
    });

    expect(probe.spoken()).toBe("");
  });

  it("negative control: a sidebar whose arrangement has not settled says nothing", async () => {
    // Without this, a hook that announced on every render would pass the first case and
    // fail nothing — and one that announced on none would pass the third.
    const session = new SidebarModel();
    const probe = mountProbe(session);
    await act(async () => {
      session.toggleSection("channels");
    });

    expect(probe.spoken()).toBe("");
  });
});
