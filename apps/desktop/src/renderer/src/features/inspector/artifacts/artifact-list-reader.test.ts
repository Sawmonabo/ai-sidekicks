// When the section reads, what makes it read again, and which answers it drops. What a served
// answer means is in `services/artifact-reads.test.ts`, so nothing here asserts a row's members.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactManifest } from "@ai-sidekicks/contracts";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { handAnsweredCall } from "@test/helpers/held-calls.js";
import type { ArtifactListReading } from "./artifact-list-reading.js";
import { ARTIFACT_TERMINAL_EVENT_KINDS } from "./artifact-read-schedule.js";
import { ArtifactListReader } from "./artifact-list-reader.js";
import {
  LISTED_ONE_ROW,
  SERVED_SUMMARY,
  SESSION_ID,
  artifactOperations,
  readThrough,
} from "@test/helpers/artifact-list-readers.js";

describe("artifact list reader — before the first read answers", () => {
  it("starts on the read that has not answered", () => {
    const reader = new ArtifactListReader({
      ...artifactOperations(),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock: new ManualClock(),
    });
    expect(reader.snapshot.artifacts.kind).toBe("loading");
  });
});

/** A reader over a store a case drives. */
function readerOver(sessionStore: SessionStore, clock: ManualClock): ArtifactListReader {
  return new ArtifactListReader({
    ...artifactOperations(),
    sessionStore,
    clock,
  });
}

describe("artifact list reader — the four reasons to read, and no fifth", () => {
  it.each(["artifact.published", "artifact.superseded", "artifact.visibility_updated"])(
    "reads again when a %s frame arrives",
    async (kind) => {
      const clock = new ManualClock();
      const sessionStore = new SessionStore({ sessionId: SESSION_ID });
      const reader = readerOver(sessionStore, clock);
      reader.start();
      await readThrough(clock);
      expect(reader.performCount).toBe(1);

      sessionStore.initialize({ cursor: 0, entities: [] });
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
    // Nothing publishes a bridge-level "reconnected", so the observed edge is the store's
    // `degradedCause` clearing.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = readerOver(sessionStore, clock);
    reader.start();
    await readThrough(clock);

    sessionStore.markDegraded("subscription-closed");
    sessionStore.initialize({ cursor: 0, entities: [] });
    await readThrough(clock);

    expect(reader.performCount).toBe(2);
  });

  it("negative control: an unrelated frame asks for nothing", async () => {
    // Without this every case above would pass against a reader that re-read on any store
    // transition. `workspace.stale` is the repos section's event, not this session's artifacts'.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = readerOver(sessionStore, clock);
    reader.start();
    await readThrough(clock);

    sessionStore.initialize({ cursor: 0, entities: [] });
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
    // No timer is armed once the read has settled: the reader owns no interval.
    expect(clock.pendingCount).toBe(0);

    reader.dispose();
    sessionStore.initialize({ cursor: 0, entities: [] });
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "artifact.published", 1)]);
    window.dispatchEvent(new Event("focus"));
    await readThrough(clock);

    expect(reader.performCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("artifact list reader — a section that has gone", () => {
  it("negative control: a disposed reader publishes nothing further", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactListReader({
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

describe("artifact list reader — reading again is coalesced, not raced", () => {
  it("costs one read when the user presses twice in one window", async () => {
    // Two presses inside the coalescing window are one reason to re-read, not two.
    const clock = new ManualClock();
    const listArtifacts = vi.fn(async () => LISTED_ONE_ROW);
    const reader = new ArtifactListReader({
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
    // Dropping to `loading` on every press would blank a section that has an answer on it.
    const clock = new ManualClock();
    const reader = new ArtifactListReader({
      ...artifactOperations({ listArtifacts: async () => [SERVED_SUMMARY] }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    const published: ArtifactListReading[] = [];
    reader.subscribe((reading) => published.push(reading));
    reader.start();
    await readThrough(clock);
    reader.refresh();
    await readThrough(clock);

    expect(published.length).toBeGreaterThan(1);
    expect(published.filter((reading) => reading.artifacts.kind === "loading")).toHaveLength(0);
    expect(reader.snapshot.artifacts.kind).toBe("listed");
  });

  it("discards a completion that outlived the section it was read for", async () => {
    // The read is in flight when the section unmounts; its answer arrives with a stale stamp.
    const clock = new ManualClock();
    const listCall = handAnsweredCall<readonly ArtifactManifest[]>();
    const reader = new ArtifactListReader({
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

describe("artifact reader — the frames this section re-reads on", () => {
  it("watches every registered artifact kind, derived from the contract's census", () => {
    // A set claim, so the expected members are re-derived from the same registry; a literal
    // list would be the hand-written list the derivation retires.
    const registered = [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].filter((eventType) =>
      eventType.startsWith("artifact."),
    );
    expect([...ARTIFACT_TERMINAL_EVENT_KINDS].sort()).toStrictEqual([...registered].sort());
    // Non-vacuity: a filter matching nothing would satisfy the equality above on both sides.
    expect(ARTIFACT_TERMINAL_EVENT_KINDS.length).toBeGreaterThan(1);
  });

  it("negative control: neither the whole category nor the whole census", () => {
    // Two over-reaches: selecting the whole `artifact_publication` category would re-read on
    // a diff or a git settlement, and selecting everything would re-read on every run frame.
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("diff.created");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("git.settled");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("run.queued");
    expect(ARTIFACT_TERMINAL_EVENT_KINDS).not.toContain("session.created");
  });
});
