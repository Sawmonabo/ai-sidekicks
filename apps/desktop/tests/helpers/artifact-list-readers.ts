// What every artifact-pane case is driven against: one session, one served row, the calls a case
// scripts, the readers that hold a call open until a case releases it, and the two waits a
// mounted case settles through. Cases drive a real reader, never a hand-written host, so the acts
// are asserted against the half they should be correct against.

import { act } from "@testing-library/react";
import { type Mock, vi } from "vitest";

import type { ArtifactId, RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { ArtifactManifest } from "@ai-sidekicks/contracts/artifacts/manifest";
import type {
  ArtifactPayloadEncoding,
  ArtifactReadResponse,
} from "@ai-sidekicks/contracts/artifacts/operations";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/session";

import { crossMacrotaskBoundary } from "./macrotask-boundary.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh/caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { handAnsweredCall } from "./held-calls.js";
import type {
  ArtifactOperations,
  ReadArtifact,
} from "@renderer/features/inspector/artifacts/services/artifact-reads.js";
import { ArtifactListReader } from "@renderer/features/inspector/artifacts/artifact-list-reader.js";

/** The one session every case here reads, named once so a store and a row agree. */
export const SESSION_ID = "019b7b30-0280-7c11-8420-b1a5c0de2200";

/** The run every served manifest comes from, in the session above. */
export const ARTIFACT_RUN_ID = "019b7b30-0280-7c11-8420-b1a5c0de2202";

/** The producer every served manifest is drawn as coming from. */
export const ARTIFACT_PRODUCER_ID = "019b7b30-0280-7c11-8420-b1a5c0de2203";

/** A second artifact, so a case can press for bytes the pane is not already fetching. */
export const OTHER_ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2299" as ArtifactId;

/**
 * One manifest row as the daemon serves it, with every member populated.
 *
 * Typed by the contract's own manifest, so the fixture fails to compile the day the wire
 * grows a member or narrows one of these unions.
 */
export const SERVED_SUMMARY: ArtifactManifest = {
  id: "019b7b30-0280-7c11-8420-b1a5c0de2201" as ArtifactId,
  sessionId: SESSION_ID as SessionId,
  runId: ARTIFACT_RUN_ID as RunId,
  createdBy: ARTIFACT_PRODUCER_ID as UserId,
  artifactType: "diff",
  digest: "sha256:2b4c",
  size: 4096,
  state: "published",
  metadata: { mediaType: "text/x-patch", turnOrdinal: 12 },
  createdAt: "2026-09-02T07:00:00.000Z",
};

/**
 * The version facts every served read of the row above carries: its one version, in view,
 * written when the row was.
 */
export const SERVED_VERSION: Pick<
  ArtifactReadResponse,
  "versionNumber" | "versionCount" | "versionWrittenAt"
> = { versionNumber: 1, versionCount: 1, versionWrittenAt: "2026-09-02T07:00:00.000Z" };

/** One served list of exactly the row above. */
export const LISTED_ONE_ROW: readonly ArtifactManifest[] = [SERVED_SUMMARY];

/** A served payload read on the inline arm, with the bytes and the encoding to read them by. */
export function inlineRead(
  payload: string,
  encoding: ArtifactPayloadEncoding,
): ArtifactReadResponse {
  return { manifest: SERVED_SUMMARY, ...SERVED_VERSION, payload, payloadEncoding: encoding };
}

/** One served inline utf8 payload for a named artifact. */
export function inlinePayloadRead(artifactId: string, text: string): ArtifactReadResponse {
  return {
    manifest: { ...SERVED_SUMMARY, id: artifactId as ArtifactId },
    ...SERVED_VERSION,
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
 * Lets the scheduler's coalescing window elapse, then lets the read's awaits run.
 *
 * One wait for two clocks. A reader a case constructs gets a `ManualClock`, advanced here; a
 * reader the pane composes runs on the window's clock, a real one over the host timers the
 * mounted suites fake. `crossMacrotaskBoundary` never resolves while host timers are faked, and
 * `act` needs a rendering environment a reader-only case lacks; `vi.isFakeTimers()` tells them
 * apart.
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
  readonly reader: ArtifactListReader;
  readonly artifactRead: Mock<ReadArtifact>;
  readonly releaseRead: (answer: ArtifactReadResponse) => void;
} {
  const readCall = handAnsweredCall<ArtifactReadResponse>();
  const artifactRead = vi.fn<ReadArtifact>(readCall.invoke);
  const reader = new ArtifactListReader({
    listArtifacts: async () => LISTED_ONE_ROW,
    readArtifact: artifactRead,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    ownerWindow: window,
    clock,
  });
  return { reader, artifactRead, releaseRead: readCall.open };
}
