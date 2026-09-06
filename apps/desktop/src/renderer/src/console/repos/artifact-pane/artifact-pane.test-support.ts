// What every artifact-pane case is driven against: one session, one served row, the
// port that answers whatever a case scripts, the readers that hold a call open until
// a case releases it, and the two waits a mounted case settles through.
//
// ONE SUPPORT MODULE BECAUSE THERE IS ONE PANE. Six suites drive it and they split
// two ways — four against the reader directly (`artifact-actions`, its rejection
// half, `artifact-payload-fetch`, `artifact-reader`, `artifact-pane-reads`), two
// against the pane MOUNTED (`ArtifactPane`, `ArtifactPayloadSection`) — and the split
// used to be two files, `artifact-pane.test-support.ts` and
// `ArtifactPane.test-support.tsx`, each whose header claimed to be the single home.
// They had already drifted: two session ids, two served rows, two delete receipts
// under one name exercising two different `payloadDisposition` arms, two growth-port
// builders, and two `readThrough`s. A change to what "one served row" is had to be
// made twice, and nothing failed when it was made once.
//
// THROUGH THE READER AND NEVER BESIDE IT, which is the reason these builders return
// readers rather than act classes: a suite that supplied a hand-written host would be
// asserting against a stand-in for the half these acts are meant to be correct
// against. The mounted half composes the same reader behind `ArtifactPane`, so both
// halves prove the same object.
//
// NO SECOND WAIT AND NO SECOND STRINGIFIER. `crossMacrotaskBoundary` is the console's one
// let-the-promises-run helper and is imported rather than re-written as a raw
// `setTimeout` — the third copy of it this directory used to carry.

import { act } from "@testing-library/react";
import { type Mock, vi } from "vitest";

import type {
  ConsoleBridge,
  GrowthArtifactDeleteReceipt,
  GrowthArtifactPayloadEncoding,
  GrowthArtifactState,
  GrowthArtifactSummary,
  GrowthOperationId,
  GrowthUnavailable,
} from "../../bridge/index.js";
import type { GrowthPortAnswer } from "../../bridge/growth-port/growth-port.js";
import { growthUnavailable } from "../../bridge/index.js";

// Re-exported so a suite scripting this pane's port names one import rather than two.
// A type alias, so this is not the barrel chain `console-no-barrel-chain` forbids —
// that rule is about a DOOR forwarding another door's symbols, and this module is a
// leaf the suites beside it read. THE ONLY re-export of it in this directory: the
// mount module carried a second, so the type had three import homes and a suite could
// name whichever one it happened to be importing something else from.
export type { GrowthPortAnswer };
import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { handAnsweredCall } from "../held-calls.test-support.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

/** The one session every case here reads, named once so a store and a row agree. */
export const SESSION_ID = "019b7b30-0280-7c11-8420-b1a5c0de2200";

/** A second artifact, so a case can press for bytes the pane is not already fetching. */
export const OTHER_ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2299";

// THE IDS BELOW ARE SPELLED OUT RATHER THAN SHARED THROUGH A BINDING, and it is the
// declaration emitter that decides it: `isolatedDeclarations` cannot write the type of
// an exported `as const` object whose property reads another binding, so a shared
// constant here would either widen every fixture or need a hand-written type beside
// each one. The `as const` is what the suites actually rely on, so the literals repeat.

/**
 * One manifest row as the growth port serves it, with every member populated.
 *
 * TYPED BY THE PORT'S OWN VOCABULARY rather than left as a literal the suites cast
 * past. A fixture annotated `GrowthArtifactSummary` fails to compile the day the wire
 * grows a member or narrows one of these unions, which is the only reason a fixture
 * is worth having: an untyped one goes on describing a reply the port stopped sending.
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
 * A DERIVATION OF `SERVED_SUMMARY` and not a second row: the two used to be written
 * out separately, so the reader suites proved themselves against a fully populated
 * manifest while the mounted suites proved themselves against a thinner one, and
 * neither said so.
 *
 * `state` is the wire's own union rather than `string`, so a case that varies it to a
 * value the contract does not carry is a compile error rather than a fixture drawing
 * a state no daemon sends.
 */
export function summary(state: GrowthArtifactState): GrowthArtifactSummary {
  return { ...SERVED_SUMMARY, state };
}

/** The receipt a served delete answers with. Every member required, so all are here. */
export const DELETE_RECEIPT: GrowthArtifactDeleteReceipt = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  payloadDisposition: "retained_by_references",
  rePublishForeclosed: true,
  deletedAt: "2026-09-02T07:05:00.000Z",
} as const;

