// The pane context, the render, and the log the transcript pane suite is driven over.

import { render } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../fixtures/scenarios/empty-session.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import {
  TranscriptPane,
  type TranscriptPaneContext,
  type TranscriptPaneProps,
} from "./TranscriptPane.js";

/** The session id the pane suite's route and store share. */
export const TRANSCRIPT_PANE_SESSION_ID = "session-transcript";

/**
 * The pane context with the window store real and the other members cast. The pane
 * subscribes to the window store for its breadcrumb address; the stores it never reads
 * are cast because one of them opens a database.
 */
export function paneContext(
  overrides: Partial<TranscriptPaneContext> = {},
  sessionId: string | null = TRANSCRIPT_PANE_SESSION_ID,
): TranscriptPaneContext {
  // `null` rather than `undefined` for the session-less arm: an explicit `undefined`
  // re-applies the parameter default. `entity` is omitted rather than `undefined` because
  // an absent key is how the address union says the pane is scoped to the session.
  return {
    kind: "transcript",
    paneId: "transcript-pane",
    frameStore: new WindowStore({
      initialRoute: sessionId === null ? { kind: "sessions" } : { kind: "session", sessionId },
    }),
    ...overrides,
  } as unknown as TranscriptPaneContext;
}

/**
 * Render one mount of the pane under a fixture bridge and return the pane element. The
 * quiet scenario is enough: every row the suites assert on comes from a store they build.
 */
export function renderTranscriptPane(props: TranscriptPaneProps): HTMLElement {
  const { container } = render(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      <TranscriptPane {...props} />
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
