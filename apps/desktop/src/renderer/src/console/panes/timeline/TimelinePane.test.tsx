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
//     owns, and would keep rendering the reserved state after `timeline/` landed.
//   • The two absences are different absences. Both are quiet grey lines; only the
//     copy tells "the console cannot draw this" from "your session is empty".
//   • The focus ring falls back to the neutral boundary rather than to a
//     participant's colour, which is the fail-closed arm of rule 2.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { participantHueTokenName, tokenReference } from "../../tokens/index.js";
import {
  registerTimelineRowRenderer,
  unregisterTimelineRowRenderer,
  type ConsolePaneContext,
} from "../../workspace/index.js";
import { TIMELINE_ROW_SLOT, TimelinePane } from "./TimelinePane.js";

const SESSION_ID = "session-ledger";
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

/**
 * The pane context, with the members this component reads real and the rest cast.
 *
 * `FrameStore` is real because the pane subscribes to it for the address its
 * breadcrumb renders — a cast one would make that subscription untested. The three
 * stores it does not read are cast rather than constructed: one of them opens a
 * database, and building it to satisfy a field nothing reads would make the setup
 * the subject.
 */
function paneContext(
  overrides: Partial<ConsolePaneContext> = {},
  sessionId: string | null = SESSION_ID,
): ConsolePaneContext {
  // `null` rather than `undefined` for the session-less arm: passing `undefined`
  // explicitly re-applies a parameter default, so the one case that needs a bare
  // route would silently have got the addressed one.
  return {
    kind: "timeline",
    entity: undefined,
    paneId: "ledger-timeline",
    frameStore: new FrameStore({
      initialRoute: sessionId === null ? { kind: "sessions" } : { kind: "workspace", sessionId },
    }),
    focusHue: undefined,
    ...overrides,
  } as unknown as ConsolePaneContext;
}

/**
 * Render one pane under a bridge, because the ledger reads the console clock.
 *
 * The quiet scenario rather than a richer one: what this file needs from a bridge
 * is the frozen clock the viewport's scheduler runs on, and every row these cases
 * assert on comes from the store built below rather than from a scripted beat, so
 * a scenario that delivered its own would make the setup the subject.
 */
function renderPane(element: React.JSX.Element): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
      {element}
    </SidekicksBridgeProvider>,
  );
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("TimelinePane rendered no pane element");
  }
  return pane;
}

/**
 * A real store holding a two-event log.
 *
 * Real rather than a stand-in because the pane's whole job here is to read one, and
 * a fake store would let the projection, the fold, and the viewport's reconcile all
 * be wrong together while this case stayed green.
 */
function openSessionStoreWithLog(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch([
    {
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "session.created",
      occurredAt: "2026-01-01T11:05:00.000Z",
      payload: { sessionId: SESSION_ID },
    },
    {
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "run.running",
      occurredAt: "2026-01-01T11:05:01.000Z",
      payload: { sessionId: SESSION_ID, runId: "019b793b-7b60-740e-8110-d1a4c1150111" },
    },
  ]);
  return sessionStore;
}

/**
 * Give every element a viewport height, for the length of one case.
 *
 * `happy-dom` reports zero for `clientHeight`, and the virtualizer treats a zero
 * outer size as no range at all — so without this a mounted feed would hold no
 * rows for a reason that has nothing to do with the projection under test. The
 * same stub `LedgerViewport.test.tsx` takes, for the same reason.
 */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
}

afterEach(() => {
  // The seat is module-scope, so a case that filled it would leak into the next.
  unregisterTimelineRowRenderer();
  vi.restoreAllMocks();
});

