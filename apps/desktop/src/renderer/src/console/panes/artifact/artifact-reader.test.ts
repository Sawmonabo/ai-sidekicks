// What the pane reads, when it reads again, and the one thing it refuses to invent.
//
// The refusal-on-served case is the load-bearing one: a growth port that ANSWERS
// `artifactList` still cannot supply a manifest row, and a reader that mapped four
// summary members into a thirteen-member envelope would be putting a `state` and a
// `visibility` on screen that no read established.
//
// The second load-bearing block is the refresh one. A reader that called the port on
// every press raced itself: two presses cost two read pairs, and the two legs
// published independently, so a snapshot could carry a list from one press beside an
// allow-list from another. Every case there fails on a reader that skips the
// scheduler.

import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
import type { ArtifactPaneReading } from "./artifact-pane-reading.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

interface PortScript {
  readonly listAnswer: unknown;
  readonly allowlistAnswer: unknown;
}

function bridgeAnswering(script: PortScript): ConsoleBridge {
  return {
    growth: {
      artifactList: async () => script.listAnswer,
      artifactAllowlistRead: async () => script.allowlistAnswer,
    },
  } as unknown as ConsoleBridge;
}

/** One manifest row as the growth port serves it, with every member populated. */
const SERVED_SUMMARY = {
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
};

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

describe("artifact pane reader — before anything is asked", () => {
  it("starts on the absence that says nobody asked", () => {
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
      clock: new ManualClock(),
    });
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
  });

  it("reads nothing at all on a pane with no session behind it", async () => {
    // A bare route has a pane and no session. Reading anyway would mean inventing a
    // session id, so the reader stays where it was.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: undefined,
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
    expect(reader.performCount).toBe(0);
  });
});

describe("artifact pane reader — a refused read and a served one", () => {
  it("carries the port's refusal verbatim rather than reporting an empty list", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("refused");
    expect(state.kind === "refused" ? state.refusal.code : undefined).toBe("wire-unregistered");
  });

  it("reads a served manifest summary as a row, member for member", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: REFUSAL,
      }),
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : []).toStrictEqual([
      {
        id: "019b7b30-0280-7c11-8420-b1a5c0de2201",
        sessionId: "session-1",
        runId: "019b7b30-0280-7c11-8420-b1a5c0de2202",
        createdBy: "019b7b30-0280-7c11-8420-b1a5c0de2203",
        artifactType: "diff",
        digest: "sha256:2b4c",
        size: 4096,
        annotations: { "org.opencontainers.image.title": "rate-limit-wiring.patch" },
        subject: undefined,
        visibility: "shared",
        state: "published",
        replicationStatus: "pinned",
        // Freeform provenance is typed `unknown` on the wire and drawn as a string, so
        // a non-string value is rendered in its own form rather than dropped.
        metadata: { mediaType: "text/x-patch", turnOrdinal: "12" },
        createdAt: "2026-09-02T07:00:00.000Z",
      },
    ]);
  });

  it("distinguishes a read that found none from a read nobody made", async () => {
    // Negative control for the case above: a reader that published `not-checked` for
    // an empty served list would pass every member assertion and still be wrong about
    // the one thing an empty list says.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [] },
        allowlistAnswer: REFUSAL,
      }),
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : undefined).toStrictEqual([]);
  });
});

describe("artifact pane reader — the allow-list hint", () => {
  it("falls back to the shipped default and says so, carrying the refusal", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.allowlist.source).toBe("shipped-default");
    expect(reader.snapshot.allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(reader.snapshot.allowlist.refusal?.code).toBe("wire-unregistered");
  });

  it("takes the effective list wholesale when the daemon answers", async () => {
    // Wholesale, never merged: an operator override REPLACES the default, so a reading
    // that unioned the two would describe a deployment that does not exist.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: REFUSAL,
        allowlistAnswer: {
          status: "served",
          value: { contentTypes: ["image/svg+xml"], maximumByteLength: 42 },
        },
      }),
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.allowlist.source).toBe("effective");
    expect(reader.snapshot.allowlist.mediaTypes).toStrictEqual(["image/svg+xml"]);
    expect(reader.snapshot.allowlist.maximumByteLength).toBe(42);
  });

  it("negative control: a disposed reader publishes nothing further", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
      clock,
    });
    reader.dispose();
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
  });
});

