// The timeline pane's chrome, and the hole in the middle of it.
//
// Four claims, and each of them fails in a way a screenshot would not catch:
//
//   • The two host-supplied controls are ABSENT rather than disabled when nobody
//     can perform their act. A disabled button reads as "not now"; the truth is
//     that the deck has not shipped, and a control drawn either way looks the same
//     in a capture.
//   • The row slot reads the real seat. A host that held its own idea of whether
//     rows exist would be a second source of truth for a decision another plan
//     owns, and would keep rendering the reserved state after `renderer/src/timeline/` landed.
//   • The two absences are different absences. Both are quiet grey lines; only the
//     copy tells "the console cannot draw this" from "your session is empty".
//   • The focus ring falls back to the neutral boundary rather than to a
//     participant's colour, which is the fail-closed arm of rule 2.
//
// What a CHANNEL ADDRESS narrows is `TimelinePaneScope.test.tsx`': the two suites
// mount the same pane and ask different things of it, and the fixtures they share
// live in `TimelinePaneFixtures.test-support.tsx`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../../store/index.js";
import { participantHueTokenName, tokenReference } from "../../tokens/index.js";
import { registerTimelineRowRenderer } from "../../seats/index.js";
// The shared stub rather than a second one: `happy-dom` reports zero for both box
// readings, and a viewport with no box holds no rows — a case that stubbed only the
// height would be measuring its own setup.
import { withLaidOutViewport } from "./feed/LedgerFeedFixtures.test-support.js";
// Deeply: the teardown is reached by tests alone, so it is not a door line.
import { unregisterTimelineRowRenderer } from "../../seats/timeline-row-slot.js";
import { TIMELINE_ROW_SLOT, type TimelinePaneContext } from "./TimelinePane.js";
import {
  TIMELINE_PANE_SESSION_ID,
  openSessionStoreWithLog,
  paneContext,
  timelinePaneRenderer,
} from "./TimelinePaneFixtures.test-support.js";
// The chrome this pane is composed with, named once here as the pane board names it
// once: a suite may reach across families where the body it drives may not.
import { PaneHeader } from "../../workspace/index.js";

const renderPane = timelinePaneRenderer(PaneHeader);

/**
 * Every shape a governance id takes in this corpus.
 *
 * Written once here rather than as five `toContain` calls, so the negative control
 * below drives the same expression the claim does — two lists would agree until one
 * of them gained a prefix.
 */
const GOVERNANCE_ID = /\b(?:Plan|Spec|ADR|BL|CP|I|T-023[a-z]?)-\d/;

afterEach(() => {
  // The seat is module-scope, so a case that filled it would leak into the next.
  unregisterTimelineRowRenderer();
  vi.restoreAllMocks();
});

describe("TimelinePane — the chrome", () => {
  it("names itself, and carries the kind glyph beside the name", () => {
    const pane = renderPane({ context: paneContext() });
    const heading = pane.querySelector(".meridian-pane__heading");
    // `aria-labelledby` rather than a literal id: `useId` mints one per mount, and
    // the claim is that the pane's accessible name IS this element's text.
    expect(heading?.id).toBe(pane.getAttribute("aria-labelledby"));
    expect(heading?.textContent).toBe("Timeline");
    expect(pane.querySelector(".meridian-pane__kind svg")).not.toBeNull();
  });

  it("renders the address as breadcrumb crumbs, wire-verbatim", () => {
    const pane = renderPane({
      // A CHANNEL, because that is the only entity a timeline is a view of: the
      // address union scopes each pane kind to its own entity kinds, so a run
      // reference here does not compile — which is the guard, not an inconvenience.
      context: paneContext({ entity: { kind: "channel", id: "channel-01" } }),
    });
    const crumbs = [...pane.querySelectorAll(".meridian-pane__crumb")].map(
      (crumb) => crumb.textContent,
    );
    expect(crumbs).toStrictEqual([TIMELINE_PANE_SESSION_ID, "channel-01"]);
  });

  it("says the address names no session rather than rendering an empty strip", () => {
    // Reachable: the auxiliary timeline window opens on a bare route and the frame
    // resolves its subject through the context picker before this pane sees one.
    const pane = renderPane({ context: paneContext({}, null) });
    expect(pane.querySelectorAll(".meridian-pane__crumb")).toHaveLength(0);
    expect(pane.querySelector(".meridian-pane__crumb-absent")?.textContent).toBe("No session");
  });

  it("offers no close and no open-in-window when no host can perform either", () => {
    const pane = renderPane({ context: paneContext() });
    expect(pane.querySelectorAll(".meridian-pane__control")).toHaveLength(0);
  });

  it("negative control: a host that supplies them gets both, each labelled", () => {
    // Without this, the case above would pass over a pane that rendered no controls
    // under any circumstances — which is a different and permanently broken pane.
    const pane = renderPane({
      context: paneContext(),
      onClose: () => undefined,
      onOpenInWindow: () => undefined,
    });
    const labels = [...pane.querySelectorAll(".meridian-pane__control")].map((control) =>
      control.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(["Open this timeline in its own window", "Close this pane"]);
  });

  it("takes the neutral boundary when the pane is attributed to nobody", () => {
    // Fail-closed, rule 2: an unattributed pane takes the control boundary rather
    // than step zero of the wheel, which belongs to somebody.
    const pane = renderPane({ context: paneContext() });
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe(tokenReference("edge-strong"));
  });

  it("negative control: an attributed pane takes the actor's hue", () => {
    const actorHue = tokenReference(participantHueTokenName(3));
    const pane = renderPane({ context: paneContext({ focusHue: actorHue }) });
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe(actorHue);
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
    const sessionStore = openSessionStoreWithLog();
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
    sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
    const pane = renderPane({
      context: paneContext({ sessionStore } as Partial<TimelinePaneContext>),
    });
    expect(pane.textContent).toContain("Nothing has happened in this session yet.");
    expect(pane.querySelectorAll("[data-row-type]")).toHaveLength(0);
  });

  it("declares who owns the rows, what the mount owes them, and where the shell dies", () => {
    // Developer-facing and never rendered: the three answers live in the file
    // rather than in a reviewer's memory, and none of them reaches a screen.
    for (const claim of Object.values(TIMELINE_ROW_SLOT)) {
      expect(claim.length).toBeGreaterThan(0);
    }
    const pane = renderPane({ context: paneContext() });
    expect(pane.textContent).not.toContain(TIMELINE_ROW_SLOT.owningTask);
    expect(pane.textContent).not.toContain(TIMELINE_ROW_SLOT.deleteShellIn);
  });

  it("carries no governance id in any of the three, so a bad render cannot leak one", () => {
    // The reason "never rendered" is not the whole rule. A string is one careless
    // render away from a screen and a comment is not, so the ids the slot is ABOUT
    // live in the comment above it and the values say the same thing in English.
    for (const claim of Object.values(TIMELINE_ROW_SLOT)) {
      expect(claim).not.toMatch(GOVERNANCE_ID);
    }
  });

  it("negative control: the pattern matches the ids these values used to carry", () => {
    // Without this the case above would pass over an expression that matched
    // nothing — which is how a tripwire reports a clean tree it never read.
    expect("Plan-013 Phase 4 — the Spec-013 row vocabulary").toMatch(GOVERNANCE_ID);
    for (const foil of ["ADR-016", "BL-108", "CP-023-9", "I-023-15", "T-023p-1C-2"]) {
      expect(foil).toMatch(GOVERNANCE_ID);
    }
  });
});
