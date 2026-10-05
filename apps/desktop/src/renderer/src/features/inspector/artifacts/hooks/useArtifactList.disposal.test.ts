// When the artifact reading mints a new reader rather than keep one bound to the old subject.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "#renderer/store/session/session-store.js";
import {
  LISTED_ONE_ROW,
  OTHER_ARTIFACT_ID,
  SESSION_ID,
  artifactOperations,
  readThrough,
  settleAct,
} from "#test/helpers/artifact-list-readers.js";
import {
  artifactPayloadSubject,
  artifactPayloadTree,
  renderArtifactPayloadSection,
} from "#test/helpers/render-artifact-payload-section.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact reading — the reader is held by the subject-scoped seam", () => {
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
});
