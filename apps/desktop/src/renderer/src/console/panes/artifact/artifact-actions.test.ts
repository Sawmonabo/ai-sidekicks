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
import { ConsoleRefusalError, ManualClock, REFRESH_DEBOUNCE_MS, refuse } from "../../core/index.js";
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

/**
 * A reader whose port REJECTS instead of answering.
 *
 * The live bridge is one process boundary away, so an IPC disconnect makes the call
 * throw rather than return the port's typed refusal — the one failure `GrowthOutcome`
 * cannot express and therefore the one `growthAnswerReading` never sees.
 */
function readerWithRejectingBridge(
  clock: ManualClock,
  rejection: unknown,
): {
  readonly reader: ArtifactPaneReader;
  readonly artifactRead: ReturnType<typeof vi.fn>;
} {
  const artifactRead = vi.fn(() => Promise.reject(rejection));
  const reader = new ArtifactPaneReader({
    bridge: {
      growth: {
        artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
        artifactAllowlistRead: async () => REFUSAL,
        artifactRead,
        artifactDelete: () => Promise.reject(rejection),
      },
    } as unknown as ConsoleBridge,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return { reader, artifactRead };
}

describe("artifact pane actions — a rejected call is an answer, not a stuck pane", () => {
  it("publishes the refused payload arm and gives the control back", async () => {
    // The bug, exercised: the thrown rejection propagated out of the await, so
    // `growthAnswerReading` was never reached, `finally` released the register, and
    // the reading kept `{ status: "fetching" }` — the arm the pane holds its Fetch
    // control by and the arm every scheduled list read carries forward. Nothing was
    // ever going to settle it short of a remount.
    const clock = new ManualClock();
    const { reader, artifactRead } = readerWithRejectingBridge(
      clock,
      new Error("the daemon channel closed"),
    );
    reader.start();
    await readThrough(clock);

    const outcome = await reader.fetchPayload(SERVED_SUMMARY.artifactId);

    expect(outcome.status).toBe("refused");
    expect(reader.snapshot.payload).toStrictEqual({
      status: "refused",
      artifactId: SERVED_SUMMARY.artifactId,
      refusal: {
        code: "call-rejected",
        detail: "The payload fetch was rejected: Error: the daemon channel closed",
        origin: "repos",
      },
    });
    // The control is held by the `fetching` arm alone, so leaving that arm IS the
    // control coming back — there is no second flag to assert against.
    expect(reader.snapshot.payload.status).not.toBe("fetching");

    // And the register was given back, so the next press reaches the port rather
    // than meeting the in-flight refusal for the life of the pane.
    await reader.fetchPayload(SERVED_SUMMARY.artifactId);
    expect(artifactRead).toHaveBeenCalledTimes(2);
  });

  it("carries a thrown refusal through with the origin and code it named", async () => {
    // The normalizer's first arm, which is why this pane does not mint its own: the
    // fixture bridge throws a `ConsoleRefusalError`, and re-labelling it
    // `call-rejected` would bury the diagnosis the seam already composed.
    const clock = new ManualClock();
    const carried = refuse("growth-port", "scripted-reply-missing", "No reply was parked.");
    const { reader } = readerWithRejectingBridge(clock, new ConsoleRefusalError(carried));
    reader.start();
    await readThrough(clock);

    const outcome = await reader.fetchPayload(SERVED_SUMMARY.artifactId);

    expect(outcome).toStrictEqual({ status: "refused", refusal: carried });
    expect(reader.snapshot.payload).toStrictEqual({
      status: "refused",
      artifactId: SERVED_SUMMARY.artifactId,
      refusal: carried,
    });
  });

  it("records a rejected manifest re-read against its row, and a rejected delete too", async () => {
    // The other two acts ask the same bridge across the same boundary. Left bare,
    // each returned a rejected promise to a caller that only ever attaches `.then`,
    // so the press produced no refusal anywhere and an unhandled rejection instead.
    const clock = new ManualClock();
    const { reader } = readerWithRejectingBridge(clock, new Error("the daemon channel closed"));
    reader.start();
    await readThrough(clock);

    const reRead = await reader.readManifest(SERVED_SUMMARY.artifactId);
    expect(reRead.status).toBe("refused");
    expect(reader.snapshot.refusalByArtifactId.get(SERVED_SUMMARY.artifactId)?.code).toBe(
      "call-rejected",
    );

    const deletion = await reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    expect(deletion.status).toBe("refused");
    // The row is still listed: a rejected delete established nothing at all, and
    // removing the row would report a destruction the daemon never confirmed.
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);
  });

  it("negative control: a served answer still settles and a port refusal keeps its own code", async () => {
    // Both halves of the over-reach. A `try` that swallowed the served path would
    // pass every case above; so would one that re-labelled the port's own typed
    // refusal, which is the code a person pastes into a bug report.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const served = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the bytes came back"));
    expect((await served).status).toBe("settled");

    const refusing = new ArtifactPaneReader({
      bridge: {
        growth: {
          artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
          artifactAllowlistRead: async () => REFUSAL,
          artifactRead: async () => REFUSAL,
        },
      } as unknown as ConsoleBridge,
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    refusing.start();
    await readThrough(clock);

    const refused = await refusing.fetchPayload(SERVED_SUMMARY.artifactId);
    expect(refused.status === "refused" ? refused.refusal.code : undefined).toBe(
      "wire-unregistered",
    );
    expect(refused.status === "refused" ? refused.refusal.origin : undefined).toBe("growth-port");
  });
});

describe("artifact pane actions — a delete supersedes the fetch for the row it destroyed", () => {
  it("drops a payload settlement the delete overtook", async () => {
    // The bug, exercised: press Fetch, confirm Delete before the bytes arrive, and
    // let the read the daemon completed BEFORE the delete be delivered after it. The
    // publish cleared the visible payload and left the register alone, so the
    // continuation passed the identity check and put the destroyed manifest's bytes
    // back — and the reconciling list read carries a payload arm forward rather than
    // clearing it, so the stale preview stayed until somebody refreshed by hand.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    expect(reader.snapshot.payload.status).toBe("fetching");

    const deletion = await reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    expect(deletion.status).toBe("settled");
    expect(reader.snapshot.payload).toStrictEqual({ status: "not-checked" });

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "bytes of a manifest that is gone"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(reader.snapshot.payload).toStrictEqual({ status: "not-checked" });
    // And the row stays off the list: the late answer also carries a manifest, which
    // a republished payload would have brought back with it.
    expect(listedRowIds(reader)).toStrictEqual([]);
  });

  it("gives the control back, so the next artifact can be fetched at once", async () => {
    // The second symptom of the same untouched register. The reading said nothing
    // was being fetched while the register said one was, so the next press was
    // refused in words by a pane that was offering the control.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    void reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    await reader.deleteArtifact(SERVED_SUMMARY.artifactId);

    const nextPress = reader.fetchPayload(OTHER_ARTIFACT_ID);
    await settle();
    expect(artifactRead).toHaveBeenCalledTimes(2);
    releaseRead(servedPayload(OTHER_ARTIFACT_ID, "the next artifact's bytes"));
    expect((await nextPress).status).toBe("settled");
  });

  it("negative control: a delete of another row leaves the fetch standing", async () => {
    // Without this, clearing the register on every served delete would throw away
    // the answer to a fetch the delete says nothing about — a participant deleting
    // one artifact would silently lose the preview they had just asked for of
    // another, and the pane would report `superseded` for work it did do.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    await reader.deleteArtifact(OTHER_ARTIFACT_ID);

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the bytes the press asked for"));

    expect((await press).status).toBe("settled");
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "the bytes the press asked for",
    );
  });
});
