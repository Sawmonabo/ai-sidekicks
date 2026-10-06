// The pane context, the render, and the log the transcript pane suite is driven over.

import { render } from "@testing-library/react";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { paneContext } from "#test/helpers/pane-context.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { SessionStore } from "#renderer/store/session/store.js";
import {
  TranscriptPane,
  type TranscriptPaneContext,
  type TranscriptPaneProps,
} from "./TranscriptPane.js";

/** The session id the pane suite's route and store share. */
const TRANSCRIPT_PANE_SESSION_ID = "session-transcript";

/**
 * The transcript pane's context over the shared builder. The window store opens on the session's
 * route, because the pane subscribes to it for its breadcrumb address.
 */
export function transcriptPaneContext(
  sessionStore: SessionStore,
  sessionId: string = TRANSCRIPT_PANE_SESSION_ID,
): TranscriptPaneContext {
  return paneContext(
    { kind: "transcript" },
    {
      paneId: "transcript-pane",
      bridge: createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO }).bridge,
      sessionStore,
      frameStore: new WindowStore({ initialRoute: { kind: "session", sessionId } }),
    },
  );
}

/**
 * Render one mount of the pane under a fixture bridge and return the pane element. The
 * quiet scenario is enough: every row the suites assert on comes from a store they build.
 */
export function renderTranscriptPane(props: TranscriptPaneProps): HTMLElement {
  const { container } = render(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      <LiveAnnouncerProvider>
        <TranscriptPane {...props} />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("TranscriptPane rendered no pane element");
  }
  return pane;
}

/**
 * A real session store holding a two-event log; a fake store would let the projection,
 * fold and viewport reconcile all be wrong while the case stayed green.
 */
export function openSessionStoreWithPaneLog(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: TRANSCRIPT_PANE_SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch([
    {
      id: "event-0",
      sessionId: TRANSCRIPT_PANE_SESSION_ID,
      sequence: 0,
      cursor: "cursor-at-0",
      kind: "session.created",
      occurredAt: "2026-01-01T11:05:00.000Z",
      payload: { sessionId: TRANSCRIPT_PANE_SESSION_ID },
    },
    {
      id: "event-1",
      sessionId: TRANSCRIPT_PANE_SESSION_ID,
      sequence: 1,
      cursor: "cursor-at-1",
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
