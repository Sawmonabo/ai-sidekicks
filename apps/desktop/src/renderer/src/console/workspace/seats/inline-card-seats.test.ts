// Three card kinds, one owner each, and the dispatch that cannot hand a body the
// wrong arm.
//
// The seat stores bodies erased — a table keyed by one union cannot hold three
// differently-typed renderers — and re-narrows them at the door. That erasure is
// the one place a mismatch could reach a body typed against another shape, so it
// is guarded at runtime rather than asserted, and the guard is driven here.

import { afterEach, describe, expect, it } from "vitest";

import { ConsoleRefusalError, DuplicateRegistrationError } from "../../core/index.js";
import {
  INLINE_CARD_KINDS,
  InlineCardSeatRegistry,
  inlineCardBody,
  inlineCardSeatRegistry,
  registerInlineCardBody,
  type ArtifactInlineCardProps,
  type AttachmentInlineCardProps,
  type DiffInlineCardProps,
} from "./inline-card-seats.js";

const DIFF_CARD: DiffInlineCardProps = {
  kind: "diff",
  runId: "run-7",
  changeSetId: "changeset-3",
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
    inlineCardSeatRegistry.unregister(kind);
  }
});

describe("inline card seats — the closed set", () => {
  it("declares three kinds, each exactly once, in declaration order", () => {
    expect([...INLINE_CARD_KINDS]).toStrictEqual(["diff", "attachment", "artifact"]);
    expect(new Set(INLINE_CARD_KINDS).size).toBe(INLINE_CARD_KINDS.length);
  });
});

describe("inline card seats — a body is only ever handed its own arm", () => {
  it("dispatches on the props' own discriminant", () => {
    const registry = new InlineCardSeatRegistry();
    registry.register("diff", { owner: "repos-family", render: (props) => props.changeSetId });
    registry.register("attachment", {
      owner: "repos-family",
      render: (props) => props.attachment.attachmentId,
    });
    registry.register("artifact", {
      owner: "repos-family",
      render: (props) => props.artifact.id,
    });
    expect(registry.render(DIFF_CARD)).toBe("changeset-3");
    expect(registry.render(ATTACHMENT_CARD)).toBe("attachment-1");
    expect(registry.render(ARTIFACT_CARD)).toBe("artifact-9");
  });

  it("refuses a body handed another kind's props rather than running it", () => {
    // The mismatch is only reachable through the descriptor door, which hands
    // back a renderer typed over the whole union. Without the guard, a diff body
    // would run against attachment props and read `changeSetId` off a shape that
    // has none — a silent `undefined` in the rendered card.
    const registry = new InlineCardSeatRegistry();
    registry.register("diff", { owner: "repos-family", render: (props) => props.changeSetId });
    const diffBody = registry.bodyFor("diff");
    expect(diffBody).toBeDefined();
    expect(() => diffBody?.render(ATTACHMENT_CARD)).toThrow(ConsoleRefusalError);
    expect(() => diffBody?.render(ATTACHMENT_CARD)).toThrow(/"diff"[\s\S]*"attachment"/u);
  });

  it("negative control: the matching arm does not throw", () => {
    // The case above would pass over a body that threw on every call, which is
    // the shape a mis-written guard degenerates into.
    const registry = new InlineCardSeatRegistry();
    registry.register("diff", { owner: "repos-family", render: (props) => props.changeSetId });
    expect(registry.bodyFor("diff")?.render(DIFF_CARD)).toBe("changeset-3");
  });
});

describe("inline card seats — one owner per card kind", () => {
  it("replaces when the same owner re-registers", () => {
    const registry = new InlineCardSeatRegistry();
    registry.register("artifact", { owner: "repos-family", render: () => "first" });
    registry.register("artifact", { owner: "repos-family", render: () => "second" });
    expect(registry.render(ARTIFACT_CARD)).toBe("second");
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new InlineCardSeatRegistry();
    registry.register("artifact", { owner: "repos-family", render: () => "repos" });
    expect(() => {
      registry.register("artifact", { owner: "workspace-family", render: () => "workspace" });
    }).toThrow(DuplicateRegistrationError);
    expect(registry.render(ARTIFACT_CARD)).toBe("repos");
  });

  it("reports registered kinds in declaration order", () => {
    const registry = new InlineCardSeatRegistry();
    // Registered back to front, so an implementation reporting insertion order
    // would answer differently.
    registry.register("artifact", { owner: "repos-family", render: () => null });
    registry.register("diff", { owner: "repos-family", render: () => null });
    expect(registry.registeredCardKinds()).toStrictEqual(["diff", "artifact"]);
  });

  it("negative control: a fresh registry holds no body and renders nothing", () => {
    const registry = new InlineCardSeatRegistry();
    expect(registry.registeredCardKinds()).toStrictEqual([]);
    // `undefined` rather than a placeholder: the "reserved, not stubbed" rule —
    // the row says the card has not been built rather than drawing an empty one.
    expect(registry.render(DIFF_CARD)).toBeUndefined();
  });
});

describe("inline card seats — the module-scope door", () => {
  it("claims a kind on the process-wide registry", () => {
    registerInlineCardBody("attachment", {
      owner: "inline-card-seats-test",
      render: (props) => props.attachment.attachmentId,
    });
    expect(inlineCardBody("attachment")?.owner).toBe("inline-card-seats-test");
    expect(inlineCardSeatRegistry.render(ATTACHMENT_CARD)).toBe("attachment-1");
  });

  it("negative control: the kind is absent once released", () => {
    // `afterEach` released it. Without this case, the one above would pass
    // against a registry that had been holding the body since an earlier file.
    expect(inlineCardBody("attachment")).toBeUndefined();
  });
});
