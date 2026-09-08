// The runs pane's shared scaffolding: one pane, mounted over the fixture bridge.
//
// Both suites mount the SAME pane against the same scenario, because the claims are
// about a composition — the pane resolves a session and the body reads a stream
// against it — and a second mount helper would let the seat's cases and the body's
// cases drift into two different panes.

import { render } from "@testing-library/react";
import { type RunState } from "@ai-sidekicks/contracts";
import { paneContext } from "../../seats/pane/pane-context.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { createFixture, withDaemonCall } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { withReplayedStream } from "../../bridge/daemon/daemon-streams.test-support.js";
import { RUN_STATE_SUBSCRIBE_STREAM } from "../../bridge/daemon/daemon-streams.js";
import { settleScheduledRead } from "../../bridge/readings/scheduled-read.test-support.js";
import { FrameStore, SessionStore } from "../../store/index.js";
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

/**
 * The shipped fixture with a run-state script on it and every call refusing.
 *
 * Composed from the bridge family's own wrappers rather than fabricated: what stood
 * here was an object cast to `ConsoleBridge`, which answered EVERY stream with the
 * same script and every call with the same refusal, so a pane that opened a second
 * read was answered by whatever this file happened to say rather than by the fixture.
 * It also had to carry a hand-made scenario engine so the scheduled reads had a clock
 * to arm on — a member that exists here only because the object was not a bridge.
 *
 * Private, and the pane mount below is the only way in: every case in both suites
 * renders the pane, so a bridge on the exported surface would be an object a case
 * could hold without ever mounting anything.
 */
function paneBridge(deliveries: readonly unknown[], rejection?: unknown): ConsoleBridge {
  return withReplayedStream(refusingBridge(rejection), RUN_STATE_SUBSCRIBE_STREAM, deliveries);
}

/** The rejection every daemon call takes unless a case names another one. */
const RUN_GONE_REJECTION = { code: "run.not_found", message: "no such run" };

/**
 * The shipped fixture with every call refusing, and no stream script on it.
 *
 * Exported for the one harness in this family that mounts a CONTROL row rather than
 * the pane: it holds the surface's records under the bridge, so it needs one that is
 * stable across renders and answers nothing readable, and it opens no stream at all.
 *
 * The rejection is a parameter with a default rather than a constant, because WHICH
 * code a control comes back with is the whole claim of the cases that press one: the
 * default says this run is gone, and a case about what leaves the pane says the
 * session is. Defaulted so no existing caller — `useState(refusingBridge)` included,
 * which calls it with no argument — moves.
 */
export function refusingBridge(rejection: unknown = RUN_GONE_REJECTION): ConsoleBridge {
  return withDaemonCall(createFixture().bridge, async () => {
    throw rejection;
  }).bridge;
}

/**
 * What a case asserting about the FRAME hands the mount, rather than about the pane.
 *
 * One parameter and not two, because the two travel together: a case reading banners
 * off a window store is a case that has to drive the refusal that raises one, and a
 * `frameStore` with no way to say what refused would be half a probe.
 */
export interface PaneFrameProbe {
  /** The window store the case reads banners off after the pane has escalated. */
  readonly frameStore: FrameStore;
  /** What every daemon call rejects with, for a case pressing a control. */
  readonly daemonRejection?: unknown;
}

/**
 * Mount the pane over the fixture, with one run-state script and one seeded store.
 *
 * Takes the DELIVERIES rather than a bridge, which is what let the stand-in go: every
 * case in both suites passed `scriptedBridge(...)` here and nowhere else, so the
 * bridge was a value each one built to hand straight back.
 */
export async function renderPane(
  deliveries: readonly unknown[],
  withSession: boolean,
  seed?: (store: SessionStore) => void,
  frame?: PaneFrameProbe,
): Promise<HTMLElement> {
  const bridge = paneBridge(deliveries, frame?.daemonRejection);
  const frameStore = frame?.frameStore;
  const sessionStore = withSession ? new SessionStore({ sessionId: SESSION_ID }) : undefined;
  if (sessionStore !== undefined) {
    seed?.(sessionStore);
  }
  // No `entity` member: the runs pane is session-scoped, and its arm of the
  // address union carries none.
  const context = paneContext({ kind: "runs" }, { bridge, sessionStore, frameStore });
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
