// The catching-up line: when it shows, what a press on `Try again` asks for, and where
// the cause goes.
//
// Every case drives a REAL store on a manual clock handed to the window, so the dwell is
// the clock's and a case moves time rather than waiting on it.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { OpenSessionEntry } from "@renderer/store/session/open-session-entry.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../fixtures/scenarios/empty-session.js";
import { CATCH_UP_LINE_DWELL_MS } from "../hooks/useCatchUpLineShown.js";
import { SessionCatchUpLine } from "./SessionCatchUpLine.js";

const SESSION_ID = "session-catching-up";

let detachForwarder: (() => void) | undefined;

afterEach(() => {
  detachForwarder?.();
  detachForwarder = undefined;
});

function renderLine(
  sessionStore: SessionStore,
  clock: ManualClock,
  onTryAgain: (sessionId: string) => void = () => undefined,
): HTMLElement {
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  return render(
    <PlatformBridgeProvider bridge={fixture.bridge} clock={clock}>
      <SessionCatchUpLine sessionStore={sessionStore} onTryAgain={onTryAgain} />
    </PlatformBridgeProvider>,
  ).container;
}

function advance(clock: ManualClock, milliseconds: number): void {
  act(() => {
    clock.advance(milliseconds);
  });
}

describe("SessionCatchUpLine", () => {
  it("stays hidden when the repair ends before the dwell", () => {
    const clock = new ManualClock(0);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialize({ cursor: 0, entities: [] });
    const container = renderLine(sessionStore, clock);

    act(() => {
      sessionStore.markDegraded("sequence-gap");
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS - 1);
    const beforeTheRepairEnds = container.textContent;
    act(() => {
      sessionStore.initialize({ cursor: 1, entities: [] });
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS * 2);

    expect(beforeTheRepairEnds).toBe("");
    expect(container.textContent).toBe("");
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: a repair that outlasts the dwell shows the line", () => {
    const clock = new ManualClock(0);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialize({ cursor: 0, entities: [] });
    const container = renderLine(sessionStore, clock);

    act(() => {
      sessionStore.markDegraded("sequence-gap");
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS);

    expect(container.textContent).toBe("Catching up…");
  });

  it("asks for exactly one re-read of this session when Try again is pressed", () => {
    const clock = new ManualClock(0);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.markDegraded("read-failed");
    const rereads: string[] = [];
    const container = renderLine(sessionStore, clock, (sessionId) => {
      rereads.push(sessionId);
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS);

    const tryAgain = container.querySelector("button");
    if (tryAgain === null) {
      throw new Error("the failed line drew no Try again");
    }
    fireEvent.click(tryAgain);

    expect(rereads).toStrictEqual([SESSION_ID]);
  });

  it("sends the cause to the diagnostic capture and never to the screen", async () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry(SESSION_ID, {
      read: () => Promise.reject(new Error("the daemon refused the read")),
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
    const batches: string[] = [];
    detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    const container = renderLine(entry.store, clock);

    await act(async () => {
      entry.refreshScheduler.request("subscribe");
      clock.advance(21);
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    windowDiagnosticCapture.flush();
    entry.dispose();

    const records = batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { severity: string; detail: string })
      .filter((record) => record.detail.includes(SESSION_ID));
    expect(records).toStrictEqual([
      expect.objectContaining({
        severity: "warning",
        detail: `session ${SESSION_ID}: read-failed`,
      }),
    ]);
    expect(container.textContent).toBe("Couldn't catch up · Try again");
    expect(container.textContent).not.toContain("read-failed");
  });
});
