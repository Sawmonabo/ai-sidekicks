// Dispatch that cannot hand a card body the wrong arm. Bodies are stored erased, so the runtime
// guard against a mismatched arm is driven here.

import { describe, expect, it } from "vitest";

import { RefusalError } from "@renderer/lib/refusal/refusal.js";
import {
  InlineCardRegistry,
  type ArtifactInlineCardProps,
  type AttachmentInlineCardProps,
  type DiffInlineCardProps,
} from "./inline-card-registry.js";

const DIFF_CARD: DiffInlineCardProps = {
  kind: "diff",
  runId: "run-7",
  // The diff result's own two identifiers; a body fetches with exactly these.
  diffArtifactId: "diff-artifact-3",
  artifactManifestId: "artifact-manifest-3",
};

const ATTACHMENT_CARD: AttachmentInlineCardProps = {
  kind: "attachment",
  attachment: { attachmentId: "attachment-1" },
};

const ARTIFACT_CARD: ArtifactInlineCardProps = {
  kind: "artifact",
  artifact: { kind: "artifact", id: "artifact-9" },
};

describe("inline card registry — a body is only ever handed its own arm", () => {
  it("dispatches on the props' own discriminant", () => {
    const registry = new InlineCardRegistry();
    registry.register("diff", {
      owner: "repos",
      render: (props) => props.diffArtifactId,
    });
    registry.register("attachment", {
      owner: "repos",
      render: (props) => props.attachment.attachmentId,
    });
    registry.register("artifact", {
      owner: "repos",
      render: (props) => props.artifact.id,
    });
    expect(registry.render(DIFF_CARD)).toBe("diff-artifact-3");
    expect(registry.render(ATTACHMENT_CARD)).toBe("attachment-1");
    expect(registry.render(ARTIFACT_CARD)).toBe("artifact-9");
  });

  it("refuses a body handed another kind's props rather than running it", () => {
    // Reachable only through `bodyFor`, which returns a renderer typed over the whole union;
    // without the guard a diff body would read `diffArtifactId` off attachment props.
    const registry = new InlineCardRegistry();
    registry.register("diff", {
      owner: "repos",
      render: (props) => props.diffArtifactId,
    });
    const diffBody = registry.bodyFor("diff");
    expect(diffBody).toBeDefined();
    expect(() => diffBody?.render(ATTACHMENT_CARD)).toThrow(RefusalError);
    expect(() => diffBody?.render(ATTACHMENT_CARD)).toThrow(/"diff"[\s\S]*"attachment"/u);
  });
});
