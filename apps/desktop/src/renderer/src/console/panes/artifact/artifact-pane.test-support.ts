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
// NO SECOND WAIT AND NO SECOND STRINGIFIER. `drainMicrotasks` is the console's one
// let-the-promises-run helper and is imported rather than re-written as a raw
// `setTimeout` — the third copy of it this directory used to carry.

import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { drainMicrotasks } from "../../bridge/fixture-bridge.test-support.js";
import { ManualClock, REFRESH_DEBOUNCE_MS, type ConsoleClock } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPane, type ArtifactPaneProps } from "./ArtifactPane.js";
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

/** One manifest row as the growth port serves it, with every member populated. */
export const SERVED_SUMMARY = {
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
 */
export function summary(state: string): Record<string, unknown> {
  return { ...SERVED_SUMMARY, state };
}

/** The receipt a served delete answers with. Every member required, so all are here. */
export const DELETE_RECEIPT = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  payloadDisposition: "retained_by_references",
  rePublishForeclosed: true,
  deletedAt: "2026-09-02T07:05:00.000Z",
} as const;

/** The envelope the port answers with, BUILT FROM the receipt rather than beside it. */
export const SERVED_DELETE: Record<string, unknown> = { status: "served", value: DELETE_RECEIPT };

/** What the port answers for an operation whose wire nobody has registered. */
export const REFUSAL = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the artifact CRUD method strings are not registered yet.",
  origin: "growth-port",
} as const;

/** One served list of exactly the row above. */
export const LISTED_ONE_ROW: Record<string, unknown> = {
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
export function readAnswering(state: string): Record<string, unknown> {
  return {
    status: "served",
    value: { manifest: summary(state), payloadHandle: `sha256:2b4c/${state}` },
  };
}

/** A served payload read on the INLINE arm, with the bytes and the encoding to read them by. */
export function inlineReadAnswering(payload: string, encoding: string): Record<string, unknown> {
  return {
    status: "served",
    value: { manifest: summary("published"), payload, payloadEncoding: encoding },
  };
}

/** One served inline payload for a named artifact, as the reply's own union carries it. */
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

/** What a case scripts each of the pane's four port operations to answer. */
export interface ArtifactPortScript {
  readonly listAnswer?: unknown;
  readonly allowlistAnswer?: unknown;
  readonly readAnswer?: unknown;
  readonly deleteAnswer?: unknown;
  /** Supplied where a case counts the list reads or varies them between reads. */
  readonly artifactList?: () => Promise<unknown>;
  /**
   * The clock the pane's own subsystems run on, where a case freezes them.
   *
   * `consoleClockFor` reads the running scenario engine's clock, so a bridge that
   * carries one hands the pane's reader frozen time — which is the only way a mounted
   * case can assert against a stamp rather than against the host's wall clock.
   */
  readonly clock?: ConsoleClock;
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
 */
export function artifactBridgeAnswering(script: ArtifactPortScript): ConsoleBridge {
  return {
    growth: {
      artifactList: script.artifactList ?? (async () => scriptedAnswer(script.listAnswer)),
      artifactAllowlistRead: async () => scriptedAnswer(script.allowlistAnswer),
      artifactRead: async () => scriptedAnswer(script.readAnswer),
      artifactDelete: async () => scriptedAnswer(script.deleteAnswer),
    },
    ...(script.clock === undefined ? {} : { scenarioEngine: { clock: script.clock } }),
  } as unknown as ConsoleBridge;
}

/** An unscripted operation answers the port's own refusal, never `undefined`. */
async function scriptedAnswer(scripted: unknown): Promise<unknown> {
  if (scripted instanceof Error) {
    throw scripted;
  }
  return scripted ?? REFUSAL;
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
 * `drainMicrotasks` crosses a macrotask boundary and so never resolves while the host
 * timers are faked, and `act` needs a rendering environment a reader-only case does
 * not have. `vi.isFakeTimers()` is what tells them apart, rather than a second
 * parameter a call site would have to keep in step with its own `beforeEach`.
 */
export async function readThrough(clock?: ManualClock): Promise<void> {
  if (clock !== undefined && !vi.isFakeTimers()) {
    clock.advance(REFRESH_DEBOUNCE_MS);
    await drainMicrotasks();
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

/** This pane's own address arm, taken from the prop rather than restated. */
export type ArtifactPaneContext = ArtifactPaneProps["context"];

export const ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-diff-01" } as const;
export const OTHER_ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-attachment-02" } as const;

/**
 * A pane context on the address the case is about.
 *
 * `legacy-surfaces.test.ts`'s cast, for its reason: the assertions are about what the
 * address renders as. The ADDRESS half is not cast — the entity parameter is the arm's
 * own, so a case handing this pane a subject an artifact pane is never opened over
 * fails to compile here.
 *
 * THE BRIDGE IS ALWAYS PRESENT, and it used to be optional. `ConsolePaneContext`
 * declares it required and the cast hid an `undefined` from the compiler, which was
 * harmless only while nothing read it before a session existed — and stopped being so
 * the moment the pane began resolving its clock off the bridge. A case that scripts no
 * operation gets a port that refuses every one of them, which is what a live bridge
 * answers for these wires anyway.
 */
export function contextFor(
  entity: ArtifactPaneContext["entity"],
  reached: { readonly bridge?: ConsoleBridge; readonly sessionId?: string } = {},
): ArtifactPaneContext {
  return {
    kind: "artifact",
    entity,
    paneId: "pane-artifact-1",
    bridge: reached.bridge ?? artifactBridgeAnswering({}),
    // A REAL store rather than a stub carrying an id: the reader now subscribes to it
    // for three of its four refresh reasons, and a stub with no `readable` would make
    // every case here fail on the subscription rather than on what it asserts.
    sessionStore:
      reached.sessionId === undefined
        ? undefined
        : new SessionStore({ sessionId: reached.sessionId }),
  } as unknown as ArtifactPaneContext;
}

/** The delete confirm is two steps in place; both are pressed here. */
export function confirmDelete(getByRole: ReturnType<typeof render>["getByRole"]): void {
  fireEvent.click(getByRole("button", { name: "Delete" }));
  fireEvent.click(getByRole("button", { name: "Delete permanently" }));
}

/**
 * Mount the pane inside the announcer it renders under.
 *
 * `createElement` rather than JSX because this module is one home for one role and
 * the role is functions rather than a component — which is what the `.ts` extension
 * says, and what the `.tsx` half this replaced could not say while carrying the same
 * builders under a component's name.
 */
export function renderPane(context: ArtifactPaneContext): ReturnType<typeof render> {
  // The announcer is the pane's environment rather than its dependency, and it runs
  // on a frozen clock so a settlement sentence stands until the case reads it.
  return render(
    createElement(LiveAnnouncerProvider, {
      clock: new ManualClock(),
      children: createElement(ArtifactPane, { context }),
    }),
  );
}
