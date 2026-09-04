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
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-policy.js";
import { SessionStore } from "../../store/index.js";
import type { ArtifactPaneReading } from "./artifact-pane-reading.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

/** The one session every case here reads, named once so a store and a row agree. */
const SESSION_ID = "session-1";

interface PortScript {
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
function bridgeAnswering(script: PortScript): ConsoleBridge {
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: undefined,
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
    expect(reader.performCount).toBe(0);
  });
});

/** One projected frame, as the store admits it. */
function frame(sequence: number, kind: string): Parameters<SessionStore["applyBatch"]>[0][number] {
  return {
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    kind,
    occurredAt: "2026-09-02T07:00:00.000Z",
  };
}

/** A reader over a store a case drives, with the two reads refusing throughout. */
function readerOver(sessionStore: SessionStore, clock: ManualClock): ArtifactPaneReader {
  return new ArtifactPaneReader({
    bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
    sessionStore,
    clock,
  });
}

describe("artifact pane reader — the four reasons to read, and no fifth", () => {
  it.each(["artifact.published", "artifact.superseded", "artifact.visibility_updated"])(
    "reads again when a %s frame arrives",
    async (kind) => {
      const clock = new ManualClock();
      const sessionStore = new SessionStore({ sessionId: SESSION_ID });
      const reader = readerOver(sessionStore, clock);
      reader.start();
      await readThrough(clock);
      expect(reader.performCount).toBe(1);

      sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
      sessionStore.applyBatch([frame(1, kind)]);
      await readThrough(clock);

      // The list and the effective allow-list both go stale on these three, and the
      // pane used to hold whichever one it read first, indefinitely.
      expect(reader.performCount).toBe(2);
    },
  );

  it("reads again when the window is focused", async () => {
    const clock = new ManualClock();
    const reader = readerOver(new SessionStore({ sessionId: SESSION_ID }), clock);
    reader.start();
    await readThrough(clock);

    window.dispatchEvent(new Event("focus"));
    await readThrough(clock);

    expect(reader.performCount).toBe(2);
  });

  it("reads again on the repair edge that stands for a reconnect", async () => {
    // Nothing publishes a bridge-level "reconnected", so the observed edge is the
    // store's `degradedCause` clearing: the projection is whole again after not
    // having been, which is what the refresh policy means.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = readerOver(sessionStore, clock);
    reader.start();
    await readThrough(clock);

    sessionStore.markDegraded("subscription-closed");
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    await readThrough(clock);

    expect(reader.performCount).toBe(2);
  });

  it("negative control: an unrelated frame asks for nothing", async () => {
    // Without this every case above would pass against a reader that re-read on any
    // store transition at all, which is interval polling with extra steps. A
    // `workspace.stale` frame is among them on purpose: it is the repos section's
    // terminal event and says nothing about this session's artifacts.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = readerOver(sessionStore, clock);
    reader.start();
    await readThrough(clock);

    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    sessionStore.applyBatch([frame(1, "run.queued"), frame(2, "workspace.stale")]);
    await readThrough(clock);

    expect(reader.performCount).toBe(1);
  });

  it("negative control: nothing polls at rest, and a disposed reader hears nothing", async () => {
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = readerOver(sessionStore, clock);
    reader.start();
    await readThrough(clock);
    // No timer is armed once the read has settled: the reader owns no interval, and
    // every reason it has arms the scheduler exactly once.
    expect(clock.pendingCount).toBe(0);

    reader.dispose();
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    sessionStore.applyBatch([frame(1, "artifact.published")]);
    window.dispatchEvent(new Event("focus"));
    await readThrough(clock);

    expect(reader.performCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("artifact pane reader — a refused read and a served one", () => {
  it("carries the port's refusal verbatim rather than reporting an empty list", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : []).toStrictEqual([
      {
        id: "019b7b30-0280-7c11-8420-b1a5c0de2201",
        sessionId: SESSION_ID,
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.allowlist.source).toBe("shipped-default");
    expect(reader.snapshot.allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(reader.snapshot.allowlist.refusal?.code).toBe("wire-unregistered");
  });

  it("falls back on a refusal that carries no served discriminant, and the read still settles", async () => {
    // THE SHAPE A FIXTURE AND THE LIVE PORT BOTH PRODUCE. `core`'s `refuse(...)` is
    // the console's three refusal fields and nothing else — `growthUnavailable`
    // spreads exactly that value to build its own — and a reader that asked only
    // whether `status` was `"unavailable"` read this as served, dereferenced it for
    // `contentTypes`, and turned the whole pane read into a `read-threw` carrying a
    // `TypeError`. So the two assertions that matter are the fallback arm AND the
    // list beside it: the failure this catches took both down at once.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: {
          code: "wire-unregistered",
          detail: "Not checked — the artifact CRUD method strings are not registered yet.",
          origin: "growth-port",
        },
      }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.allowlist.source).toBe("shipped-default");
    expect(reader.snapshot.allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(reader.snapshot.allowlist.refusal?.code).toBe("wire-unregistered");
    expect(reader.snapshot.artifacts.kind).toBe("listed");
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
    //
    // DRIVEN THROUGH A SERVED ROW THE MAPPING CANNOT READ, which is what still
    // reaches this sink: a call that REJECTS is now read by the leg that made it and
    // becomes that leg's own refusal, so the sink is the backstop for everything else
    // the read does — and the port is assembled behind a cast, so a served list whose
    // rows are not the shape the mapping expects is a live possibility rather than a
    // hypothetical.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [null] },
        allowlistAnswer: REFUSAL,
      }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);

    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("refused");
    expect(state.kind === "refused" ? state.refusal.code : undefined).toBe("read-threw");
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
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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

describe("artifact pane reader — one leg that did not come back", () => {
  /** What an IPC disconnect leaves in the caller's hands: a rejection, not an answer. */
  const DISCONNECTED = new Error("the bridge went away mid-read");

  /** The bounds read served, so a case can assert the leg that DID answer. */
  const SERVED_ALLOWLIST = {
    status: "served",
    value: { contentTypes: ["image/svg+xml"], maximumByteLength: 42 },
  };

  /** One read of a pane whose two legs answer whatever the case scripts. */
  async function readingOf(script: PortScript): Promise<ArtifactPaneReading> {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering(script),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);
    return reader.snapshot;
  }

  it("keeps the manifests a rejected bounds read has nothing to say about", async () => {
    // The whole defect: the two legs were joined by a `Promise.all`, so a bridge that
    // dropped only the bounds read rejected the refresh, the scheduler marked
    // `artifacts` refused, and a session's manifests were discarded because an
    // unrelated read had no answer.
    const reading = await readingOf({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: DISCONNECTED,
    });

    expect(reading.artifacts.kind).toBe("listed");
    expect(reading.artifacts.kind === "listed" ? reading.artifacts.rows.length : 0).toBe(1);
    // And the leg that did not come back says so, on the arm that arm has: the shipped
    // defaults, named as such, carrying why the deployment's own were not read.
    expect(reading.allowlist.source).toBe("shipped-default");
    expect(reading.allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(reading.allowlist.refusal?.code).toBe("call-rejected");
    expect(reading.allowlist.refusal?.detail).toContain(DISCONNECTED.message);
  });

  it("keeps the bounds a rejected list read has nothing to say about", async () => {
    const reading = await readingOf({
      listAnswer: DISCONNECTED,
      allowlistAnswer: SERVED_ALLOWLIST,
    });

    expect(reading.artifacts.kind).toBe("refused");
    expect(reading.artifacts.kind === "refused" ? reading.artifacts.refusal.code : undefined).toBe(
      "call-rejected",
    );
    expect(reading.allowlist.source).toBe("effective");
    expect(reading.allowlist.mediaTypes).toStrictEqual(["image/svg+xml"]);
  });

  it("gives each leg its own refusal when neither came back", async () => {
    // Negative control for both cases above: a fix that caught the join rather than
    // the legs would satisfy them by publishing ONE refusal over both readings — and
    // the sentence a participant read would then name whichever call lost the race.
    const reading = await readingOf({ listAnswer: DISCONNECTED, allowlistAnswer: DISCONNECTED });

    expect(reading.artifacts.kind === "refused" ? reading.artifacts.refusal.detail : "").toContain(
      "The artifact list",
    );
    expect(reading.allowlist.refusal?.detail).toContain("The attachment allow-list read");
  });

  it("negative control: two answered legs still publish one snapshot, unrefused", async () => {
    // Without this the cases above would pass against a reader that had stopped joining
    // the legs at all — which is the race the join exists to prevent: a snapshot
    // holding a list from one refresh beside an allow-list from another.
    const reading = await readingOf({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: SERVED_ALLOWLIST,
    });

    expect(reading.artifacts.kind).toBe("listed");
    expect(reading.allowlist.source).toBe("effective");
    expect(reading.allowlist.refusal).toBeUndefined();
  });
});
