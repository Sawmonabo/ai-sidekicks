// The join, end to end: what this window produced, joined to what the log says of it.
//
// `produced-objects.test.ts` pins the fold and `ProducedObjects.test.tsx` pins the two
// row shapes; neither can see the wiring between them, and the wiring is where the
// defect lived. The shelf folded the session's whole artifact family, so a repository
// attachment — the same `artifact.published` shape a capture takes, because the
// payload names no producer — listed under "Produced objects" in a window whose
// browser had not produced it.
//
// So these cases drive the real store with a mixed log and vary only the register.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import type { ProducedObjectCard } from "./produced-objects.js";
import { SessionProducedObjects } from "./SessionProducedObjects.js";

const SESSION_ID = "session-1";
const ATTACHMENT_ID = "artifact-repo-attachment";
const CAPTURE_ID = "artifact-browser-capture";

/** The card the pane's own capture act minted, keyed by the artifact it became. */
const CAPTURE_CARD: ProducedObjectCard = {
  kind: "capture",
  props: {
    artifactId: CAPTURE_ID,
    scope: "viewport",
    mediaType: "image/png",
    ingest: { status: "stored", artifactId: CAPTURE_ID, byteLength: 4096 },
  },
};

/** A session that published one repository attachment and one browser capture. */
function mixedSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const beats: readonly ConsoleSessionEvent[] = [
    eventOfKind(SESSION_ID, "artifact.published", 1, {
      artifactId: ATTACHMENT_ID,
      state: "published",
      visibility: "shared",
      replicationStatus: "pinned",
    }),
    eventOfKind(SESSION_ID, "artifact.published", 2, {
      artifactId: CAPTURE_ID,
      state: "published",
      visibility: "local-only",
    }),
  ];
  store.applyBatch(beats);
  return store;
}

function renderShelf(cards: ReadonlyMap<string, ProducedObjectCard>): void {
  render(<SessionProducedObjects sessionStore={mixedSessionStore()} cardsByArtifactId={cards} />);
}

describe("the session's produced-object shelf", () => {
  it("shows what this window produced and not what the session published beside it", () => {
    renderShelf(new Map([[CAPTURE_ID, CAPTURE_CARD]]));
    expect(screen.getByText("image/png")).toBeTruthy();
    expect(screen.queryByText(ATTACHMENT_ID)).toBeNull();
  });

  it("negative control: the same log under an empty register produces no rows", () => {
    // Without the join this renders two rows — one of them an attachment — under a
    // heading that says the browser made them.
    renderShelf(new Map());
    expect(screen.getByText("Nothing produced yet")).toBeTruthy();
  });
});
