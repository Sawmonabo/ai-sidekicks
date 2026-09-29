// When the pane reads, what makes it read again, and which answers it drops.
//
// What a served answer means is next door, in `artifact-pane-reads.test.ts`; nothing below
// asserts a row's members, because a case that did would fail for a reason that has nothing
// to do with scheduling.
//
// The load-bearing block here is the refresh one: a reader that called the daemon on every
// press would race itself, so two presses would cost two reads. Every case there fails on a
// reader that skips the scheduler.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactManifest } from "@ai-sidekicks/contracts";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { handAnsweredCall } from "@test/helpers/held-calls.js";
import type { ArtifactPaneReading } from "./artifact-list-reading.js";
import { ARTIFACT_TERMINAL_EVENT_KINDS } from "@renderer/features/repos/repo-lifecycle-events.js";
import { ArtifactPaneReader } from "./artifact-list-reader.js";
import {
  LISTED_ONE_ROW,
  SERVED_SUMMARY,
  SESSION_ID,
  artifactOperations,
  readThrough,
} from "@test/helpers/artifact-list-readers.js";

describe("artifact pane reader — before the first read answers", () => {
  it("starts on the read that has not answered", () => {
    const reader = new ArtifactPaneReader({
      ...artifactOperations(),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock: new ManualClock(),
    });
    expect(reader.snapshot.artifacts.kind).toBe("loading");
  });
});

/** A reader over a store a case drives. */
function readerOver(sessionStore: SessionStore, clock: ManualClock): ArtifactPaneReader {
  return new ArtifactPaneReader({
    ...artifactOperations(),
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

      sessionStore.initialise({ cursor: 0, entities: [] });
      sessionStore.applyBatch([eventOfKind(SESSION_ID, kind, 1)]);
      await readThrough(clock);

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
    sessionStore.initialise({ cursor: 0, entities: [] });
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

    sessionStore.initialise({ cursor: 0, entities: [] });
    sessionStore.applyBatch([
      eventOfKind(SESSION_ID, "run.queued", 1),
      eventOfKind(SESSION_ID, "workspace.stale", 2),
    ]);
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
    sessionStore.initialise({ cursor: 0, entities: [] });
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "artifact.published", 1)]);
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
      ...artifactOperations(),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.dispose();
    reader.start();
    await readThrough(clock);
    expect(reader.snapshot.artifacts.kind).toBe("loading");
  });
});

describe("artifact pane reader — reading again is coalesced, not raced", () => {
  it("costs one read when the user presses twice in one window", async () => {
    // Two presses inside the coalescing window are one reason to re-read, not two. A
    // reader that called the daemon on every press issues two list calls here.
    const clock = new ManualClock();
    const listArtifacts = vi.fn(async () => LISTED_ONE_ROW);
    const reader = new ArtifactPaneReader({
      ...artifactOperations({ listArtifacts }),
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
    expect(listArtifacts).toHaveBeenCalledTimes(2);
  });

  it("never drops answered rows back to loading on a re-read", async () => {
    // Dropping the rows back to `loading` on every press would blank a surface that has an
    // answer on it.
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      ...artifactOperations({ listArtifacts: async () => [SERVED_SUMMARY] }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    const published: ArtifactPaneReading[] = [];
    reader.subscribe((reading) => published.push(reading));
    reader.start();
    await readThrough(clock);
    reader.refresh();
    await readThrough(clock);

    expect(published.length).toBeGreaterThan(1);
    expect(published.filter((reading) => reading.artifacts.kind === "loading")).toHaveLength(0);
    expect(reader.snapshot.artifacts.kind).toBe("listed");
  });

  it("discards a completion that outlived the pane it was read for", async () => {
    // The generation stamp, exercised: the read is in flight when the pane unmounts,
    // and its answer arrives afterwards with a stamp that is no longer current.
    const clock = new ManualClock();
    const listCall = handAnsweredCall<readonly ArtifactManifest[]>();
    const reader = new ArtifactPaneReader({
      ...artifactOperations({ listArtifacts: listCall.invoke }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    clock.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
    expect(reader.snapshot.artifacts.kind).toBe("loading");

    reader.dispose();
    listCall.open([SERVED_SUMMARY]);
    await crossMacrotaskBoundary();

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
