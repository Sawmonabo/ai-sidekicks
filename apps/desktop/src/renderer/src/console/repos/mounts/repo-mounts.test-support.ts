// What every mounts case is driven against: the readers a case opens, the disposal
// that must leave none of them running, the two waits they settle through, and the
// three wire records the cards are drawn from.
//
// THE ONLY SUB-MODULE THAT HAD NO SUPPORT MODULE, and it carried eight copies of the
// scaffolding above — four `settle`s (two of them with hand-tuned turn counts and two
// different explanations of the same rule), two `drain`s, two `openReader`s, and five
// copies of the reader registry with its `afterEach`. Nothing failed when one copy was
// changed, which is the whole reason `AGENTS.md` §Shared code hoists on the second use.
//
// THE REGISTRY IS A FUNCTION PAIR RATHER THAN A HOOK. Registering `afterEach` here
// would bind this module's import to a suite lifecycle its importer cannot see, so each
// suite keeps its own one-line `afterEach(disposeTrackedReaders)` and reads what that
// line does from its name.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";

import { createFixtureBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";
import type { EphemeralCloneStatusRecord, WorktreeStatusRecord } from "./worktree-model.js";

const trackedReaders: RepoMountsReader[] = [];

/**
 * Hold a reader a case built itself, so the teardown reaches it too.
 *
 * The suites that bend the port build their reader inline — the bridge is the subject
 * there — and a reader left undisposed goes on holding a scheduler after its case ends.
 */
export function trackReader(reader: RepoMountsReader): RepoMountsReader {
  trackedReaders.push(reader);
  return reader;
}

/** Dispose every reader this file's cases opened. One `afterEach` per suite. */
export function disposeTrackedReaders(): void {
  while (trackedReaders.length > 0) {
    trackedReaders.pop()?.dispose();
  }
}

/** A reader over one scenario's own fixture bridge, tracked for disposal. */
export function openReader(
  scenario: ConsoleScenario,
  clock: ManualClock,
  // Defaulted, so the cases that only care about the READ say nothing about the store.
  // The trigger cases construct their own and drive it.
  sessionStore: SessionStore = new SessionStore({ sessionId: scenario.sessionId }),
): RepoMountsReader {
  return trackReader(
    new RepoMountsReader({
      bridge: createFixtureBridge({ scenario }),
      sessionStore,
      clock,
    }),
  );
}

/**
 * Drive the frozen clock past the debounce and let the read's promises settle.
 *
 * The queued continuations are drained BEFORE the clock moves, not only after: the
 * scheduler clears its in-flight flag and re-arms inside a `finally`, so a case that
 * asked for a second read while the first was landing would otherwise advance past a
 * timer that did not exist yet and observe a re-read that had simply not been armed.
 *
 * The two turn counts are the shape `crossMacrotaskBoundary` replaced elsewhere and are kept
 * here for a reason that does not apply there: the second loop STOPS at the reading it
 * is waiting for, so the count is a ceiling on a wait rather than a tuning of one.
 */
export async function settle(clock: ManualClock, reader: RepoMountsReader): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 50 && reader.snapshot.status !== "read"; turn += 1) {
    await Promise.resolve();
  }
}

/** Let the queued continuations of a settled act run, without moving the clock. */
export async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Overrides as a case writes them.
 *
 * The wire's ids are branded and nothing in a test mints one, so a builder demanding
 * them could only ever be handed its own defaults back. Each builder closes its record
 * with one `as`; this is the half of that cast the caller sees, and it loosens the
 * branded ids alone — every union member and nested shape stays exact.
 */
type Unbranded<TValue> = TValue extends { readonly __brand: string } ? string : TValue;
type WireOverrides<TRecord> = { readonly [Member in keyof TRecord]?: Unbranded<TRecord[Member]> };

/** The root a mount resolves to, and the deeper path a participant entered. */
export const CANONICAL_ROOT = "/Users/dev/code/ai-sidekicks";
export const ENTERED_PATH = "/Users/dev/code/ai-sidekicks/packages/contracts";

/** One mount as the wire reads it, healthy and attached unless a case says otherwise. */
export function mount(overrides: WireOverrides<RepoMountReadResponse> = {}): RepoMountReadResponse {
  return {
    id: "mount-sidekicks",
    sessionId: "session-repos",
    nodeId: "node-workstation",
    localPath: ENTERED_PATH,
    canonicalRoot: CANONICAL_ROOT,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
    attachedAt: "2026-01-01T09:05:00.200Z",
    ...overrides,
  } as RepoMountReadResponse;
}

/**
 * One workspace row as the roster reads it, in the mode most cases want.
 *
 * `executionMode` is the member the gate suites vary, so it is stated here rather than
 * left to a default a reader would have to go and look up.
 */
export function workspaceRow(overrides: WireOverrides<RepoWorkspaceRow> = {}): RepoWorkspaceRow {
  return {
    id: "workspace-sidekicks",
    repoMountId: "mount-sidekicks",
    executionMode: "read-only",
    state: "ready",
    fsRoot: CANONICAL_ROOT,
    ...overrides,
  } as RepoWorkspaceRow;
}

/** One worktree root as the wire reads it. */
export function worktreeRecord(
  overrides: WireOverrides<WorktreeStatusRecord> = {},
): WorktreeStatusRecord {
  return {
    worktreeId: "worktree-01",
    repoMountId: "mount-sidekicks",
    branchName: "sidekicks/abc123/rate-limit-wiring",
    fsRoot: "/Users/dev/.sidekicks/roots/worktree-01",
    state: "ready",
    createdBySessionId: "session-repos",
    createdByRunId: "run-01",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:04:00.000Z",
    ...overrides,
  } as WorktreeStatusRecord;
}

/**
 * One ephemeral clone as the wire reads it.
 *
 * `expiresAt` is stated here and overridden by the deadline cases: a clone's disposal
 * time is the one member three suites disagree about on purpose, and a builder that
 * read it from a shared constant would put every case on one deadline.
 */
export function cloneRecord(
  overrides: WireOverrides<EphemeralCloneStatusRecord> = {},
): EphemeralCloneStatusRecord {
  return {
    cloneId: "clone-01",
    workspaceId: "workspace-sidekicks",
    cloneRoot: "/Users/dev/.sidekicks/clones/clone-01",
    branchName: "run-9f2c1a",
    state: "ready",
    cleanupPolicy: "on_run_complete",
    expiresAt: "2026-01-01T12:00:00.000Z",
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  } as EphemeralCloneStatusRecord;
}
