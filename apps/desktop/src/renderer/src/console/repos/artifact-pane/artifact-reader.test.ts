// When the pane reads, what makes it read again, and which answers it drops.
//
// WHAT A SERVED ANSWER MEANS IS NEXT DOOR, in `artifact-pane-reads.test.ts`. The two
// legs are a module of their own, and their suite drives them directly; nothing below
// asserts a row's members, because a case that did would fail for a reason that has
// nothing to do with scheduling.
//
// The load-bearing block here is the refresh one. A reader that called the port on
// every press raced itself: two presses cost two read pairs, and the two legs
// published independently, so a snapshot could carry a list from one press beside an
// allow-list from another. Every case there fails on a reader that skips the
// scheduler.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  drainMicrotasks,
  fixtureBridgeWithGrowth,
} from "../../bridge/fixture-bridge.test-support.js";
import type { GrowthPort } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import type { ArtifactPaneReading } from "./artifact-pane-reading.js";
import { ARTIFACT_TERMINAL_EVENT_KINDS, ArtifactPaneReader } from "./artifact-reader.js";
import {
  REFUSAL,
  SERVED_SUMMARY,
  SESSION_ID,
  artifactBridgeAnswering,
  readThrough,
} from "./artifact-pane.test-support.js";

describe("artifact pane reader — before anything is asked", () => {
  it("starts on the absence that says nobody asked", () => {
    const reader = new ArtifactPaneReader({
      bridge: artifactBridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
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
      bridge: artifactBridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
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
    bridge: artifactBridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
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

describe("artifact pane reader — a pane that has gone", () => {
  it("negative control: a disposed reader publishes nothing further", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      bridge: artifactBridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
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
      bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
        artifactList,
        artifactAllowlistRead,
      } as unknown as Partial<GrowthPort>),
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
      bridge: artifactBridgeAnswering({
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
      bridge: artifactBridgeAnswering({
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
      bridge: artifactBridgeAnswering({
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
      bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
        artifactList: () =>
          new Promise((resolve) => {
            releaseList = resolve;
          }),
        artifactAllowlistRead: async () => REFUSAL,
      } as unknown as Partial<GrowthPort>),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    clock.advance(REFRESH_DEBOUNCE_MS);
    await drainMicrotasks();
    expect(reader.snapshot.artifacts.kind).toBe("loading");

    reader.dispose();
    releaseList({ status: "served", value: [SERVED_SUMMARY] });
    await drainMicrotasks();

    expect(reader.snapshot.artifacts.kind).toBe("loading");
  });
});

describe("artifact reader — the frames this pane re-reads on", () => {
  it("watches every registered artifact kind, derived from the contract's census", () => {
    // A SET claim rather than a behaviour, so the case re-derives the expected members
    // from the same registry the module reads. A literal list here would be the
    // hand-written list the derivation exists to retire, restated where nothing could
    // catch its drift — and it is exactly how a fourth `artifact.*` kind would have
    // gone unwatched with every case green.
    const registered = [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].filter((eventType) =>
      eventType.startsWith("artifact."),
    );
    expect([...ARTIFACT_TERMINAL_EVENT_KINDS].sort()).toStrictEqual([...registered].sort());
    // Non-vacuity: a filter that matched nothing would satisfy the equality above on
    // both sides, and the pane would re-read on no frame at all.
    expect(ARTIFACT_TERMINAL_EVENT_KINDS.length).toBeGreaterThan(1);
  });

  it("negative control: neither the whole category nor the whole census", () => {
    // Two over-reaches at once. Selecting `artifact_publication` — the category the
    // artifact kinds live in — also takes three frames about other entities, and the
    // pane would re-read on a pull request it does not draw. Selecting nothing at all
    // would make it re-read on every run frame and every token count, which is
    // interval polling with extra steps.
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("diff.created");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("pr.prepared");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("pr.submitted");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("run.queued");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("session.created");
  });
});
