// What re-reads the Agents pane's child-links read, counted on the read itself rather than
// inferred from a rendered row (a view can show a stale figure either way). The read's
// lifetime is `pane/agents-pane-models.test.ts`.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_MAX_WAIT_MS } from "@renderer/lib/reads/refresh-caps.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import { createChildRunLinks } from "./agent-reads.js";
import { initializedStore } from "@test/helpers/session-store-fixtures.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { REJECTING_AGENTS_PANE_CALLS } from "./agent-reads.test-support.js";

/** A started child-run links read over a store this case owns, on frozen time. */
function startedChildRunLinks(
  sessionStore: SessionStore,
  clock: ManualClock,
): ReturnType<typeof createChildRunLinks> {
  const read = createChildRunLinks(
    sessionStore,
    clock,
    REJECTING_AGENTS_PANE_CALLS.readChildRunLinks,
  );
  read.start();
  return read;
}

/** Let every refresh armed inside the coalescing window fall due. */
async function settleReads(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_MAX_WAIT_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await crossMacrotaskBoundary();
    }
  });
}

describe("the Agents pane's models — what re-reads the session's child links", () => {
  it("re-reads once when a run is queued, and once when a create is refused", async () => {
    const sessionStore = initializedStore("session-signal");
    const clock = new ManualClock();
    const read = startedChildRunLinks(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.queued", 1));
    await settleReads(clock);
    expect(read.readCount).toBe(afterFirstRead + 1);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "orchestration.rejected", 2));
    await settleReads(clock);
    expect(read.readCount).toBe(afterFirstRead + 2);
  });

  it("re-reads nothing for a kind the child-run links read does not watch", async () => {
    const sessionStore = initializedStore("session-unwatched");
    const clock = new ManualClock();
    const read = startedChildRunLinks(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "assistant.message", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead);
  });
});
