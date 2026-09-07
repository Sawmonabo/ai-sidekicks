// The shelf, and the two lines it draws: card versus identity row, and the log's state
// versus the producing act's answer.
//
// The claim under test is not "it renders rows" but "it renders a card ONLY for an
// object this window produced, and never at the cost of what the log says about it" —
// so every case that asserts a card is paired with one asserting the same artifact
// renders as an identity row when no card backs it, and the lifecycle state is
// asserted on the CARD, because that is the row a card used to hide it on.

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

// No `captureName`: `browserCapture` answers with none, so the register mints none and
// the card renders its identity as a wire figure instead of wearing the id as a name.
const CAPTURE_CARD: ProducedObjectCard = {
  kind: "capture",
  props: {
    artifactId: "artifact-a",
    scope: "viewport",
    mediaType: "image/png",
    ingest: { status: "stored", artifactId: "artifact-a", byteLength: 4096 },
  },
};

// The proposed name is deliberately NOT the artifact id, on the precedent
// `produced-objects.test.ts` sets for the identity reader: the download arm carries its
// own `artifactId` because a page's suggestion is never an identity, and a fixture that
// spelled the two the same would pass against a card that had conflated them.
const DOWNLOAD_CARD: ProducedObjectCard = {
  kind: "download",
  props: {
    artifactId: "artifact-a",
    proposedFileName: "quarterly-report.pdf",
    sourcePageLabel: "Docs",
    ingest: { status: "stored", artifactId: "artifact-a", byteLength: 128 },
  },
};

function renderShelf(
  artifacts: readonly ProducedArtifact[],
  cards: ReadonlyMap<string, ProducedObjectCard> = new Map(),
): HTMLElement {
  const { container } = render(<ProducedObjects artifacts={artifacts} cardsByArtifactId={cards} />);
  return container;
}

/** The identity row wears its own modifier; both row shapes carry the base class. */
function identityRows(container: HTMLElement): readonly Element[] {
  return [...container.querySelectorAll(".meridian-browser-card--identity")];
}

describe("the produced-object shelf", () => {
  it("says nothing has been produced rather than rendering an empty region", () => {
    renderShelf([]);
    expect(screen.getByText("Nothing produced yet")).toBeTruthy();
  });

  it("mounts the capture card for an object this window took", () => {
    const container = renderShelf([artifactRow()], new Map([["artifact-a", CAPTURE_CARD]]));
    expect(screen.getByText("image/png")).toBeTruthy();
    // The identity row must NOT also render for a carded object.
    expect(identityRows(container)).toHaveLength(0);
  });

  it("mounts the download card for a downloaded object", () => {
    const container = renderShelf([artifactRow()], new Map([["artifact-a", DOWNLOAD_CARD]]));
    expect(screen.getByText("Docs")).toBeTruthy();
    // The name slot carries what the page proposed, never the id the shelf keyed the
    // card under — the two are separate members precisely so this row can show one and
    // be found by the other.
    expect(screen.getByText("quarterly-report.pdf")).toBeTruthy();
    expect(identityRows(container)).toHaveLength(0);
  });

  it("renders an identity row, not a card with invented fields, where no card backs it", () => {
    const container = renderShelf([artifactRow({ runId: "run-7", visibility: "session" })]);
    expect(identityRows(container)).toHaveLength(1);
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

// The state a card used to swallow.
//
// A local card won outright over the state-aware identity row, so an object this window
// captured and the log later superseded went on rendering as an ordinary capture: every
// other fact on the row was still true and the one that had changed was drawn nowhere.
// The state is joined on here rather than held in the register, so the richer row is no
// longer the one that knows less.
describe("the shelf keeps the log's state on the richer row", () => {
  it("says a captured object was superseded while still rendering its card", () => {
    const container = renderShelf(
      [artifactRow({ state: "superseded" })],
      new Map([["artifact-a", CAPTURE_CARD]]),
    );
    expect(screen.getByText("Superseded")).toBeTruthy();
    // Still the card, not a fall back to the identity row: the media type came from
    // the act that produced the object and is not lost to say what became of it.
    expect(screen.getByText("image/png")).toBeTruthy();
    expect(identityRows(container)).toHaveLength(0);
  });

  it("says the same about a downloaded object", () => {
    renderShelf([artifactRow({ state: "superseded" })], new Map([["artifact-a", DOWNLOAD_CARD]]));
    expect(screen.getByText("Superseded")).toBeTruthy();
    expect(screen.getByText("quarterly-report.pdf")).toBeTruthy();
  });

  it("negative control: a settled object is not labelled superseded", () => {
    // Without this, a card that hard-coded the word would pass the two cases above.
    renderShelf([artifactRow()], new Map([["artifact-a", CAPTURE_CARD]]));
    expect(screen.getByText("Stored")).toBeTruthy();
    expect(screen.queryByText("Superseded")).toBeNull();
  });
});
