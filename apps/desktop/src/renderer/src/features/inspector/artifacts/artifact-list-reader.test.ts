// When the section reads, what makes it read again, and which answers it drops. What a served
// answer means is in `services/artifact-reads.test.ts`, so nothing here asserts a row's members.

import { describe, expect, it } from "vitest";

import type { ArtifactManifest } from "@ai-sidekicks/contracts/artifacts/manifest";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { countStoreListeners } from "@test/helpers/session-store-listeners.js";
import { handAnsweredCall } from "@test/helpers/held-calls.js";
import { ArtifactListReader } from "./artifact-list-reader.js";
import {
  SERVED_SUMMARY,
  SESSION_ID,
  artifactOperations,
  readThrough,
} from "@test/helpers/artifact-list-readers.js";

/** A reader over a store a case drives. */
function readerOver(sessionStore: SessionStore, clock: ManualClock): ArtifactListReader {
  return new ArtifactListReader({
    ...artifactOperations(),
    sessionStore,
    clock,
  });
}

describe("artifact list reader — what makes it read again", () => {
  it.each(["artifact.published", "artifact.superseded"])(
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
    const liveListeners = countStoreListeners(sessionStore);
    const reader = readerOver(sessionStore, clock);
    reader.start();
    await readThrough(clock);
    // No timer is armed once the read has settled: the reader owns no interval.
    expect(clock.pendingCount).toBe(0);
    expect(liveListeners()).toBe(1);

    reader.dispose();
    // Counted rather than inferred from silence: a disposed reader also ignores what a
    // listener it forgot to release would hear.
    expect(liveListeners()).toBe(0);
    sessionStore.initialize({ cursor: 0, entities: [] });
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "artifact.published", 1)]);
    window.dispatchEvent(new Event("focus"));
    await readThrough(clock);

    expect(reader.performCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("artifact list reader — an answer that outlived its section", () => {
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
