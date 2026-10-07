// The diff card before its change set is read: it says so, and never that the diff is empty.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { InlineDiffCard } from "./InlineDiffCard.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

const CARD: DiffInlineCardProps = {
  kind: "diff",
  runId: "run-rate-limit-wiring",
  diffArtifactId: "diff-artifact-01",
  artifactManifestId: "artifact-manifest-01",
};

describe("inline diff card — the empty state", () => {
  it("says the diff has not been read, and never that there is nothing in it", () => {
    const { container } = render(<InlineDiffCard card={CARD} />, {
      wrapper: LiveAnnouncerProvider,
    });
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});