/** The envelope the port answers with, BUILT FROM the receipt rather than beside it. */
export const SERVED_DELETE: GrowthPortAnswer<"artifactDelete"> = {
  status: "served",
  value: DELETE_RECEIPT,
};

// NO REFUSAL FIXTURE LIVES HERE. This module used to declare a four-member twin of the
// port's refusal — `status`, `code`, `detail`, `origin` — while `GrowthUnavailable`
// carries seven: the three it omitted (`operationId`, `slateRow`, `owningDocument`) are
// what tell a reader WHICH operation refused and who owes the wire. Because the twin
// did not satisfy the port's return type, every scripted port that used it needed
// `as unknown as Partial<GrowthPort>`, and that cast switched off the checking on the
// whole object rather than on the one member that did not fit. A case now scripts
// `growthUnavailable(operationId)` — the port's own builder, which composes the
// sentence a person would actually read off the slate row rather than a paraphrase of
// it — and the casts are gone.

/** One served list of exactly the row above. */
export const LISTED_ONE_ROW: GrowthPortAnswer<"artifactList"> = {
  status: "served",
  value: [SERVED_SUMMARY],
};

/**
 * One served READ, which is a manifest plus a way to reach the bytes.
 *
 * The reply NESTS the envelope rather than being it — a read carries the manifest
 * beside a payload handle — so a case that answered with a bare summary would be
 * scripting a shape the port never sends and this pane would compile against it. On
 * the DEFERRED arm, which is what a metadata read lands on.
 */
export function readAnswering(state: GrowthArtifactState): GrowthPortAnswer<"artifactRead"> {
  return {
    status: "served",
    value: { manifest: summary(state), payloadHandle: `sha256:2b4c/${state}` },
  };
}

/** A served payload read on the INLINE arm, with the bytes and the encoding to read them by. */
export function inlineReadAnswering(
  payload: string,
  encoding: GrowthArtifactPayloadEncoding,
): GrowthPortAnswer<"artifactRead"> {
  return {
    status: "served",
    value: { manifest: summary("published"), payload, payloadEncoding: encoding },
  };
}

