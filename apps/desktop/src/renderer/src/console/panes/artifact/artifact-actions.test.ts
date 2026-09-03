// The three acts a row offers, driven through the reader that hosts them.
//
// THROUGH THE READER AND NEVER BESIDE IT. `ArtifactPaneActions` is handed an
// `ArtifactActionHost`, and the only implementation of that port is the reader's own
// adapter — so a suite that supplied a hand-written host would be asserting against a
// stand-in for the half these acts are meant to be correct against. Every case here
// presses a control on a live reader.
//
// TWO LOAD-BEARING BLOCKS. The delete block is the reconciliation one: a served delete
// establishes that a row is GONE, which no in-flight list read can discover, so it
// applies and re-reads even when a refresh moved the stamp under it. The payload block
// is the single-flight one: the reading holds ONE payload, and two fetches racing put
// one artifact's bytes under another's name — so the second press is refused in words,
// a settlement the register has moved past is dropped, and a list refresh landing
// under a fetch neither cancels it nor loses its answer.

import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

/** The one session every case here reads, named once so a store and a row agree. */
const SESSION_ID = "session-1";

/** One manifest row as the growth port serves it, with every member populated. */
const SERVED_SUMMARY = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  sessionId: SESSION_ID,
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
};

/** A second artifact, so a case can press for bytes the pane is not already fetching. */
const OTHER_ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2299";

/** The receipt a served delete answers with. Every member required, so all are here. */
const DELETE_RECEIPT = {
  artifactId: SERVED_SUMMARY.artifactId,
  payloadDisposition: "reclaimed",
  rePublishForeclosed: false,
  deletedAt: "2026-09-02T07:05:00.000Z",
} as const;

const SERVED_DELETE = { status: "served", value: DELETE_RECEIPT };

const REFUSAL = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the artifact CRUD method strings are not registered yet.",
  origin: "growth-port",
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let the scheduler's coalescing window elapse, then let the read's awaits run. */
async function readThrough(clock: ManualClock): Promise<void> {
  clock.advance(REFRESH_DEBOUNCE_MS);
  await settle();
}

/**
 * A delete whose answer lands under a refresh the participant started after
 * confirming it. The list read that refresh issues can have observed the artifact
 * BEFORE the daemon destroyed it, so it republishes a row the daemon no longer
 * holds — and the delete is the only party that knows better.
 */
function readerRacingADelete(clock: ManualClock): {
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

function listedRowIds(reader: ArtifactPaneReader): readonly string[] {
  const state = reader.snapshot.artifacts;
  return state.kind === "listed" ? state.rows.map((row) => row.id) : [];
}

describe("artifact pane actions — a served delete reconciles, superseded or not", () => {
  it("removes the row and reads again when nothing raced the delete", async () => {
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    stopListingTheArtifact();
    releaseDelete(SERVED_DELETE);

    expect(await deletion).toStrictEqual({ status: "settled", receipt: DELETE_RECEIPT });
    expect(listedRowIds(reader)).toStrictEqual([]);
    await readThrough(clock);
    expect(reader.performCount).toBe(2);
  });

  it("still reconciles when a refresh moved the stamp under the delete", async () => {
    // The bug, exercised: confirm Delete, press "Read again" before the answer
    // lands, and let that read observe the artifact the daemon is about to destroy.
    // A reader that returned on the moved stamp scheduled no second read and left
    // the republished row on screen, actionable, against a manifest that is gone.
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    reader.refresh();
    await readThrough(clock);
    expect(reader.performCount).toBe(2);
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);

    stopListingTheArtifact();
    releaseDelete(SERVED_DELETE);

    // Not `settled`: the reader applied the removal and asked for the read that
    // re-establishes the rest, and it cannot vouch for a screen it does not yet own.
    expect(await deletion).toStrictEqual({ status: "reconciling", receipt: DELETE_RECEIPT });
    expect(listedRowIds(reader)).toStrictEqual([]);

    await readThrough(clock);
    expect(reader.performCount).toBe(3);
    expect(listedRowIds(reader)).toStrictEqual([]);
  });

  it("negative control: a disposed reader publishes nothing and schedules nothing", async () => {
    // The other half of the split. `#generation` answered disposal and supersession
    // with one comparison; a fix that reconciled on every served delete would re-arm
    // a scheduler behind a pane that unmounted, which is the failure the refresh
    // substrate exists to make unrepresentable.
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    reader.dispose();
    stopListingTheArtifact();
    releaseDelete(SERVED_DELETE);

    expect(await deletion).toStrictEqual({ status: "superseded" });
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);
    await readThrough(clock);
    expect(reader.performCount).toBe(1);
  });
});

