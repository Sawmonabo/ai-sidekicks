// How the artifact reading's reader is held: the clock it runs on, and the subject-scoped
// seam that decides when a new one is minted and the old one disposed.
//
// A reader that outlives its subject and a reader that reads the wall clock are both a
// binding answering about a session it is no longer showing, so the cases sit together.

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
import { ArtifactPaneReader } from "../artifact-list-reader.js";
import {
  OTHER_HOSTED_ARTIFACT_ID,
  hostSubject,
  hostTree,
  renderHost,
  renderHostStrictly,
} from "@renderer/features/repos/artifacts/components/artifact-payload-section.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact reading — the reader runs on the window's clock, never one of its own", () => {
  it("reads when the window's clock reaches it, not when the host's does", async () => {
    // A reader on its own `RealClock` would coalesce its reads against wall time while the
    // window advanced on frozen time, and the host-timer advance below would list the row.
    const subject = hostSubject(artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }));
    const { container } = renderHost(subject);

    // The HOST's clock, moved the whole debounce window. Nothing lists.
    await readThrough();
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    // The window's, moved the same window. The read runs.
    await readThrough(subject.clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });
});

describe("artifact reading — the reader is held by the subject-scoped seam", () => {
  it("comes back from the disposal-then-replay React's double-mount performs", async () => {
    // `StrictMode` runs setup, then cleanup, then setup again on the same committed value:
    // cleanup disposes the reader and the replayed setup would call `start()` on the corpse,
    // which returns at once. The binding would then sit on `loading` for the life of the
    // mount.
    const subject = hostSubject(artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }));
    const { container } = renderHostStrictly(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });

  it("keeps one reader across a re-render at the same artifact", async () => {
    // The seam holds the reader in state React owns, so a re-render at the same subject
    // reaches the same reader: the row stands and the call is not made again.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = hostSubject(artifactOperations({ listArtifacts: artifactList }));
    const { container, rerender } = renderHost(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(hostTree(subject));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });

  it("mints a reader of its own when the binding moves to another artifact", async () => {
    // The subject is the key, so a moved subject is a new reader, and the binding opens on
    // the new artifact's `loading` reading rather than on the previous one's rows.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = hostSubject(artifactOperations({ listArtifacts: artifactList }));
    const { container, rerender } = renderHost(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(hostTree(subject, OTHER_HOSTED_ARTIFACT_ID));
    await settleAct();
    // The new reader has read nothing yet, so it shows no rows.
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("mints a reader of its own when the session projection is replaced", async () => {
    // The store is not part of the seam's key, because an artifact id already names one
    // session, so a projection rebuilt across a reconnect is caught by asking the reader.
    // Without that arm the binding would keep observing a retired store.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const operations = artifactOperations({ listArtifacts: artifactList });
    const subject = hostSubject(operations);
    const { rerender } = renderHost(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(hostTree({ ...subject, sessionStore: new SessionStore({ sessionId: SESSION_ID }) }));
    await settleAct();
    await readThrough(subject.clock);
    await settleAct();

    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("mints a reader of its own when the operations are replaced", async () => {
    // The operations are part of what the reader was built from. A reader kept across a
    // new pair of calls would go on listing through the calls it was first given.
    const firstList = vi.fn(async () => LISTED_ONE_ROW);
    const secondList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = hostSubject(artifactOperations({ listArtifacts: firstList }));
    const { rerender } = renderHost(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(firstList).toHaveBeenCalledTimes(1);

    rerender(
      hostTree({ ...subject, operations: artifactOperations({ listArtifacts: secondList }) }),
    );
    await settleAct();
    await readThrough(subject.clock);
    await settleAct();

    expect(secondList).toHaveBeenCalledTimes(1);
    expect(firstList).toHaveBeenCalledTimes(1);
  });

  it("negative control: an unmounted binding's reader is disposed and reads no more", async () => {
    // A binding that answered the double-mount by never disposing would leave a torn-down
    // pane still scheduling, and one that re-minted on every effect run would read forever.
    // The seam's cleanup disposes what the last commit held, and a clock advanced afterwards
    // reaches nothing.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = hostSubject(artifactOperations({ listArtifacts: artifactList }));
    const { unmount } = renderHost(subject);

    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    unmount();
    await readThrough(subject.clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });

  it("disposes every reader it opened exactly once", async () => {
    // The seam is told the disposal is terminal through `isClosed`, and the re-mint for a
    // corpse is then the seam's. Re-derived in the hook's own effect, the corpse StrictMode's
    // replay produced would be disposed a second time. `dispose` is re-entrant, so the call
    // is the observable.
    const disposals = vi.spyOn(ArtifactPaneReader.prototype, "dispose");
    try {
      const subject = hostSubject(
        artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }),
      );
      const { unmount } = renderHostStrictly(subject);
      await readThrough(subject.clock);
      await settleAct();
      unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      // Negative control on the count: a spy that saw nothing reports zero repeats.
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
  });
});
