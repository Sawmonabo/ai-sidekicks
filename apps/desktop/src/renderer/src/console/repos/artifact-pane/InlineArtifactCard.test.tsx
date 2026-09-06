// The artifact card, and the seat it fills.
//
// The registration is checked here rather than in `panes/panes.test.ts`, which is
// seat-blind by design: it asserts the seat board's SHAPE and says nothing about
// occupants. Which body fills the `artifact` card is this family's claim, so this
// family's test is where it belongs.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactManifestRow } from "../artifacts/artifact-model.js";
import {
  InlineCardSeatRegistry,
  inlineCardSeatRegistry,
  type ArtifactInlineCardProps,
} from "../../seats/index.js";
import { InlineArtifactCard, registerInlineArtifactCardBody } from "./InlineArtifactCard.js";

const CARD: ArtifactInlineCardProps = {
  kind: "artifact",
  artifact: { kind: "artifact", id: "artifact-9" },
};

const MANIFEST: ArtifactManifestRow = {
  id: "artifact-9",
  sessionId: "session-1",
  artifactType: "summary",
  digest: "sha256:abc",
  size: 2048,
  annotations: {},
  visibility: "shared",
  state: "published",
  replicationStatus: "expired",
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
};

afterEach(() => {});

describe("inline artifact card — the seat", () => {
  /**
   * A board this case owns.
   *
   * The registrar writes only what it is handed, so there is nothing to release
   * afterwards — the previous shape claimed the process-wide board and needed an
   * `afterEach` unregistering the kind by hand, where a case that forgot made the
   * next one pass for its neighbour's reason.
   */
  function fill(): InlineCardSeatRegistry {
    const seats = new InlineCardSeatRegistry();
    registerInlineArtifactCardBody(seats);
    return seats;
  }

  it("fills the ledger's artifact card body", () => {
    const seats = fill();
    expect(seats.bodyFor("artifact")?.owner).toBe("repos");
    expect(seats.registeredCardKinds()).toContain("artifact");
  });

  it("renders through the registry the ledger reaches it by", () => {
    const seats = fill();
    const { container } = render(<>{seats.render(CARD)}</>);
    expect(container.querySelector(".meridian-artifact-card")).not.toBeNull();
  });

  it("negative control: an unfilled board answers nothing", () => {
    // Without this, the two cases above would pass over a board that answered from
    // somewhere else entirely, and the registration call would be doing nothing.
    expect(new InlineCardSeatRegistry().bodyFor("artifact")).toBeUndefined();
  });

  it("writes the board it is given and never the process-wide one", () => {
    // The registrar closes over no singleton. A body that reached one would render
    // correctly in every case above and still leak into the running console.
    fill();
    expect(inlineCardSeatRegistry.registeredCardKinds()).toStrictEqual([]);
  });
});

describe("inline artifact card — the absence, and the manifest", () => {
  it("says the artifact has not been read, and never that there is none", () => {
    const { container } = render(<InlineArtifactCard card={CARD} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("names the artifact wire-verbatim, with the full string recoverable", () => {
    const { container } = render(<InlineArtifactCard card={CARD} />);
    const identity = container.querySelector(".meridian-artifact-card__id");
    expect(identity?.textContent).toBe("artifact-9");
    expect(identity?.getAttribute("title")).toBe("artifact-9");
  });

  it("renders the expired replication reading as the payload sentence, not as a TTL", () => {
    // `repos/artifacts/artifact-copy.ts` reads `expired` as the payload not being obtainable
    // from the relay with re-publish as the remedy — the disposition `Spec-014` gives a
    // reclaimed blob — never the narrower "TTL elapsed", which
    // describes the cause and hides the way out.
    const { container } = render(<InlineArtifactCard card={CARD} manifest={MANIFEST} />);
    expect(container.textContent).toContain("Payload not obtainable from the relay.");
    expect(container.textContent).not.toContain("TTL");
  });

  it("negative control: a manifest row displaces the unread absence", () => {
    const { container } = render(<InlineArtifactCard card={CARD} manifest={MANIFEST} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});
