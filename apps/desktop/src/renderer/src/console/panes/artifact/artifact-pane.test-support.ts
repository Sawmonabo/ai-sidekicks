// What every artifact-pane case is driven against: one session, one served row, the
// port that answers whatever a case scripts, and the readers that hold a call open
// until a case releases it.
//
// A SUPPORT MODULE BECAUSE FOUR SUITES DRIVE THE SAME SURFACE. `artifact-actions` owns
// the manifest re-read and the delete, `artifact-payload-fetch` owns the payload
// single flight, `artifact-reader` owns when a read runs, and `artifact-pane-reads`
// owns what a served or refused answer reads as. The first two press their control on
// a LIVE reader — the only implementation of `ArtifactActionHost` there is. A second
// copy of these builders in any suite would be a second definition of what "one served
// row" means, and the copies would drift.
//
// THROUGH THE READER AND NEVER BESIDE IT, which is the reason these builders return
// readers rather than act classes: a suite that supplied a hand-written host would be
// asserting against a stand-in for the half these acts are meant to be correct
// against.

import { vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

/** The one session every case here reads, named once so a store and a row agree. */
export const SESSION_ID = "session-1";

// THE IDS BELOW ARE SPELLED OUT RATHER THAN SHARED THROUGH A BINDING, and it is the
// declaration emitter that decides it: `isolatedDeclarations` cannot write the type of
// an exported `as const` object whose property reads another binding, so a shared
// constant here would either widen every fixture or need a hand-written type beside
// each one. The `as const` is what the suites actually rely on, so the literals repeat.

/** One manifest row as the growth port serves it, with every member populated. */
export const SERVED_SUMMARY = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  sessionId: "session-1",
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

/** A second artifact, so a case can press for bytes the pane is not already fetching. */
export const OTHER_ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2299";

/** The receipt a served delete answers with. Every member required, so all are here. */
export const DELETE_RECEIPT = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  payloadDisposition: "reclaimed",
  rePublishForeclosed: false,
  deletedAt: "2026-09-02T07:05:00.000Z",
} as const;

export const SERVED_DELETE = {
  status: "served",
  value: {
    artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
    payloadDisposition: "reclaimed",
    rePublishForeclosed: false,
    deletedAt: "2026-09-02T07:05:00.000Z",
  },
} as const;

export const REFUSAL = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the artifact CRUD method strings are not registered yet.",
  origin: "growth-port",
} as const;

/** What a case scripts each of the pane's two reads to answer. */
export interface PortScript {
  readonly listAnswer: unknown;
  readonly allowlistAnswer: unknown;
}

/**
 * A port answering exactly what a case scripts — or REJECTING, where it scripts an
 * `Error`.
 *
 * The shape the port's own union cannot express and the live bridge produces anyway:
 * an IPC disconnect makes a call throw rather than answer. An `Error` is never a
 * scripted answer here, so it needs no marker type to be told from one.
 */
export function bridgeAnswering(script: PortScript): ConsoleBridge {
  return {
    growth: {
      artifactList: async () => scriptedAnswer(script.listAnswer),
      artifactAllowlistRead: async () => scriptedAnswer(script.allowlistAnswer),
    },
  } as unknown as ConsoleBridge;
}

async function scriptedAnswer(scripted: unknown): Promise<unknown> {
  if (scripted instanceof Error) {
    throw scripted;
  }
  return scripted;
}

export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let the scheduler's coalescing window elapse, then let the read's awaits run. */
export async function readThrough(clock: ManualClock): Promise<void> {
  clock.advance(REFRESH_DEBOUNCE_MS);
  await settle();
}

/**
 * A delete whose answer lands under a refresh the participant started after
 * confirming it. The list read that refresh issues can have observed the artifact
 * BEFORE the daemon destroyed it, so it republishes a row the daemon no longer
 * holds — and the delete is the only party that knows better.
 */
export function readerRacingADelete(clock: ManualClock): {
  readonly reader: ArtifactPaneReader;
  readonly releaseDelete: (answer: unknown) => void;
  readonly stopListingTheArtifact: () => void;
} {
  let listedSummaries: readonly unknown[] = [SERVED_SUMMARY];
  let releaseDelete: (answer: unknown) => void = () => undefined;
  const reader = new ArtifactPaneReader({
    bridge: {
      growth: {
        artifactList: async () => ({ status: "served", value: listedSummaries }),
        artifactAllowlistRead: async () => REFUSAL,
        artifactDelete: () =>
          new Promise((resolve) => {
            releaseDelete = resolve;
          }),
      },
    } as unknown as ConsoleBridge,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return {
    reader,
    releaseDelete: (answer) => releaseDelete(answer),
    stopListingTheArtifact: () => {
      listedSummaries = [];
    },
  };
}

export function listedRowIds(reader: ArtifactPaneReader): readonly string[] {
  const state = reader.snapshot.artifacts;
  return state.kind === "listed" ? state.rows.map((row) => row.id) : [];
}

/**
 * A reader whose payload fetch is held open until a case releases it.
 *
 * The list serves one row throughout, so a refresh landing under a fetch is a real
 * refresh with a real answer rather than a refusal that changes nothing.
 */
export function readerWithHeldPayloadFetch(clock: ManualClock): {
  readonly reader: ArtifactPaneReader;
  readonly artifactRead: ReturnType<typeof vi.fn>;
  readonly releaseRead: (answer: unknown) => void;
} {
  let releaseRead: (answer: unknown) => void = () => undefined;
  const artifactRead = vi.fn(
    () =>
      new Promise((resolve) => {
        releaseRead = resolve;
      }),
  );
  const reader = new ArtifactPaneReader({
    bridge: {
      growth: {
        artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
        artifactAllowlistRead: async () => REFUSAL,
        artifactRead,
        // Served for whichever row was asked about, so a case can delete the
        // artifact whose bytes are on the wire AND a case can delete a different
        // one. The receipt is the daemon's, so its `artifactId` follows the request.
        artifactDelete: async ({ artifactId }: { artifactId: string }) => ({
          status: "served",
          value: { ...DELETE_RECEIPT, artifactId },
        }),
      },
    } as unknown as ConsoleBridge,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return { reader, artifactRead, releaseRead: (answer) => releaseRead(answer) };
}

/** One served inline payload, as the reply's own union carries it. */
export function servedPayload(artifactId: string, text: string): unknown {
  return {
    status: "served",
    value: {
      manifest: { ...SERVED_SUMMARY, artifactId },
      payloadHandle: "sha256:2b4c",
      payloadEncoding: "utf8",
      payload: text,
    },
  };
}