describe("TimelinePane — the chrome", () => {
  it("names itself, and carries the kind glyph beside the name", () => {
    const pane = renderPane(<TimelinePane context={paneContext()} />);
    const heading = pane.querySelector(".meridian-pane__heading");
    // `aria-labelledby` rather than a literal id: `useId` mints one per mount, and
    // the claim is that the pane's accessible name IS this element's text.
    expect(heading?.id).toBe(pane.getAttribute("aria-labelledby"));
    expect(heading?.textContent).toBe("Timeline");
    expect(pane.querySelector(".meridian-pane__kind svg")).not.toBeNull();
  });

  it("renders the address as breadcrumb crumbs, wire-verbatim", () => {
    const pane = renderPane(
      <TimelinePane context={paneContext({ entity: { kind: "run", id: "run-01" } })} />,
    );
    const crumbs = [...pane.querySelectorAll(".meridian-pane__crumb")].map(
      (crumb) => crumb.textContent,
    );
    expect(crumbs).toStrictEqual([SESSION_ID, "run-01"]);
  });

  it("says the address names no session rather than rendering an empty strip", () => {
    // Reachable: the auxiliary timeline window opens on a bare route and the frame
    // resolves its subject through the context picker before this pane sees one.
    const pane = renderPane(<TimelinePane context={paneContext({}, null)} />);
    expect(pane.querySelectorAll(".meridian-pane__crumb")).toHaveLength(0);
    expect(pane.querySelector(".meridian-pane__crumb-absent")?.textContent).toBe("No session");
  });

  it("offers no close and no open-in-window when no host can perform either", () => {
    const pane = renderPane(<TimelinePane context={paneContext()} />);
    expect(pane.querySelectorAll(".meridian-pane__control")).toHaveLength(0);
  });

  it("negative control: a host that supplies them gets both, each labelled", () => {
    // Without this, the case above would pass over a pane that rendered no controls
    // under any circumstances — which is a different and permanently broken pane.
    const pane = renderPane(
      <TimelinePane
        context={paneContext()}
        onClose={() => undefined}
        onOpenInWindow={() => undefined}
      />,
    );
    const labels = [...pane.querySelectorAll(".meridian-pane__control")].map((control) =>
      control.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(["Open this timeline in its own window", "Close this pane"]);
  });

  it("takes the neutral boundary when the pane is attributed to nobody", () => {
    // Fail-closed, rule 2: an unattributed pane takes the control boundary rather
    // than step zero of the wheel, which belongs to somebody.
    const pane = renderPane(<TimelinePane context={paneContext()} />);
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe(tokenReference("edge-strong"));
  });

  it("negative control: an attributed pane takes the actor's hue", () => {
    const actorHue = tokenReference(participantHueTokenName(3));
    const pane = renderPane(<TimelinePane context={paneContext({ focusHue: actorHue })} />);
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe(actorHue);
  });
});

describe("TimelinePane — the row slot", () => {
  it("says the rows have not been built while the seat is empty", () => {
    const pane = renderPane(<TimelinePane context={paneContext()} />);
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
    const pane = renderPane(<TimelinePane context={paneContext()} />);
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
    const pane = renderPane(
      <TimelinePane context={paneContext({ sessionStore } as Partial<ConsolePaneContext>)} />,
    );
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
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
    const pane = renderPane(
      <TimelinePane context={paneContext({ sessionStore } as Partial<ConsolePaneContext>)} />,
    );
    expect(pane.textContent).toContain("Nothing has happened in this session yet.");
    expect(pane.querySelectorAll("[data-row-type]")).toHaveLength(0);
  });

  it("declares who owns the rows, what the mount owes them, and where the shell dies", () => {
    // Developer-facing and never rendered: the three answers live in the file
    // rather than in a reviewer's memory, and none of them reaches a screen.
    for (const claim of Object.values(TIMELINE_ROW_SLOT)) {
      expect(claim.length).toBeGreaterThan(0);
    }
    const pane = renderPane(<TimelinePane context={paneContext()} />);
    expect(pane.textContent).not.toContain(TIMELINE_ROW_SLOT.owningTask);
    expect(pane.textContent).not.toContain(TIMELINE_ROW_SLOT.deleteShellIn);
  });
});
