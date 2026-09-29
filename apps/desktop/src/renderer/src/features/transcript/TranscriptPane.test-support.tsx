// The pane context, the render, and the log the transcript pane suite is driven over.
//
// The seat teardown is NOT here: it is an `afterEach`, which the suite states beside its
// own cases.

import { render } from "@testing-library/react";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../fixtures/scenarios/empty-session.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import {
  TranscriptPane,
  type TranscriptPaneContext,
  type TranscriptPaneProps,
} from "./TranscriptPane.js";

export const TRANSCRIPT_PANE_SESSION_ID = "session-transcript";

/**
 * The pane context, with the members this component reads real and the rest cast.
 *
 * `WindowStore` is real because the pane subscribes to it for the address its
 * breadcrumb renders — a cast one would make that subscription untested. The three
 * stores it does not read are cast rather than constructed: one of them opens a
 * database, and building it to satisfy a field nothing reads would make the setup
 * the subject.
 */
export function paneContext(
  overrides: Partial<TranscriptPaneContext> = {},
  sessionId: string | null = TRANSCRIPT_PANE_SESSION_ID,
): TranscriptPaneContext {
  // `null` rather than `undefined` for the session-less arm: passing `undefined`
  // explicitly re-applies a parameter default, so the one case that needs a bare
  // route would silently have got the addressed one.
  //
  // The `entity` member is omitted rather than set to `undefined`: this pane kind's
  // address arm makes it optional, and an absent key is how the union says the pane
  // is scoped to the session rather than to one of its entities.
  return {
    kind: "transcript",
    paneId: "transcript-pane",
    frameStore: new WindowStore({
      initialRoute: sessionId === null ? { kind: "sessions" } : { kind: "session", sessionId },
    }),
    focusHue: undefined,
    ...overrides,
  } as unknown as TranscriptPaneContext;
}

/**
 * Render one mount of the pane under a bridge, and answer the pane element.
 *
 * NO CHROME ARGUMENT ANY MORE. The frame is `seats/PaneFrame`, which the pane
 * imports downward through the seat door, so there is nothing left for a suite to
 * compose it with and the factory that existed to bind one is gone.
 *
 * The quiet scenario rather than a richer one: what these suites need from a bridge is
 * the frozen clock the viewport's scheduler runs on, and every row they assert on comes
 * from a store they build, so a scenario that delivered its own would make the setup
 * the subject.
 */
export function renderTranscriptPane(props: TranscriptPaneProps): HTMLElement {
  const { container } = render(
    <PlatformBridgeProvider bridge={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      <TranscriptPane {...props} />
    </PlatformBridgeProvider>,
  );
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("TranscriptPane rendered no pane element");
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
export function openSessionStoreWithPaneLog(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: TRANSCRIPT_PANE_SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch([
    {
      id: "event-0",
      sessionId: TRANSCRIPT_PANE_SESSION_ID,
      sequence: 0,
      kind: "session.created",
      occurredAt: "2026-01-01T11:05:00.000Z",
      payload: { sessionId: TRANSCRIPT_PANE_SESSION_ID },
    },
    {
      id: "event-1",
      sessionId: TRANSCRIPT_PANE_SESSION_ID,
      sequence: 1,
      kind: "run.running",
      occurredAt: "2026-01-01T11:05:01.000Z",
      payload: {
        sessionId: TRANSCRIPT_PANE_SESSION_ID,
        runId: "019b793b-7b60-740e-8110-d1a4c1150111",
      },
    },
  ]);
  return sessionStore;
}
