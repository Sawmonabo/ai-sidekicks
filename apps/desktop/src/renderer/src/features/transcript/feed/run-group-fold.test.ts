// The run group fold, driven with no store and no React. A run longer than the cap needs
// this file: a virtualized feed mounts a range whatever the fold admitted.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row/row";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { FixtureBridgeProvider } from "@test/helpers/app/frame-fixtures.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "@fixtures/scenarios/empty-session.js";
import { RUN_GROUP_VISIBLE_ROW_CAP } from "../run-groups/run-group-body.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { type RunGroup } from "../run-groups/run-groups.js";
import { foldRunGroupHeaders, type RunGroupDisclosure } from "./run-group-fold.js";
import { useRunGroupDisclosure } from "./hooks/useRunGroupDisclosure.js";
import {
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../transcript-logs.test-support.js";
import { deriveTranscriptWindow, type TranscriptWindowModel } from "../window/transcript-window.js";

const SESSION_ID = "session-run-group-cap";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
const ROWS_PAST_THE_CAP = 5;

// One finished run of `memberCount` rows, alone, so every figure below is that run's.
function oneRunLog(memberCount: number): readonly ProjectedSessionEvent[] {
  const payload = { sessionId: SESSION_ID, runId: RUN_ID };
  return Array.from({ length: memberCount }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind: index === memberCount - 1 ? "run.completed" : "assistant.message",
    occurredAt: transcriptFixtureStampAt(index),
    payload,
  }));
}

function foldedOverOneRun(memberCount: number, isOpen: boolean): TranscriptWindowModel {
  return foldRunGroupHeaders(
    deriveTranscriptWindow(oneRunLog(memberCount)),
    new Set(isOpen ? [RUN_ID] : []),
  ).window;
}

function renderedMemberKeys(model: TranscriptWindowModel): readonly string[] {
  return model.viewportRows.filter((row) => row.parentKey === RUN_ID).map((row) => row.key);
}

describe("an opened run group admits the cap's own window and no more", () => {
  const OVER_CAP_MEMBER_COUNT = RUN_GROUP_VISIBLE_ROW_CAP + ROWS_PAST_THE_CAP;

  it("renders exactly the cap when a run longer than it is opened", () => {
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    expect(renderedMemberKeys(model)).toHaveLength(RUN_GROUP_VISIBLE_ROW_CAP);
    expect(model.rows).toHaveLength(RUN_GROUP_VISIBLE_ROW_CAP);
  });

  it("keeps the newest rows and clips the run's older head", () => {
    // Newest, not oldest: the body clips behind a top-edge fade.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    const everyMemberId = deriveTranscriptWindow(oneRunLog(OVER_CAP_MEMBER_COUNT)).rows.map(
      (row: TranscriptEventRow) => row.id,
    );
    const rendered = new Set(renderedMemberKeys(model));
    for (const clippedId of everyMemberId.slice(0, ROWS_PAST_THE_CAP)) {
      expect(rendered.has(clippedId)).toBe(false);
    }
    for (const keptId of everyMemberId.slice(ROWS_PAST_THE_CAP)) {
      expect(rendered.has(keptId)).toBe(true);
    }
  });

  it("reports as clipped exactly what it did not render", () => {
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    const runGroup = model.runGroupByHeaderKey.get(RUN_ID);
    expect(runGroup?.clippedRowCount).toBe(ROWS_PAST_THE_CAP);
    expect((runGroup?.rowCount ?? 0) - renderedMemberKeys(model).length).toBe(
      runGroup?.clippedRowCount,
    );
  });

  it("opens a run group under the cap whole", () => {
    const memberCount = RUN_GROUP_VISIBLE_ROW_CAP - 1;
    const model = foldedOverOneRun(memberCount, true);
    expect(renderedMemberKeys(model)).toHaveLength(memberCount);
    expect(model.runGroupByHeaderKey.get(RUN_ID)?.clippedRowCount).toBe(0);
  });

  it("the same run group shut still renders its receipt alone", () => {
    // Guards the cases above against a fold that admits nothing.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, false);
    expect(renderedMemberKeys(model)).toHaveLength(1);
    expect(model.rows[0]?.type).toBe("run.completed");
  });
});

// Derived through the real projection so the toggle gets the object the fold produces.
function terminalRunGroup(): RunGroup {
  const runGroup = deriveTranscriptWindow(oneRunLog(3)).runGroupByHeaderKey.get(RUN_ID);
  if (runGroup === undefined) {
    throw new Error("the fixture log produced no terminal run group");
  }
  return runGroup;
}

describe("the run group disclosure follows the session the pane is a log of", () => {
  const OTHER_SESSION_ID = "session-the-reader-moved-to";

  // The pane is not remounted between sessions: open session stores stay alive, so
  // navigating re-renders this position.
  function mountDisclosureOver(
    useDisclosure: (sessionId: string) => RunGroupDisclosure,
  ): ReturnType<typeof renderHook<RunGroupDisclosure, { readonly sessionId: string }>> {
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    return renderHook((props: { readonly sessionId: string }) => useDisclosure(props.sessionId), {
      initialProps: { sessionId: SESSION_ID },
      wrapper: ({ children }: { readonly children?: React.ReactNode }) =>
        createElement(FixtureBridgeProvider, { fixture, children }),
    });
  }

  it("opens the next session's run groups fresh, whatever was opened in the last", () => {
    const disclosure = mountDisclosureOver(useRunGroupDisclosure);
    act(() => {
      disclosure.result.current.toggle(terminalRunGroup());
    });
    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([RUN_ID]);

    act(() => {
      disclosure.rerender({ sessionId: OTHER_SESSION_ID });
    });

    // A run id belongs to the session that minted it; carrying the set over opens the wrong group.
    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([]);
  });

  it("holds a session's own disclosure across a re-render at that same session", () => {
    // Guards against a fix that resets on every render, folding a group whenever a row arrives.
    const disclosure = mountDisclosureOver(useRunGroupDisclosure);
    act(() => {
      disclosure.result.current.toggle(terminalRunGroup());
    });

    act(() => {
      disclosure.rerender({ sessionId: SESSION_ID });
    });

    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([RUN_ID]);
  });
});
