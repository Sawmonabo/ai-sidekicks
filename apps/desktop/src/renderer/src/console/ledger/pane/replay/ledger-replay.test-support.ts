// The chaptered log, its folds, and the mount every replay case is driven over.
//
// ONE HOME, because the three suites next door ask different questions of the same
// arrangement: `ledger-replay-reveal.test.ts` asks what a POSITION lets the viewport
// draw, `ledger-replay-window.test.ts` asks what happens to the WALK when the
// projection under it moves, and `ledger-replay-engine-lifetime.test.tsx` asks what
// the engine leaves armed on a pass that never reached the screen. A second copy of
// the chaptered log would be two logs that agree until one of them gains a row.

import { renderHook } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenarios/ledger-quiet.js";
import { ManualClock } from "../../../core/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { foldChapterHeaders } from "../feed/ledger-chapter-fold.js";
import { ledgerFixtureStampAt } from "../feed/ledger-feed-logs.test-support.js";
import {
  useLedgerReplay,
  type LedgerReplayInputs,
  type LedgerReplayState,
} from "./ledger-replay-window.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

export const CHAPTERED_SESSION_ID = "session-visible-window";
export const CHAPTER_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
/** Row instants are one second apart, so an elapsed figure names a row by index. */
export const ONE_ROW_MS = 1000;

/**
 * A finished run between two session-scoped rows.
 *
 * The leading general row is what makes "before the chapter" a position at all: a
 * folded chapter's receipt is otherwise the head of the engine's window, and every
 * position would be at or after it.
 */
export function chapteredLog(): readonly ConsoleSessionEvent[] {
  const runPayload = { sessionId: CHAPTERED_SESSION_ID, runId: CHAPTER_RUN_ID };
  return [
    {
      id: "e0",
      sessionId: CHAPTERED_SESSION_ID,
      sequence: 0,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(0),
      payload: {},
    },
    {
      id: "e1",
      sessionId: CHAPTERED_SESSION_ID,
      sequence: 1,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(1),
      payload: runPayload,
    },
    {
      id: "e2",
      sessionId: CHAPTERED_SESSION_ID,
      sequence: 2,
      kind: "assistant.message",
      occurredAt: ledgerFixtureStampAt(2),
      payload: runPayload,
    },
    {
      id: "e3",
      sessionId: CHAPTERED_SESSION_ID,
      sequence: 3,
      kind: "run.completed",
      occurredAt: ledgerFixtureStampAt(3),
      payload: runPayload,
    },
    {
      id: "e4",
      sessionId: CHAPTERED_SESSION_ID,
      sequence: 4,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(4),
      payload: {},
    },
  ];
}

/** That log, folded — shut by default, or with the chapter a person opened. */
export function foldedWindow(openedRunIds: readonly string[] = []): LedgerWindowModel {
  return foldChapterHeaders(deriveLedgerWindow(chapteredLog(), false), new Set(openedRunIds));
}

/**
 * A fixture bridge and the frozen clock every console subsystem under it reads.
 *
 * The clock is READ BACK from the bridge rather than handed to it, because
 * `consoleClockFor` is the one answer to which clock a window runs on and a clock the
 * caller minted beside the bridge would be a second one that nothing under the
 * provider ever consults. The `instanceof` is what makes the reading admissible: a
 * `ConsoleClock` has no armed-work reading, and a case that counts armed work needs
 * the manual one it actually got.
 */
export function fixtureBridgeOnFrozenClock(): {
  readonly bridge: ConsoleBridge;
  readonly clock: ManualClock;
} {
  const bridge = createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO });
  const clock = bridge.scenarioEngine?.clock;
  if (!(clock instanceof ManualClock)) {
    throw new Error("the fixture bridge published no frozen clock to count armed work on");
  }
  return { bridge, clock };
}

/** Everything under one provider, so a claim renders the tree the console renders. */
export function underBridge(bridge: ConsoleBridge, children: ReactNode): ReactElement {
  return createElement(SidekicksBridgeProvider, { bridge, children });
}

/**
 * The replay hook under a bridge, because the replay reads the console clock.
 *
 * One wrapper for every case, so a second answer to which clock a replay runs on is
 * not reachable from a suite.
 */
export function mountReplayOver(
  initialProps: LedgerReplayInputs,
): ReturnType<typeof renderHook<LedgerReplayState, LedgerReplayInputs>> {
  const { bridge } = fixtureBridgeOnFrozenClock();
  return renderHook((replayInputs: LedgerReplayInputs) => useLedgerReplay(replayInputs), {
    initialProps,
    wrapper: ({ children }: { readonly children?: ReactNode }) => underBridge(bridge, children),
  });
}