/** One served inline payload for a named artifact, as the reply's own union carries it. */
export function servedPayload(artifactId: string, text: string): GrowthPortAnswer<"artifactRead"> {
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

/**
 * What one operation may be scripted with: the answer it serves, or the `Error` it
 * throws.
 *
 * Keyed by the operation id so each member below is checked against the value THAT
 * operation returns — a read answer scripted onto the delete slot is a compile error
 * rather than a pane rendering a receipt as a manifest.
 */
type ScriptedAnswer<TOperationId extends GrowthOperationId> =
  | GrowthPortAnswer<TOperationId>
  | Error;

/** What a case scripts each of the pane's four port operations to answer. */
export interface ArtifactPortScript {
  readonly listAnswer?: ScriptedAnswer<"artifactList">;
  readonly allowlistAnswer?: ScriptedAnswer<"artifactAllowlistRead">;
  readonly readAnswer?: ScriptedAnswer<"artifactRead">;
  readonly deleteAnswer?: ScriptedAnswer<"artifactDelete">;
  /** Supplied where a case counts the list reads or varies them between reads. */
  readonly artifactList?: () => Promise<GrowthPortAnswer<"artifactList">>;
  /** Supplied where a case counts the payload reads or asserts what one was asked. */
  readonly artifactRead?: (request: unknown) => Promise<GrowthPortAnswer<"artifactRead">>;
}

/**
 * A port answering exactly what a case scripts — or REJECTING, where it scripts an
 * `Error`.
 *
 * ONE BUILDER FOR BOTH HALVES OF THE PANE. The reader suites script two operations and
 * the mounted suites script four; two builders for that was two objects a fifth
 * operation would have to be added to, with the one that was forgotten answering
 * `undefined` rather than refusing.
 *
 * The `Error` arm is the shape the port's own union cannot express and the live bridge
 * produces anyway: an IPC disconnect makes a call throw rather than answer. An `Error`
 * is never a scripted answer here, so it needs no marker type to be told from one.
 *
 * A REAL FIXTURE BRIDGE UNDER THE SCRIPTED PORT, rather than `{ growth } as unknown as
 * ConsoleBridge`. The cast left every other namespace `undefined`, so the first surface
 * to reach the daemon door threw in the case instead of failing an assertion; the port
 * a case does not script is now the fixture's own. It also carries the scenario's frozen
 * clock, which is where the `clock` this builder used to take went: `consoleClockFor`
 * resolves the pane's subsystems onto that clock, and a case moves it with
 * `scenarioManualClock(bridge)` — the mount hands it back, so no case builds one.
 */
export function artifactBridgeAnswering(script: ArtifactPortScript): ConsoleBridge {
  return fixtureBridgeWithGrowth(REPOS_SCENARIO, {
    artifactList:
      script.artifactList ?? (async () => scriptedAnswer("artifactList", script.listAnswer)),
    artifactAllowlistRead: async () =>
      scriptedAnswer("artifactAllowlistRead", script.allowlistAnswer),
    artifactRead:
      script.artifactRead ?? (async () => scriptedAnswer("artifactRead", script.readAnswer)),
    artifactDelete: async () => scriptedAnswer("artifactDelete", script.deleteAnswer),
  });
}

/**
 * An unscripted operation answers the port's own refusal, never `undefined`.
 *
 * The operation id is passed rather than a shared refusal value because a refusal
 * names the operation that raised it: one fixture answering every unscripted call
 * would report the same `operationId` for a list, a read and a delete, which is the
 * one thing a reader consults it for.
 */
async function scriptedAnswer<TAnswer>(
  operationId: GrowthOperationId,
  scripted: TAnswer | Error | undefined,
): Promise<TAnswer | GrowthUnavailable> {
  if (scripted instanceof Error) {
    throw scripted;
  }
  return scripted ?? growthUnavailable(operationId);
}

/**
 * Let the scheduler's coalescing window elapse, then let the read's awaits run.
 *
 * ONE WAIT, TWO CLOCKS, and the argument says which. A reader a case constructs is
 * handed a `ManualClock` directly, so the window is advanced on that; a reader the
 * PANE composes runs on whatever `consoleClockFor` answers for the bridge it was
 * given, which for a hand-built bridge is the host's clock the mounted suites fake —
 * and for a bridge carrying a scenario engine is the manual clock that engine holds.
 * Written twice it was two functions of one name in two modules, which is one grep and
 * two contracts.
 *
 * The `act` and the drain are the two harnesses' own settling, not a third clock:
 * `crossMacrotaskBoundary` crosses a macrotask boundary and so never resolves while the host
 * timers are faked, and `act` needs a rendering environment a reader-only case does
 * not have. `vi.isFakeTimers()` is what tells them apart, rather than a second
 * parameter a call site would have to keep in step with its own `beforeEach`.
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

/**
 * A delete whose answer lands under a refresh the participant started after
 * confirming it. The list read that refresh issues can have observed the artifact
 * BEFORE the daemon destroyed it, so it republishes a row the daemon no longer
 * holds — and the delete is the only party that knows better.
 */
export function readerRacingADelete(clock: ManualClock): {
  readonly reader: ArtifactPaneReader;
  readonly releaseDelete: (answer: GrowthPortAnswer<"artifactDelete">) => void;
  readonly stopListingTheArtifact: () => void;
} {
  let listedSummaries: readonly GrowthArtifactSummary[] = [SERVED_SUMMARY];
  const deleteCall = handAnsweredCall<GrowthPortAnswer<"artifactDelete">>();
  const reader = new ArtifactPaneReader({
    bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
      artifactList: async () => ({ status: "served", value: listedSummaries }),
      artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
      artifactDelete: deleteCall.invoke,
    }),
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return {
    reader,
    releaseDelete: deleteCall.open,
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
  readonly artifactRead: Mock<() => Promise<GrowthPortAnswer<"artifactRead">>>;
  readonly releaseRead: (answer: GrowthPortAnswer<"artifactRead">) => void;
} {
  const readCall = handAnsweredCall<GrowthPortAnswer<"artifactRead">>();
  const artifactRead = vi.fn(readCall.invoke);
  const reader = new ArtifactPaneReader({
    bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
      artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
      artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
      artifactRead,
      // Served for whichever row was asked about, so a case can delete the
      // artifact whose bytes are on the wire AND a case can delete a different
      // one. The receipt is the daemon's, so its `artifactId` follows the request.
      artifactDelete: async ({ artifactId }: { artifactId: string }) => ({
        status: "served",
        value: { ...DELETE_RECEIPT, artifactId },
      }),
    }),
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return { reader, artifactRead, releaseRead: readCall.open };
}
