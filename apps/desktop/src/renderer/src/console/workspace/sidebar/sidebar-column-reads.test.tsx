// The sentence the sidebar says when its saved arrangement settles — once, per session.
//
// The workspace stays MOUNTED across a navigation between two open sessions, and the
// sidebar's model is re-minted with the session it is about. A latch that lived for the
// life of the mount therefore described the first session's settlement forever: the
// second session's saved open-section state, or its restore refusal, changed the column
// in front of somebody and was never said out loud.
//
// The real hook over a real `SidebarModel`, because what is being checked is which
// settlement the latch is about — and a stand-in model would be a second implementation
// of the thing whose identity is the whole question.

import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from "../../seats/index.js";
import { SIDEBAR_DEFAULT_WIDTH_PERCENT } from "../workspace-bounds.js";
import { type DecodedSidebarLayout } from "./model/sidebar-layout-record.js";
import { SidebarModel } from "./model/sidebar-model.js";
import { useSettlementAnnouncement } from "./sidebar-column-reads.js";

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
function SidebarSettlementProbe(props: {
  readonly model: SidebarModel;
  readonly announce: (sentence: string) => void;
}): React.JSX.Element {
  const snapshot = useSyncExternalStore(
    (listener) => props.model.subscribe(listener),
    () => props.model.snapshot,
  );
  useSettlementAnnouncement(props.model, snapshot, props.announce);
  return <div />;
}

describe("useSettlementAnnouncement — the settlement it describes is one session's", () => {
  afterEach(cleanup);

  it("says the next session's settlement too, rather than staying latched on the first", async () => {
    // The defect: a mount-lifetime boolean. It went true on the first session's
    // settlement and stayed true, so the second session's arrangement arrived on screen
    // in silence — the one case a live region exists for.
    const spoken: string[] = [];
    const firstSession = new SidebarModel();
    const { rerender } = render(
      <SidebarSettlementProbe
        model={firstSession}
        announce={(sentence) => spoken.push(sentence)}
      />,
    );
    await act(async () => {
      firstSession.restore(restoredWithShut(["goal"]));
    });
    expect(spoken).toHaveLength(1);

    // The route: the sidebar's model is re-minted with the session, and the column is
    // not remounted around it.
    const secondSession = new SidebarModel();
    rerender(
      <SidebarSettlementProbe
        model={secondSession}
        announce={(sentence) => spoken.push(sentence)}
      />,
    );
    await act(async () => {
      secondSession.restore(restoredWithShut(SECOND_SESSION_SHUT));
    });

    expect(spoken).toHaveLength(2);
    // The second sentence is the SECOND session's, not the first's said again: the two
    // arrangements shut a different number of sections, so the count names which one.
    expect(spoken[1]).toContain(
      `${String(SECOND_SESSION_SHUT.length)} of its ${String(SIDEBAR_SECTION_IDS.length)} sections collapsed`,
    );
  });

  it("still says one session's settlement exactly once, however often the column renders", async () => {
    // The half the latch is FOR, and the reason the fix is a keyed holder rather than a
    // deleted guard: a person opening a section re-renders this column, and a sentence
    // repeated on every act spends the window's one polite lane on nothing.
    const spoken: string[] = [];
    const session = new SidebarModel();
    const { rerender } = render(
      <SidebarSettlementProbe model={session} announce={(sentence) => spoken.push(sentence)} />,
    );
    await act(async () => {
      session.restore(restoredWithShut(["goal"]));
    });

    for (let pass = 0; pass < 3; pass += 1) {
      rerender(
        <SidebarSettlementProbe model={session} announce={(sentence) => spoken.push(sentence)} />,
      );
    }
    await act(async () => {
      session.toggleSection("channels");
    });

    expect(spoken).toHaveLength(1);
  });

  it("negative control: a sidebar whose arrangement has not settled says nothing", async () => {
    // Without this, a hook that announced on every render would pass the first case and
    // fail nothing — and one that announced on none would pass the second.
    const spoken: string[] = [];
    const session = new SidebarModel();
    render(
      <SidebarSettlementProbe model={session} announce={(sentence) => spoken.push(sentence)} />,
    );
    await act(async () => {
      session.toggleSection("channels");
    });

    expect(spoken).toStrictEqual([]);
  });
});
