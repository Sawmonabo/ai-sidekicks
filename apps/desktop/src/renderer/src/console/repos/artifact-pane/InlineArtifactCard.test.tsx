// The artifact card, and the seat it fills.
//
// The registration is checked here rather than in `panes/panes.test.ts`, which is
// seat-blind: it asserts the seat board's shape and says nothing about occupants.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
  state: "published",
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("inline artifact card — the seat", () => {
  /** A board this case owns; the registrar writes only what it is handed. */
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

describe("inline artifact card — the identity, and the manifest", () => {
  it("draws no body at all without a manifest row", () => {
    const { container } = render(<InlineArtifactCard card={CARD} />);
    expect(container.querySelector(".meridian-artifact-card__body")).toBeNull();
  });

  it("names the artifact wire-verbatim, with the full string recoverable", () => {
    const { container } = render(<InlineArtifactCard card={CARD} />);
    const identity = container.querySelector(".meridian-artifact-card__id");
    expect(identity?.textContent).toBe("artifact-9");
    expect(identity?.getAttribute("title")).toBe("artifact-9");
  });

  it("draws the manifest face when a manifest row is supplied", () => {
    const { container } = render(<InlineArtifactCard card={CARD} manifest={MANIFEST} />);
    expect(container.querySelector(".meridian-artifact-card__body")).not.toBeNull();
    expect(container.querySelector(".meridian-artifact-card__face")).not.toBeNull();
  });
});
