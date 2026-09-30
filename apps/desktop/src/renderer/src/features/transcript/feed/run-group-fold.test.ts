// The run group fold, driven with no store and no React. A run longer than the cap needs
// this file: a virtualized feed mounts a range whatever the fold admitted.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { act, renderHook } from "@testing-library/react";
import { createElement, useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../fixtures/scenarios/empty-session.js";
import { RUN_GROUP_VISIBLE_ROW_CAP } from "../structure/structure-caps.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { RunGroupFoldState } from "../run-groups/run-group-fold-state.js";
import { type RunGroup } from "../run-groups/run-groups.js";
import {
  selectRunGroupRowIdsWithinCap,
  foldRunGroupHeaders,
  narrowRunGroupToAdmittedRows,
  type RunGroupDisclosure,
} from "./run-group-fold.js";
import { useRunGroupDisclosure } from "./hooks/useRunGroupDisclosure.js";
import { transcriptFixtureStampAt } from "../transcript-logs.test-support.js";
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
      (row: TimelineRow) => row.id,
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

  it("negative control: the same run group shut still renders its receipt alone", () => {
    // Guards the cases above against a fold that admits nothing.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, false);
    expect(renderedMemberKeys(model)).toHaveLength(1);
    expect(model.rows[0]?.type).toBe("run.completed");
  });

  it("negative control: the cap's selector returns a short run group by identity", () => {
    // Guards against an unconditional slice, which allocates per run group on every fold.
    const shortRowIds = ["a", "b", "c"];
    expect(selectRunGroupRowIdsWithinCap(shortRowIds)).toBe(shortRowIds);
    expect(
      selectRunGroupRowIdsWithinCap(
        Array.from({ length: RUN_GROUP_VISIBLE_ROW_CAP + 1 }, (_u, i) => `r${String(i)}`),
      ),
    ).toHaveLength(RUN_GROUP_VISIBLE_ROW_CAP);
  });
});

describe("a run group re-sealed over the rows a narrowing admitted", () => {
  const MEMBER_COUNT = 6;

  function wholeRunGroup(): NonNullable<ReturnType<typeof runGroupOf>> {
    const runGroup = runGroupOf(deriveTranscriptWindow(oneRunLog(MEMBER_COUNT)));
    if (runGroup === undefined) {
      throw new Error("the fold produced no run group for a finished run");
    }
    return runGroup;
  }

  function runGroupOf(model: TranscriptWindowModel) {
    return model.runGroupByHeaderKey.get(RUN_ID);
  }

  it("re-counts membership and carries the run's own facts through untouched", () => {
    const runGroup = wholeRunGroup();
    const admitted = new Set(runGroup.rowIds.slice(0, 2));
    const narrowed = narrowRunGroupToAdmittedRows(runGroup, admitted);
    expect(narrowed?.rowCount).toBe(2);
    expect(narrowed?.rowIds).toStrictEqual([...admitted]);
    // Lifecycle and terminal are session facts; re-deriving them would turn a finished run live.
    expect(narrowed?.lifecycle).toBe("terminal");
    expect(narrowed?.terminalEventType).toBe(runGroup.terminalEventType);
    expect(narrowed?.terminalRowId).toBe(runGroup.terminalRowId);
  });

  it("answers undefined for a run group the narrowing admits no row of", () => {
    expect(narrowRunGroupToAdmittedRows(wholeRunGroup(), new Set<string>())).toBeUndefined();
  });

  it("negative control: a narrowing that took nothing returns the run group by identity", () => {
    const runGroup = wholeRunGroup();
    expect(narrowRunGroupToAdmittedRows(runGroup, new Set(runGroup.rowIds))).toBe(runGroup);
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

// The disclosure held for the life of the mount instead of keyed on the session, over the
// real `RunGroupFoldState`.
function useMountScopedRunGroupDisclosure(): RunGroupDisclosure {
  const [collapseState] = useState(() => new RunGroupFoldState());
  const [openedTerminalRunIds, setOpenedTerminalRunIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const publish = useCallback(() => {
    setOpenedTerminalRunIds(new Set(collapseState.openedTerminalRunIds));
  }, [collapseState]);
  const toggle = useCallback(
    (runGroup: RunGroup) => {
      if (collapseState.isOpen(runGroup)) {
        collapseState.close(runGroup);
      } else {
        collapseState.open(runGroup);
      }
      publish();
    },
    [collapseState, publish],
  );
  return { openedTerminalRunIds, toggle, collapseAllTerminal: () => undefined };
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

  it("negative control: a mount-scoped holder carries the last session's disclosure", () => {
    const disclosure = mountDisclosureOver(useMountScopedRunGroupDisclosure);
    act(() => {
      disclosure.result.current.toggle(terminalRunGroup());
    });

    act(() => {
      disclosure.rerender({ sessionId: OTHER_SESSION_ID });
    });

    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([RUN_ID]);
  });
});
