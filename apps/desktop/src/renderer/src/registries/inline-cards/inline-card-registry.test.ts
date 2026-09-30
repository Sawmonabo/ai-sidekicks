// Three card kinds, one owner each, and dispatch that cannot hand a body the wrong arm. Bodies
// are stored erased, so the runtime guard against a mismatched arm is driven here.

import { afterEach, describe, expect, it } from "vitest";

import { RefusalError } from "@renderer/lib/refusal.js";
import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  INLINE_CARD_KINDS,
  InlineCardRegistry,
  inlineCardBody,
  inlineCardRegistry,
  type ArtifactEntityRef,
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

afterEach(() => {
  for (const kind of INLINE_CARD_KINDS) {
    inlineCardRegistry.unregister(kind);
  }
});

describe("inline card registry — the closed set", () => {
  it("declares three kinds, each exactly once, in declaration order", () => {
    expect([...INLINE_CARD_KINDS]).toStrictEqual(["diff", "attachment", "artifact"]);
    expect(new Set(INLINE_CARD_KINDS).size).toBe(INLINE_CARD_KINDS.length);
  });
});

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

  it("negative control: the matching arm does not throw", () => {
    // A guard that threw on every call would pass the case above.
    const registry = new InlineCardRegistry();
    registry.register("diff", {
      owner: "repos",
      render: (props) => props.diffArtifactId,
    });
    expect(registry.bodyFor("diff")?.render(DIFF_CARD)).toBe("diff-artifact-3");
  });
});

describe("inline card registry — one owner per card kind", () => {
  it("replaces when the same owner re-registers", () => {
    const registry = new InlineCardRegistry();
    registry.register("artifact", { owner: "repos", render: () => "first" });
    registry.register("artifact", { owner: "repos", render: () => "second" });
    expect(registry.render(ARTIFACT_CARD)).toBe("second");
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new InlineCardRegistry();
    registry.register("artifact", { owner: "repos", render: () => "repos" });
    expect(() => {
      registry.register("artifact", { owner: "transcript", render: () => "transcript" });
    }).toThrow(DuplicateRegistrationError);
    expect(registry.render(ARTIFACT_CARD)).toBe("repos");
  });

  it("reports registered kinds in declaration order", () => {
    const registry = new InlineCardRegistry();
    // Registered back to front, so insertion order would answer differently.
    registry.register("artifact", { owner: "repos", render: () => null });
    registry.register("diff", { owner: "repos", render: () => null });
    expect(registry.registeredCardKinds()).toStrictEqual(["diff", "artifact"]);
  });

  it("negative control: a fresh registry holds no body and renders nothing", () => {
    const registry = new InlineCardRegistry();
    expect(registry.registeredCardKinds()).toStrictEqual([]);
    // `undefined`, not a placeholder card.
    expect(registry.render(DIFF_CARD)).toBeUndefined();
  });
});

describe("inline card registry — a diff card carries the registered diff identity", () => {
  it("hands a body both identifiers the registered diff result names", () => {
    // Two rows, two ids: a card carrying only one could fetch half of what it draws.
    const registry = new InlineCardRegistry();
    registry.register("diff", {
      owner: "repos",
      render: (props) => `${props.diffArtifactId}/${props.artifactManifestId}`,
    });

    expect(registry.render(DIFF_CARD)).toBe("diff-artifact-3/artifact-manifest-3");
  });

  it("negative control: the retired identifier is not a member of the arm", () => {
    // `changeSetId` names no wire identity; asserted as a compile error so its return breaks the
    // build.
    // @ts-expect-error `changeSetId` names no registered diff identity
    const retired = DIFF_CARD.changeSetId;

    expect(retired).toBeUndefined();
  });
});

describe("inline card registry — an artifact card names an artifact", () => {
  it("accepts a reference from the artifact partition", () => {
    // The positive half: the refusal below is a narrowing, not a type nothing satisfies.
    const artifact: ArtifactEntityRef = { kind: "artifact", id: "artifact-9" };
    const props: ArtifactInlineCardProps = { kind: "artifact", artifact };

    expect(props.artifact.kind).toBe("artifact");
  });

  it("negative control: a reference from another partition does not compile", () => {
    // A `run` reference would render as permanently missing, like an unanswered fetch. The type
    // is the guard, so this is a compile-time assertion; the directive fails the build if the
    // reference ever becomes legal.
    const wrongPartition: ArtifactInlineCardProps = {
      kind: "artifact",
      // @ts-expect-error a `run` reference is not an artifact reference
      artifact: { kind: "run", id: "run-7" },
    };

    // Read at runtime too, so the case is not purely a compiler directive.
    expect(wrongPartition.artifact.id).toBe("run-7");
  });
});

describe("inline card registry — the module-scope registry", () => {
  it("claims a kind on the process-wide registry", () => {
    inlineCardRegistry.register("attachment", {
      owner: "inline-card-registration-test",
      render: (props) => props.attachment.attachmentId,
    });
    expect(inlineCardBody("attachment")?.owner).toBe("inline-card-registration-test");
    expect(inlineCardRegistry.render(ATTACHMENT_CARD)).toBe("attachment-1");
  });

  it("negative control: the kind is absent once released", () => {
    // `afterEach` released it; otherwise the case above could pass on a body left by an earlier
    // file.
    expect(inlineCardBody("attachment")).toBeUndefined();
  });
});