describe("artifact pane reader — reading again is coalesced, not raced", () => {
  it("costs one read pair when the participant presses twice in one window", async () => {
    // Two presses inside the coalescing window are one reason to re-read, not two. A
    // reader that called the port on every press issues two list calls and two
    // allow-list calls here.
    const clock = new ManualClock();
    const artifactList = vi.fn(async () => REFUSAL);
    const artifactAllowlistRead = vi.fn(async () => REFUSAL);
    const reader = new ArtifactPaneReader({
      bridge: { growth: { artifactList, artifactAllowlistRead } } as unknown as ConsoleBridge,
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.performCount).toBe(1);

    reader.refresh();
    reader.refresh();
    await readThrough(clock);

    expect(reader.performCount).toBe(2);
    expect(artifactList).toHaveBeenCalledTimes(2);
    expect(artifactAllowlistRead).toHaveBeenCalledTimes(2);
  });

  it("publishes both legs of one refresh as one snapshot", async () => {
    // A reader whose legs publish independently emits a snapshot carrying the served
    // list beside the shipped-default allow-list before the effective one lands. That
    // snapshot is a deployment that does not exist, and it is what this count forbids.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: {
          status: "served",
          value: { contentTypes: ["text/plain"], maximumByteLength: 99 },
        },
      }),
      sessionId: "session-1",
      clock,
    });
    const published: ArtifactPaneReading[] = [];
    reader.subscribe((reading) => published.push(reading));
    reader.start();
    await readThrough(clock);

    // The in-flight absence, then the answer. Nothing between them.
    expect(published).toHaveLength(2);
    expect(published[0]?.artifacts.kind).toBe("loading");
    expect(published[1]?.artifacts.kind).toBe("listed");
    expect(published[1]?.allowlist.source).toBe("effective");
  });

  it("enters the in-flight absence once and never re-enters it on a re-read", async () => {
    // Rule 8 separates "a read is in flight" from "nobody asked". Dropping the rows
    // back to the in-flight absence on every press would blank a surface that has an
    // answer on it.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: REFUSAL,
      }),
      sessionId: "session-1",
      clock,
    });
    const published: ArtifactPaneReading[] = [];
    reader.subscribe((reading) => published.push(reading));
    reader.start();
    await readThrough(clock);
    reader.refresh();
    await readThrough(clock);

    expect(published.filter((reading) => reading.artifacts.kind === "loading")).toHaveLength(1);
    expect(reader.snapshot.artifacts.kind).toBe("listed");
  });

  it("lands a read that threw as a refusal rather than losing it", async () => {
    // The scheduler performs the read inside a timer callback, where a rejection
    // reaches nobody. A reader with no error sink leaves the pane on the in-flight
    // absence for the rest of its life.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: {
        growth: {
          artifactList: async () => {
            throw new Error("the socket closed");
          },
          artifactAllowlistRead: async () => REFUSAL,
        },
      } as unknown as ConsoleBridge,
      sessionId: "session-1",
      clock,
    });
    reader.start();
    await readThrough(clock);

    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("refused");
    expect(state.kind === "refused" ? state.refusal.code : undefined).toBe("read-threw");
    expect(state.kind === "refused" ? state.refusal.detail : "").toContain("the socket closed");
  });

  it("discards a completion that outlived the pane it was read for", async () => {
    // The generation stamp, exercised: the read is in flight when the pane unmounts,
    // and its answer arrives afterwards with a stamp that is no longer current.
    const clock = new ManualClock();
    let releaseList: (answer: unknown) => void = () => undefined;
    const reader = new ArtifactPaneReader({
      bridge: {
        growth: {
          artifactList: () =>
            new Promise((resolve) => {
              releaseList = resolve;
            }),
          artifactAllowlistRead: async () => REFUSAL,
        },
      } as unknown as ConsoleBridge,
      sessionId: "session-1",
      clock,
    });
    reader.start();
    clock.advance(REFRESH_DEBOUNCE_MS);
    await settle();
    expect(reader.snapshot.artifacts.kind).toBe("loading");

    reader.dispose();
    releaseList({ status: "served", value: [SERVED_SUMMARY] });
    await settle();

    expect(reader.snapshot.artifacts.kind).toBe("loading");
  });
});

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
    sessionId: "session-1",
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

describe("artifact pane reader — a served delete reconciles, superseded or not", () => {
  it("removes the row and reads again when nothing raced the delete", async () => {
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    stopListingTheArtifact();
    releaseDelete({ status: "served", value: undefined });

    expect(await deletion).toStrictEqual({ status: "settled" });
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
    releaseDelete({ status: "served", value: undefined });

    // Not `settled`: the reader applied the removal and asked for the read that
    // re-establishes the rest, and it cannot vouch for a screen it does not yet own.
    expect(await deletion).toStrictEqual({ status: "reconciling" });
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
    releaseDelete({ status: "served", value: undefined });

    expect(await deletion).toStrictEqual({ status: "superseded" });
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);
    await readThrough(clock);
    expect(reader.performCount).toBe(1);
  });
});