/**
 * A reader whose payload fetch is held open until a case releases it.
 *
 * The list serves one row throughout, so a refresh landing under a fetch is a real
 * refresh with a real answer rather than a refusal that changes nothing.
 */
function readerWithHeldPayloadFetch(clock: ManualClock): {
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
      },
    } as unknown as ConsoleBridge,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return { reader, artifactRead, releaseRead: (answer) => releaseRead(answer) };
}

/** One served inline payload, as the reply's own union carries it. */
function servedPayload(artifactId: string, text: string): unknown {
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

describe("artifact pane actions — one payload fetch in flight, each with its own identity", () => {
  it("sends one fetch when the control is pressed twice, and refuses the second in words", async () => {
    // The bug, exercised: both presses used to capture the same refresh stamp, both
    // reached the port, and both replies passed the supersession check — so the older
    // answer could overwrite the newer bytes AND the newer manifest beside them.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    const secondPress = await reader.fetchPayload(OTHER_ARTIFACT_ID);

    expect(artifactRead).toHaveBeenCalledTimes(1);
    expect(secondPress.status).toBe("refused");
    expect(secondPress.status === "refused" ? secondPress.refusal.code : undefined).toBe(
      "payload-fetch-in-flight",
    );
    // The sentence names the artifact the pane is WAITING on, not the one pressed.
    expect(secondPress.status === "refused" ? secondPress.refusal.detail : "").toContain(
      SERVED_SUMMARY.artifactId,
    );
    // The refusal stands beside the row it was pressed on; the payload arm still
    // belongs to the fetch that is genuinely outstanding.
    expect(reader.snapshot.refusalByArtifactId.get(OTHER_ARTIFACT_ID)?.code).toBe(
      "payload-fetch-in-flight",
    );
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.artifactId,
    });

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the first press"));
    expect((await firstPress).status).toBe("settled");
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "the first press",
    );
  });

  it("drops a settlement whose request the register has given up", async () => {
    // The identity check, exercised. A disposal takes the register out from under a
    // continuation, and an answer that writes anyway would publish onto a pane that
    // unmounted — and, on a reader that had taken a successor, over its bytes.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    reader.dispose();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "an answer nobody is waiting for"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.artifactId,
    });
  });

  it("negative control: a list refresh under a fetch neither cancels it nor loses its answer", async () => {
    // Without this the register above could have been the refresh stamp again, which
    // is what it used to be: a refresh landing under a fetch returned `superseded` and
    // published nothing, leaving the reading on the in-flight absence with no answer
    // ever coming — and, with the control held on that arm, held forever.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    reader.refresh();
    await readThrough(clock);
    expect(reader.performCount).toBe(2);

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the bytes the press asked for"));

    expect((await press).status).toBe("settled");
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "the bytes the press asked for",
    );
  });

  it("negative control: the register is given back, so a later press is sent rather than refused", async () => {
    // Without this a register that was taken and never released would pass every case
    // above and refuse the second fetch a participant ever asks for, for the life of
    // the pane.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "first"));
    await firstPress;

    const secondPress = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "second"));

    expect((await secondPress).status).toBe("settled");
    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "second",
    );
  });
});
