// The artifact card, and its registration into the inline card registry.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArtifactManifestRow } from "../artifact-model.js";
import {
  InlineCardRegistry,
  inlineCardRegistry,
  type ArtifactInlineCardProps,
} from "@renderer/registries/inline-cards/inline-card-registry.js";
import { registerInspectorInlineCards } from "../../contributions/inline-cards.js";
import { InlineArtifactCard } from "./InlineArtifactCard.js";

const CARD: ArtifactInlineCardProps = {
  kind: "artifact",
  artifact: { kind: "artifact", id: "artifact-9" },
};

const MANIFEST: ArtifactManifestRow = {
  id: "artifact-9" as ArtifactId,
  sessionId: "session-1",
  artifactType: "summary",
  digest: "sha256:abc",
  size: 2048,
  annotations: {},
  state: "published",
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("inline artifact card — the registration", () => {
  /** A registry this case owns; the registrar writes only what it is handed. */
  function fill(): InlineCardRegistry {
    const registry = new InlineCardRegistry();
    registerInspectorInlineCards(registry);
    return registry;
  }

  it("fills the transcript's artifact card body", () => {
    const registry = fill();
    expect(registry.bodyFor("artifact")?.owner).toBe("inspector");
    expect(registry.registeredCardKinds()).toContain("artifact");
  });

  it("renders through the registry the transcript reaches it by", () => {
    const registry = fill();
    const { container } = render(<>{registry.render(CARD)}</>);
    expect(container.querySelector(".meridian-artifact-card")).not.toBeNull();
  });

  it("negative control: an empty registry answers nothing", () => {
    // Without this the cases above would pass over a registry that answered from elsewhere.
    expect(new InlineCardRegistry().bodyFor("artifact")).toBeUndefined();
  });

  it("writes the registry it is given and never the process-wide one", () => {
    // A body that reached the process-wide registry would render correctly above and still
    // leak into the running console.
    fill();
    expect(inlineCardRegistry.registeredCardKinds()).toStrictEqual([]);
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
