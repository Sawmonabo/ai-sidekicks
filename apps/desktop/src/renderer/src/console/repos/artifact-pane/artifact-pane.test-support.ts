// What every artifact-pane case is driven against: one session, one served row, the calls
// a case scripts, the readers that hold a call open until a case releases it, and the two
// waits a mounted case settles through.
//
// Cases drive a real reader and never a hand-written host, so the acts are asserted against
// the half they are meant to be correct against. `crossMacrotaskBoundary` is the console's
// one let-the-promises-run helper and is imported rather than re-written.

import { act } from "@testing-library/react";
import { type Mock, vi } from "vitest";

import type {
  GrowthArtifactPayloadEncoding,
  GrowthArtifactRead,
  GrowthArtifactState,
  GrowthArtifactSummary,
} from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { handAnsweredCall } from "../held-calls.test-support.js";
import type { ArtifactOperations, ReadArtifact } from "./artifact-pane-reads.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

/** The one session every case here reads, named once so a store and a row agree. */
export const SESSION_ID = "019b7b30-0280-7c11-8420-b1a5c0de2200";

/** A second artifact, so a case can press for bytes the pane is not already fetching. */
export const OTHER_ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2299";

// The ids below are spelled out rather than shared through a binding: `isolatedDeclarations`
// cannot write the type of an exported `as const` object whose property reads another
// binding.

/**
 * One manifest row as the daemon serves it, with every member populated.
 *
 * Typed by the port's own vocabulary, so the fixture fails to compile the day the wire
 * grows a member or narrows one of these unions.
 */
export const SERVED_SUMMARY: GrowthArtifactSummary = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  sessionId: "019b7b30-0280-7c11-8420-b1a5c0de2200",
  runId: "019b7b30-0280-7c11-8420-b1a5c0de2202",
  createdBy: "019b7b30-0280-7c11-8420-b1a5c0de2203",
  artifactType: "diff",
  digest: "sha256:2b4c",
  size: 4096,
  annotations: { "org.opencontainers.image.title": "rate-limit-wiring.patch" },
  visibility: "shared",
  state: "published",
  replicationStatus: "pinned",
  metadata: { mediaType: "text/x-patch", turnOrdinal: 12 },
  createdAt: "2026-09-02T07:00:00.000Z",
} as const;

/**
 * The same row with the one member a case varies.
 *
 * `state` is the wire's own union rather than `string`, so a case that varies it to a
 * value the contract does not carry is a compile error.
 */
export function summary(state: GrowthArtifactState): GrowthArtifactSummary {
  return { ...SERVED_SUMMARY, state };
}

/** One served list of exactly the row above. */
export const LISTED_ONE_ROW: readonly GrowthArtifactSummary[] = [SERVED_SUMMARY];

/**
 * One served read, which is a manifest plus a way to reach the bytes.
 *
 * The reply nests the envelope beside a payload handle rather than being it. This is the
 * deferred arm, which is what a metadata read lands on.
 */
export function deferredRead(state: GrowthArtifactState): GrowthArtifactRead {
  return { manifest: summary(state), payloadHandle: `sha256:2b4c/${state}` };
}

/** A served payload read on the inline arm, with the bytes and the encoding to read them by. */
export function inlineRead(
  payload: string,
  encoding: GrowthArtifactPayloadEncoding,
): GrowthArtifactRead {
  return { manifest: summary("published"), payload, payloadEncoding: encoding };
}

/** One served inline utf8 payload for a named artifact. */
export function inlinePayloadRead(artifactId: string, text: string): GrowthArtifactRead {
  return {
    manifest: { ...SERVED_SUMMARY, artifactId },
    payloadHandle: "sha256:2b4c",
    payloadEncoding: "utf8",
    payload: text,
  };
}

/**
 * The pane's two calls. Each resolves what the case gives it, and otherwise the list
 * resolves with no rows and the read rejects, so a case that reached for a read it did not
 * script fails on a sentence.
 */
export function artifactOperations(script: Partial<ArtifactOperations> = {}): ArtifactOperations {
  return {
    listArtifacts: script.listArtifacts ?? (async () => []),
    readArtifact:
      script.readArtifact ??
      (async () => {
        throw new Error("readArtifact was not scripted for this case.");
      }),
  };
}

/**
 * Let the scheduler's coalescing window elapse, then let the read's awaits run.
 *
 * One wait for two clocks. A reader a case constructs is handed a `ManualClock`, so the
 * window is advanced on that; a reader the pane composes runs on whatever
 * `consoleClockFor` answers for its bridge, which for a hand-built bridge is the host's
 * clock the mounted suites fake.
 *
 * `crossMacrotaskBoundary` never resolves while the host timers are faked, and `act`
 * needs a rendering environment a reader-only case does not have; `vi.isFakeTimers()`
 * tells them apart.
 */
export async function readThrough(clock?: ManualClock): Promise<void> {
  if (clock !== undefined && !vi.isFakeTimers()) {
    clock.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
    return;
  }
  await act(async () => {
    clock?.advance(REFRESH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(clock === undefined ? REFRESH_DEBOUNCE_MS : 0);
  });
}

/** Let an act's promise and the publish it causes settle, inside a mounted render. */
export async function settleAct(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** A reader whose payload fetch is held open until a case releases it. */
export function readerWithHeldPayloadFetch(clock: ManualClock): {
  readonly reader: ArtifactPaneReader;
  readonly artifactRead: Mock<ReadArtifact>;
  readonly releaseRead: (answer: GrowthArtifactRead) => void;
} {
  const readCall = handAnsweredCall<GrowthArtifactRead>();
  const artifactRead = vi.fn<ReadArtifact>(readCall.invoke);
  const reader = new ArtifactPaneReader({
    listArtifacts: async () => LISTED_ONE_ROW,
    readArtifact: artifactRead,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return { reader, artifactRead, releaseRead: readCall.open };
}
