// The join, end to end: what this window produced, joined to what the log says of it.
//
// `produced-objects.test.ts` pins the fold and `ProducedObjects.test.tsx` pins the two
// row shapes; neither can see the wiring between them, and the wiring is where the
// defect lived. The shelf folded the session's whole artifact family, so a repository
// attachment — the same `artifact.published` shape a capture takes, because the
// payload names no producer — listed under "Produced objects" in a window whose
// browser had not produced it.
//
// So these cases drive the real store with a mixed log and vary only the provenance.
//
// AND THE PROVENANCE IS NO LONGER THE REGISTER, which is the second defect these cases
// pin. The allowed set was the pane's own card map, so an agent's capture, a completed
// download, a bundled asset set, a capture started from the composer's attach row, and
// anything produced before the pane remounted were all dropped — every one of them a
// valid `artifact.*` beat — and the shelf said nothing had been produced.
// `produced-provenance.ts` composes the set the daemon names with the cards this
// window minted, and what arrives here is that map.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import type { ProducedObjectCard } from "./produced-objects.js";
import { joinProducedObjects } from "./produced-provenance.js";
import { SessionProducedObjects } from "./SessionProducedObjects.js";

const SESSION_ID = "session-1";
const ATTACHMENT_ID = "artifact-repo-attachment";
const CAPTURE_ID = "artifact-browser-capture";

/** The four browser producers no renderer act ever sees, one id each. */
const AGENT_CAPTURE_ID = "artifact-agent-capture";
const DOWNLOAD_ID = "artifact-completed-download";
const ASSET_BUNDLE_ID = "artifact-asset-bundle";
const ATTACH_MENU_CAPTURE_ID = "artifact-attach-menu-capture";

/** One the browser produced before this pane mounted, which no register carries. */
const PRE_REMOUNT_ID = "artifact-produced-before-this-mount";

/** Every id above, as the daemon's ledger names them. */
const DAEMON_PRODUCED_IDS: readonly string[] = [
  AGENT_CAPTURE_ID,
  DOWNLOAD_ID,
  ASSET_BUNDLE_ID,
  ATTACH_MENU_CAPTURE_ID,
  PRE_REMOUNT_ID,
];

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

/**
 * A session that published one repository attachment beside every browser producer.
 *
 * Every row is the same `artifact.published` shape, which is the whole difficulty: the
 * payload names no producer, so nothing on this log tells the attachment from the
 * capture beside it.
 */
function mixedSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const published: readonly string[] = [ATTACHMENT_ID, CAPTURE_ID, ...DAEMON_PRODUCED_IDS];
  store.applyBatch(
    published.map(
      (artifactId, index): ConsoleSessionEvent =>
        eventOfKind(SESSION_ID, "artifact.published", index + 1, {
          artifactId,
          state: "published",
          visibility: artifactId === ATTACHMENT_ID ? "shared" : "local-only",
          ...(artifactId === ATTACHMENT_ID ? { replicationStatus: "pinned" } : {}),
        }),
    ),
  );
  return store;
}

/** The map the pane hands the shelf: the daemon's ledger, plus this window's cards. */
function shelfProvenance(
  ledger: readonly string[],
  cards: ReadonlyMap<string, ProducedObjectCard>,
): ReadonlyMap<string, ProducedObjectCard> {
  return joinProducedObjects(new Set(ledger), cards);
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

  it("lists every browser producer, including the four no renderer act ever sees", () => {
    // The reviewer's five classes, one row each: an agent's capture, a completed
    // download, a bundled asset set, a capture started from the composer's attach row,
    // and an object produced before this pane mounted. Under the card register every
    // one of them was dropped and the shelf reported nothing produced.
    renderShelf(shelfProvenance(DAEMON_PRODUCED_IDS, new Map()));
    for (const artifactId of DAEMON_PRODUCED_IDS) {
      expect(screen.getByText(artifactId), artifactId).toBeTruthy();
    }
    expect(screen.queryByText("Nothing produced yet")).toBeNull();
  });

  it("still leaves out what the session published from somewhere else", () => {
    // The ledger is a membership answer and not a widening: an artifact nobody named
    // as browser output belongs on the timeline, not under this heading.
    renderShelf(shelfProvenance(DAEMON_PRODUCED_IDS, new Map([[CAPTURE_ID, CAPTURE_CARD]])));
    expect(screen.queryByText(ATTACHMENT_ID)).toBeNull();
    expect(screen.getByText("image/png")).toBeTruthy();
  });

  it("negative control: the same log with nothing named produces no rows", () => {
    // Without the join this renders every row in the log — the attachment among them —
    // under a heading that says the browser made them.
    renderShelf(new Map());
    expect(screen.getByText("Nothing produced yet")).toBeTruthy();
  });
});
