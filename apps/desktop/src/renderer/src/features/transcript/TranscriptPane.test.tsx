// What this pane hands its chrome, and the hole in the middle of it.
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE. The frame is `seats/ConsolePaneChrome`'s:
// which controls it draws and when, that a pane is named by its whole trail, that an
// unattributed pane borrows nobody's hue, and that a mismatched address is refused
// rather than thrown are all claims about that component, asserted once beside it.
// Repeating them here would be a second copy that agrees until one of them is edited,
// and it would make this suite red for a defect in another family's module.
//
// What is left is this family's half, and each of these fails in a way a screenshot
// would not catch:
//
//   • The pane mounts at its own KIND and hands over its own ADDRESS — the session
//     the route names. A pane that passed the wrong kind draws the wrong glyph and
//     the wrong name.
//   • The row slot reads the real seat. A host that held its own idea of whether
//     rows exist would be a second source of truth for a decision another plan
//     owns, and would keep rendering the reserved state after `renderer/src/timeline/` landed.
//   • The two absences are different absences. Both are quiet grey lines; only the
//     copy tells "the console cannot draw this" from "your session is empty".
//
// The fixtures live in `TimelinePaneFixtures.test-support.tsx`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "@renderer/store/session/session-store.js";
import { actorHueTokenName, tokenReference } from "@renderer/styles/tokens.js";
import { registerTimelineRowRenderer } from "@renderer/console/seats/index.js";
// The shared stub rather than a second one: `happy-dom` reports zero for both box
// readings, and a viewport with no box holds no rows — a case that stubbed only the
// height would be measuring its own setup.
import { withLaidOutViewport } from "./feed/components/TranscriptFeed.test-support.js";
// Deeply: the teardown is reached by tests alone, so it is not a door line.
import { unregisterTimelineRowRenderer } from "./transcript-row-renderer.js";
import { type TimelinePaneContext } from "./TranscriptPane.js";
import {
  TIMELINE_PANE_SESSION_ID,
  openSessionStoreWithPaneLog,
  paneContext,
  renderTimelinePane as renderPane,
} from "./TranscriptPane.test-support.js";

/** Every crumb the address contributed, without the pane's own name at the end. */
function addressCrumbs(pane: HTMLElement): readonly (string | null)[] {
  return [...pane.querySelectorAll(".meridian-pane__crumb:not(.meridian-pane__heading)")].map(
    (crumb) => crumb.textContent,
  );
}

afterEach(() => {
  // The seat is module-scope, so a case that filled it would leak into the next.
  unregisterTimelineRowRenderer();
  vi.restoreAllMocks();
});

describe("TimelinePane — what it hands the chrome", () => {
  it("mounts at its own kind, so the head wears the timeline glyph and name", () => {
    const pane = renderPane({ context: paneContext() });
    // The chrome derives both from the kind, so the kind is what this asserts: a
    // pane that passed another kind's string would draw that kind's mark and title
    // and nothing else on screen would say otherwise.
    expect(pane.classList.contains("meridian-pane--timeline")).toBe(true);
    expect(pane.querySelector(".meridian-pane__heading")?.textContent).toBe("Timeline");
    expect(pane.querySelector(".meridian-pane__kind svg")).not.toBeNull();
  });

  it("hands over the session the route names", () => {
    const pane = renderPane({ context: paneContext() });
    expect(addressCrumbs(pane)).toStrictEqual([TIMELINE_PANE_SESSION_ID]);
  });

  it("hands over no session at all rather than one the route does not name", () => {
    // Reachable: the auxiliary timeline window opens on a bare route and the frame
    // resolves its subject through the context picker before this pane sees one.
    // What the chrome then draws is its own business; what this pane owes is the
    // honest absence rather than a placeholder it invented.
    const pane = renderPane({ context: paneContext({}, null) });
    expect(addressCrumbs(pane)).toStrictEqual([]);
  });

  it("hands over the hue the deck attributed the pane to, untouched", () => {
    const actorHue = tokenReference(actorHueTokenName(3));
    const pane = renderPane({ context: paneContext({ focusHue: actorHue }) });
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe(actorHue);
  });

  it("negative control: an unattributed pane has no hue written on it", () => {
    // Fail-closed, rule 2, and the half this pane owns: it passes `undefined`
    // through rather than defaulting to a token of its own. The neutral boundary
    // the ring then takes is `seats/pane-chrome.css`' fallback, which is one answer
    // rather than a default written here and a fallback written there.
    const pane = renderPane({ context: paneContext() });
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe("");
  });
});

describe("TimelinePane — the row slot", () => {
  it("says the rows have not been built while the seat is empty", () => {
    const pane = renderPane({ context: paneContext() });
    const body = pane.querySelector(".meridian-pane__body");
    expect(body?.textContent).toContain("The timeline rows have not been built yet.");
    // The feed itself is the ledger's, and the ledger is not mounted at all while
    // there is no row body to mount it for.
    expect(pane.querySelector('[role="feed"]')).toBeNull();
  });

  it("says no session is open once the seat is filled but the pane has no store", () => {
    // Driven through the real seat rather than a local stand-in: a host holding its
    // own idea of whether rows exist would keep rendering the reserved state after
    // the row subtree landed, and no case here would notice.
    //
    // The two absences are different absences, which is the whole reason they are
    // two: "the console cannot draw this" is a fact about what has shipped, and "no
    // session is open in this pane" is a fact about this pane's address.
    registerTimelineRowRenderer("timeline-pane-test", () => null);
    const pane = renderPane({ context: paneContext() });
    const body = pane.querySelector(".meridian-pane__body");
    expect(body?.textContent).toContain("No session is open in this pane.");
    expect(body?.textContent).not.toContain("The timeline rows have not been built yet.");
  });

  it("mounts the ledger and renders one row per admitted event", () => {
    // The positive control for the whole composition: the seat is filled, a store is
    // open, and a log has landed in it, so the projection has to reach the screen.
    // Every earlier case here is an absence, and a pane that rendered NOTHING but
    // absences would have passed all of them.
    withLaidOutViewport();
    registerTimelineRowRenderer("timeline-pane-test", (rowProps) => (
      <article data-row-type={rowProps.row.type}>{rowProps.row.summary}</article>
    ));
    const sessionStore = openSessionStoreWithPaneLog();
    const pane = renderPane({
      context: paneContext({ sessionStore } as Partial<TimelinePaneContext>),
    });
    const feed = pane.querySelector('[role="feed"]');
    expect(feed).not.toBeNull();
    const rowTypes = [...pane.querySelectorAll("[data-row-type]")].map((row) =>
      row.getAttribute("data-row-type"),
    );
    expect(rowTypes).toStrictEqual(["session.created", "run.running"]);
    expect(pane.textContent).not.toContain("Nothing has happened in this session yet.");
  });

  it("negative control: the same store with no events shows the empty session", () => {
    registerTimelineRowRenderer("timeline-pane-test", () => null);
    const sessionStore = new SessionStore({ sessionId: TIMELINE_PANE_SESSION_ID });
    sessionStore.initialise({ cursor: -1, entities: [] });
    const pane = renderPane({
      context: paneContext({ sessionStore } as Partial<TimelinePaneContext>),
    });
    expect(pane.textContent).toContain("Nothing has happened in this session yet.");
    expect(pane.querySelectorAll("[data-row-type]")).toHaveLength(0);
  });
});
