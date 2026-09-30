// How the artifact reading's reader is held: the clock it runs on, and the subject-scoped
// seam that decides when a new one is minted and the old one disposed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "@renderer/store/session/session-store.js";
import { repeatedDisposalCount } from "@test/helpers/repeated-disposal.js";
import {
  LISTED_ONE_ROW,
  SESSION_ID,
  artifactOperations,
  readThrough,
  settleAct,
} from "@test/helpers/artifact-list-readers.js";
import { ArtifactListReader } from "../artifact-list-reader.js";
import {
  OTHER_ARTIFACT_ID,
  artifactPayloadSubject,
  artifactPayloadTree,
  renderArtifactPayloadSection,
  renderArtifactPayloadSectionStrictly,
} from "@test/helpers/render-artifact-payload-section.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact reading — the reader runs on the window's clock, never one of its own", () => {
  it("reads when the window's clock reaches it, not when the host's does", async () => {
    // A reader on its own `RealClock` would coalesce against wall time while the window
    // advanced on frozen time, and the host-timer advance below would list the row.
    const subject = artifactPayloadSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }),
    );
    const { container } = renderArtifactPayloadSection(subject);

    await readThrough();
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(subject.clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });
});

describe("artifact reading — the reader is held by the subject-scoped seam", () => {
  it("comes back from the disposal-then-replay React's double-mount performs", async () => {
    // `StrictMode` runs setup, cleanup, setup on the same committed value; the replayed setup
    // would call `start()` on the disposed reader and the binding would sit on `loading`.
    const subject = artifactPayloadSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }),
    );
    const { container } = renderArtifactPayloadSectionStrictly(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });

  it("keeps one reader across a re-render at the same artifact", async () => {
    // The seam holds the reader in state React owns, so a re-render reaches the same reader.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = artifactPayloadSubject(artifactOperations({ listArtifacts: artifactList }));
    const { container, rerender } = renderArtifactPayloadSection(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(artifactPayloadTree(subject));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });

  it("mints a reader of its own when the binding moves to another artifact", async () => {
    // The subject is the key, so a moved subject is a new reader that opens on `loading`.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = artifactPayloadSubject(artifactOperations({ listArtifacts: artifactList }));
    const { container, rerender } = renderArtifactPayloadSection(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(artifactPayloadTree(subject, OTHER_ARTIFACT_ID));
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("mints a reader of its own when the session projection is replaced", async () => {
    // The store is not part of the seam's key, so a projection rebuilt across a reconnect is
    // caught by asking the reader; otherwise the binding would observe a retired store.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const operations = artifactOperations({ listArtifacts: artifactList });
    const subject = artifactPayloadSubject(operations);
    const { rerender } = renderArtifactPayloadSection(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(
      artifactPayloadTree({
        ...subject,
        sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      }),
    );
    await settleAct();
    await readThrough(subject.clock);
    await settleAct();

    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("mints a reader of its own when the operations are replaced", async () => {
    // A reader kept across new operations would go on listing through the calls it was given.
    const firstList = vi.fn(async () => LISTED_ONE_ROW);
    const secondList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = artifactPayloadSubject(artifactOperations({ listArtifacts: firstList }));
    const { rerender } = renderArtifactPayloadSection(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(firstList).toHaveBeenCalledTimes(1);

    rerender(
      artifactPayloadTree({
        ...subject,
        operations: artifactOperations({ listArtifacts: secondList }),
      }),
    );
    await settleAct();
    await readThrough(subject.clock);
    await settleAct();

    expect(secondList).toHaveBeenCalledTimes(1);
    expect(firstList).toHaveBeenCalledTimes(1);
  });

  it("negative control: an unmounted binding's reader is disposed and reads no more", async () => {
    // A binding that never disposed would leave a torn-down section still scheduling, and one
    // that re-minted on every effect run would read forever.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = artifactPayloadSubject(artifactOperations({ listArtifacts: artifactList }));
    const { unmount } = renderArtifactPayloadSection(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    unmount();
    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });

  it("disposes every reader it opened exactly once", async () => {
    // The seam is told disposal is terminal through `isClosed`, so the corpse StrictMode's
    // replay produced is not disposed a second time. `dispose` is re-entrant, so the call is
    // the observable.
    const disposals = vi.spyOn(ArtifactListReader.prototype, "dispose");
    try {
      const subject = artifactPayloadSubject(
        artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }),
      );
      const { unmount } = renderArtifactPayloadSectionStrictly(subject);
      await readThrough(subject.clock);
      await settleAct();
      unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
  });
});
