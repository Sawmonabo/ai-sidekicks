// A run's header as the app opens a session at its tail, the event naming who acts for the run
// pages up in history: the header names the agent from the facts the opening read served, before
// any page brings that event, and still names it once the reader has read back to it and returned.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import { mountPagedHistory } from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";

import {
  PAGED_SESSION_ID,
  pagedSessionEventAt,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "#renderer/features/transcript/logs.test-support.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** A run many pages longer than the opening read, so the event naming its agent lies far back. */
const LOG_EVENT_COUNT = 400;
/** A person's message steering the run near its end, so a stretch and its header open there. */
const STEERING_MESSAGE_INDEX = LOG_EVENT_COUNT - 5;
const RUN_ID = "019b793b-7b60-740e-8110-00000000a11e";
const ACTOR = "agent-builder";
const ACTOR_SELECTOR = ".meridian-run-group-header__actor";

/** The log's event at `index`: the run's start naming its agent, a person's message, or a call. */
function runEventAt(index: number): ProjectedSessionEvent {
  if (index === STEERING_MESSAGE_INDEX) {
    return pagedSessionEventAt(index);
  }
  const common = {
    id: transcriptFixtureEventId(index),
    sessionId: PAGED_SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    occurredAt: transcriptFixtureStampAt(index),
    runStamp: { position: index, epoch: 0 },
  };
  if (index === 0) {
    return {
      ...common,
      kind: "run.running",
      actorId: ACTOR,
      payload: { sessionId: PAGED_SESSION_ID, runId: RUN_ID, newState: "running" },
    };
  }
  return {
    ...common,
    kind: "tool.invoked",
    payload: {
      sessionId: PAGED_SESSION_ID,
      runId: RUN_ID,
      toolName: `tool_${String(index)}`,
      toolCallId: `call-${String(index)}`,
      [CONTENT_LENGTH_PAYLOAD_KEY]: 64,
    },
  };
}

/** The agent each drawn run header names, in drawn order. */
function namedActorsIn(scroller: HTMLElement): string[] {
  return [...scroller.querySelectorAll(ACTOR_SELECTOR)].map((actor) => actor.textContent);
}

describe("a run's header opened at the tail", () => {
  it("names the agent the opening read served, before and after reading back to its event", async () => {
    const { scroller, sessionStore } = await mountPagedHistory(
      Array.from({ length: LOG_EVENT_COUNT }, (_, index) => runEventAt(index)),
    );
    const press = async (key: string): Promise<void> => {
      scroller.focus();
      await act(() => userEvent.keyboard(key));
      await settleFrames();
    };

    // The event naming the agent is pages up, and the header at the tail names it all the same.
    expect(sessionStore.snapshot().transcript[0]?.sequence).toBeGreaterThan(0);
    await expect.poll(() => namedActorsIn(scroller)).toStrictEqual([ACTOR]);

    // Home reads the log's first page, which holds that event, and End reads the tail back.
    await press("{Home}");
    await expect.poll(() => sessionStore.snapshot().transcript[0]?.sequence).toBe(0);
    await expect.poll(() => namedActorsIn(scroller)).toContain(ACTOR);
    await press("{End}");
    await expect.poll(() => sessionStore.snapshot().transcriptTail.following).toBe("live");
    await expect.poll(() => namedActorsIn(scroller)).toStrictEqual([ACTOR]);
  });
});
