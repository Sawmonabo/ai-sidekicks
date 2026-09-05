// The runs pane's shared scaffolding: one pane, mounted over the fixture bridge.
//
// Both suites mount the SAME pane against the same scenario, because the claims are
// about a composition — the pane resolves a session and the body reads a stream
// against it — and a second mount helper would let the seat's cases and the body's
// cases drift into two different panes.

import { render } from "@testing-library/react";
import { type RunState } from "@ai-sidekicks/contracts";
import { paneContext } from "../pane-chrome.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { settleScheduledRead } from "../../bridge/scheduled-read.test-support.js";
import { ManualClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { RunsPane } from "./RunsPane.js";

export const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
// A canonical UUID: both `run.*` streams parse their registered request through
// the wire's `SessionId` brand before opening, so a non-UUID id refuses.
export const SESSION_ID = "019b7a22-2200-75e5-8510-ada11a5a44a5";

/** One transition on the wire's own shape. */
export function transition(
  previousState: RunState,
  currentState: RunState,
  runVersion: number,
): unknown {
  return {
    runId: RUN_ID,
    runVersion,
    previousState,
    currentState,
    timestamp: "2026-01-01T16:00:00.000Z",
  };
}

/** A bridge whose state stream replays a script and whose calls all refuse. */
export function scriptedBridge(deliveries: readonly unknown[]): ConsoleBridge {
  return {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => {
          throw { code: "run.not_found", message: "no such run" };
        },
        subscribe: (_event: string, handler: (payload: unknown) => void) => {
          for (const delivery of deliveries) {
            handler(delivery);
          }
          return () => undefined;
        },
      },
    },
    growth: {},
    source: "fixture",
    // The pane's snapshot reads are scheduled rather than taken inside their opens,
    // so this double carries the frozen clock they arm on: without it the queue shelf
    // would render its read-in-flight skeleton for the whole of every case, and a
    // case asserting that no skeleton is on screen would be failing on the wrong one.
    scenarioEngine: { clock: new ManualClock() },
  } as unknown as ConsoleBridge;
}

export async function renderPane(
  bridge: ConsoleBridge,
  withSession: boolean,
  seed?: (store: SessionStore) => void,
): Promise<HTMLElement> {
  const sessionStore = withSession ? new SessionStore({ sessionId: SESSION_ID }) : undefined;
  if (sessionStore !== undefined) {
    seed?.(sessionStore);
  }
  // No `entity` member: the runs pane is session-scoped, and its arm of the
  // address union carries none.
  const context = paneContext({ kind: "runs" }, { bridge, sessionStore });
  const { container } = render(<RunsPane {...context} />);
  await settleScheduledRead(bridge);
  return container;
}

/** A second and third run, so the seating has more than one row to reconcile. */
export const SECOND_RUN_ID = "c4a1b2d3-5e6f-4071-9b82-ad3e4f506172";
export const THIRD_RUN_ID = "d5b2c3e4-6f70-4182-8c93-be4f50617283";

/**
 * A run that is NOT {@link RUN_ID}, for the cases whose claim is about scoping.
 *
 * Distinct from `SECOND_RUN_ID` and deliberately so: that one is a row the seating
 * reconciles beside the first, and this one is the id a per-run key, a per-run filter,
 * or a per-run history must NOT match. Two suites had each declared it, and a case
 * asserting "not this run" against a value only its own file knows is asserting
 * against a coincidence.
 */
export const OTHER_RUN_ID = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";
