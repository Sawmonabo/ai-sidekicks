// What the Agents pane lists: the session's agents as `agent.subscribe` opens with them and each
// later message moves one, an unreadable one failing the list rather than leaving one that may be
// wrong. And what re-reads its child-links read, counted on the read itself rather than inferred
// from a rendered row (a view can show a stale figure either way); that read's lifetime is
// `pane/models.test.ts`.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { ManualClock } from "#renderer/lib/clock.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import { sessionAgentLists } from "#renderer/store/agents/list.js";
import { agentEntry, agentListAcknowledgment } from "#renderer/store/agents/list.test-support.js";
import { bridgeOnClock, withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import { REFRESH_MAX_WAIT_MS } from "#renderer/lib/reads/refresh/caps.js";
import { RUN_QUEUED_EVENT_KIND } from "#renderer/store/session/events/run/state-kinds.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { createChildRunLinks } from "#renderer/services/daemon/child-run-links.js";
import { listAgents } from "./reads.js";
import { initializedStore } from "#test/helpers/session/store/fixtures.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { REJECTING_AGENTS_PANE_CALLS, unscriptedBridge } from "./reads.test-support.js";

const SESSION_ID = "019b7b30-0280-7c3d-8110-cca0117a0160" as SessionId;
const LEAD_ID = "019b7b30-0280-7c3d-8110-cca0117a0161";
const HELPER_ID = "019b7b30-0280-7c3d-8110-cca0117a0162";

describe("the Agents pane's agent list", () => {
  it("fills from the acknowledgment, then each message replaces or adds its own agent", () => {
    const deliveries: ((payload: unknown) => void)[] = [];
    const opened: unknown[] = [];
    const bridge = withDaemonSubscribe(
      bridgeOnClock("agent-list").bridge,
      (_passThrough, handler, request, _onEnded, event) => {
        expect(event).toBe("agent.subscribe");
        opened.push(request);
        deliveries.push(handler);
        return () => undefined;
      },
    );
    const feed = agentListFeedFor(bridge);
    const release = sessionAgentLists.watch(feed, SESSION_ID, () => undefined);
    const deliver = (payload: unknown): void => {
      deliveries[0]?.(payload);
    };
    const names = (): readonly string[] =>
      listAgents(sessionAgentLists.stateOf(feed, SESSION_ID), undefined).map((agent) => agent.name);

    expect(opened).toStrictEqual([{ sessionId: SESSION_ID }]);
    // An agent ahead of the list moves nothing: the list restates it.
    deliver(agentEntry(HELPER_ID, "Early"));
    expect(sessionAgentLists.stateOf(feed, SESSION_ID).status).toBe("reading");

    deliver(agentListAcknowledgment([agentEntry(LEAD_ID, "Lead")]));
    expect(names()).toStrictEqual(["Lead"]);

    deliver(agentEntry(HELPER_ID, "Reviewer"));
    expect(names()).toStrictEqual(["Lead", "Reviewer"]);
    expect(listAgents(sessionAgentLists.stateOf(feed, SESSION_ID), HELPER_ID)).toStrictEqual([
      agentEntry(HELPER_ID, "Reviewer"),
    ]);

    deliver(agentEntry(LEAD_ID, "Planner"));
    expect(names()).toStrictEqual(["Planner", "Reviewer"]);

    deliver({ agentId: LEAD_ID });
    expect(sessionAgentLists.stateOf(feed, SESSION_ID).status).toBe("failed");
    release();
    // The last reader gone, the list is gone with it.
    expect(sessionAgentLists.stateOf(feed, SESSION_ID).status).toBe("reading");
  });
});

/** A started child-run links read over a store this case owns, on frozen time. */
function startedChildRunLinks(
  sessionStore: SessionStore,
  clock: ManualClock,
): ReturnType<typeof createChildRunLinks> {
  const read = createChildRunLinks(
    unscriptedBridge("agent-child-run-links-signal").bridge,
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
  it("re-reads once for each run state change, helper start or end, and refused create", async () => {
    const sessionStore = initializedStore("session-signal");
    const clock = new ManualClock();
    const read = startedChildRunLinks(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    const kinds = [
      RUN_QUEUED_EVENT_KIND,
      "agent.run.completed",
      "agent.subagent.started",
      "agent.subagent.stopped",
      "agent.run.rejected",
    ] as const;
    for (const [index, kind] of kinds.entries()) {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, kind, index + 1));
      await settleReads(clock);
      expect(read.readCount).toBe(afterFirstRead + index + 1);
    }
  });

  it("re-reads nothing for a kind the child-run links read does not watch", async () => {
    const sessionStore = initializedStore("session-unwatched");
    const clock = new ManualClock();
    const read = startedChildRunLinks(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "agent.message.sent", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead);
  });
});
