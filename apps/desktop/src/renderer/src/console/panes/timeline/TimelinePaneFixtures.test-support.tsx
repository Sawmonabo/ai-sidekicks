// The pane context, the render, and the log both timeline-pane suites are driven over.
//
// ONE HOME, because the two suites next door ask different questions of the same
// mount: `TimelinePane.test.tsx` asks what the CHROME and the row slot do, and
// `TimelinePaneScope.test.tsx` asks what a channel address narrows. A second
// `paneContext` would be a second answer to which members of the context this pane
// really reads, and the cast is exactly the part that must not be written twice.
//
// The seat teardown is NOT here. It is an `afterEach`, so a home shared by two files
// would register it once per importer and hide which suite owns its own cleanup —
// each suite states it beside its own cases.

import { render } from "@testing-library/react";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { type TimelinePaneContext } from "./TimelinePane.js";

export const TIMELINE_PANE_SESSION_ID = "session-ledger";

/**
 * The pane context, with the members this component reads real and the rest cast.
 *
 * `FrameStore` is real because the pane subscribes to it for the address its
 * breadcrumb renders — a cast one would make that subscription untested. The three
 * stores it does not read are cast rather than constructed: one of them opens a
 * database, and building it to satisfy a field nothing reads would make the setup
 * the subject.
 */
export function paneContext(
  overrides: Partial<TimelinePaneContext> = {},
  sessionId: string | null = TIMELINE_PANE_SESSION_ID,
): TimelinePaneContext {
  // `null` rather than `undefined` for the session-less arm: passing `undefined`
  // explicitly re-applies a parameter default, so the one case that needs a bare
  // route would silently have got the addressed one.
  //
  // The `entity` member is omitted rather than set to `undefined`: this pane kind's
  // address arm makes it optional, and an absent key is how the union says the pane
  // is scoped to the session rather than to one of its entities.
  return {
    kind: "timeline",
    paneId: "ledger-timeline",
    frameStore: new FrameStore({
      initialRoute: sessionId === null ? { kind: "sessions" } : { kind: "workspace", sessionId },
    }),
    focusHue: undefined,
    ...overrides,
  } as unknown as TimelinePaneContext;
}

/**
 * Render one pane under a bridge, because the ledger reads the console clock.
 *
 * The quiet scenario rather than a richer one: what this file needs from a bridge
 * is the frozen clock the viewport's scheduler runs on, and every row these cases
 * assert on comes from the store built below rather than from a scripted beat, so
 * a scenario that delivered its own would make the setup the subject.
 */
export function renderPane(element: React.JSX.Element): HTMLElement {
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
export function openSessionStoreWithLog(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: TIMELINE_PANE_SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch([
    {
      id: "event-0",
      sessionId: TIMELINE_PANE_SESSION_ID,
      sequence: 0,
      kind: "session.created",
      occurredAt: "2026-01-01T11:05:00.000Z",
      payload: { sessionId: TIMELINE_PANE_SESSION_ID },
    },
    {
      id: "event-1",
      sessionId: TIMELINE_PANE_SESSION_ID,
      sequence: 1,
      kind: "run.running",
      occurredAt: "2026-01-01T11:05:01.000Z",
      payload: {
        sessionId: TIMELINE_PANE_SESSION_ID,
        runId: "019b793b-7b60-740e-8110-d1a4c1150111",
      },
    },
  ]);
  return sessionStore;
}
