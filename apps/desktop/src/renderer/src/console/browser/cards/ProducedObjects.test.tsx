// The shelf, and the line it draws between a card and an identity row.
//
// The claim under test is not "it renders rows" but "it renders a card ONLY for an
// object this window produced" — so every case that asserts a card is paired with one
// asserting the same artifact renders as an identity row when no card backs it, and
// the identity row is asserted to say what it does not know rather than leaving a
// name-shaped hole.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProducedObjects } from "./ProducedObjects.js";
import type { ProducedArtifact, ProducedObjectCard } from "./produced-objects.js";

function artifactRow(overrides: Partial<ProducedArtifact> = {}): ProducedArtifact {
  return {
    artifactId: "artifact-a",
    state: "published",
    runId: undefined,
    visibility: undefined,
    latestSequence: 1,
    ...overrides,
  };
}

const CAPTURE_CARD: ProducedObjectCard = {
  kind: "capture",
  props: {
    captureName: "artifact-a",
    scope: "viewport",
    mediaType: "image/png",
    ingest: { status: "stored", artifactId: "artifact-a", byteLength: 4096 },
  },
};

const DOWNLOAD_CARD: ProducedObjectCard = {
  kind: "download",
  props: {
    proposedFileName: "artifact-a",
    sourcePageLabel: "Docs",
    ingest: { status: "stored", artifactId: "artifact-a", byteLength: 128 },
  },
};

function renderShelf(
  artifacts: readonly ProducedArtifact[],
  cards: ReadonlyMap<string, ProducedObjectCard> = new Map(),
): void {
  render(<ProducedObjects artifacts={artifacts} cardsByArtifactId={cards} />);
}

describe("the produced-object shelf", () => {
  it("says nothing has been produced rather than rendering an empty region", () => {
    renderShelf([]);
    expect(screen.getByText("Nothing produced yet")).toBeTruthy();
  });

  it("mounts the capture card for an object this window took", () => {
    renderShelf([artifactRow()], new Map([["artifact-a", CAPTURE_CARD]]));
    expect(screen.getByText("image/png")).toBeTruthy();
    // The identity row's own disclosure must NOT also render for a carded object.
    expect(screen.queryByText("Manifest not read")).toBeNull();
  });

  it("mounts the download card for a downloaded object", () => {
    renderShelf([artifactRow()], new Map([["artifact-a", DOWNLOAD_CARD]]));
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.queryByText("Manifest not read")).toBeNull();
  });

  it("renders an identity row, not a card with invented fields, where no card backs it", () => {
    renderShelf([artifactRow({ runId: "run-7", visibility: "session" })]);
    expect(screen.getByText("Manifest not read")).toBeTruthy();
    expect(screen.getByText("session")).toBeTruthy();
    expect(screen.getByText(/run-7/)).toBeTruthy();
  });

  it("distinguishes all three states on the row rather than collapsing them", () => {
    renderShelf([
      artifactRow({ artifactId: "artifact-a", state: "pending", latestSequence: 3 }),
      artifactRow({ artifactId: "artifact-b", state: "published", latestSequence: 2 }),
      artifactRow({ artifactId: "artifact-c", state: "superseded", latestSequence: 1 }),
    ]);
    expect(screen.getByText("Ingest in flight")).toBeTruthy();
    expect(screen.getByText("Stored")).toBeTruthy();
    expect(screen.getByText("Superseded")).toBeTruthy();
  });
});
