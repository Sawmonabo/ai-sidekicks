// The deferred edge into the schema form kit: one fetch per loader, the real surfaces at
// the end of it, and two mounts that share the one memo.
//
// The BUNDLING half of this seam's claim — that the kit and its stylesheet land in a lazy
// chunk rather than in the initial document — is not assertable from here; it is the
// initial-graph census's subject, read out of the build by the bundle tier. What is
// assertable here is the contract that makes the split safe to depend on: what a caller
// gets is the kit itself rather than a stand-in, and every caller joins one fetch.

import { describe, expect, it } from "vitest";

import { SchemaFormAnswer } from "./containers/SchemaFormAnswer.js";
import { SchemaFormPreview } from "./containers/SchemaFormPreview.js";
import { attachmentArtifactIdsIn } from "./answer/schema-artifact-members.js";
import {
  SchemaFormChunk,
  schemaFormAnswerMount,
  schemaFormChunk,
  schemaFormPreviewMount,
  type SchemaFormKit,
} from "./schema-form-mounts.js";

describe("the schema form chunk's loader", () => {
  it("resolves the real kit, not a stand-in for it", async () => {
    const kit: SchemaFormKit = await new SchemaFormChunk().load();
    // Identity, not shape: a wrapper that merely looked like these would let a surface
    // draw a form this directory does not own. The imports above name the DECLARING
    // modules while the loader goes through the chunk root, so this also holds that root
    // to re-exporting the declarations rather than wrapping them.
    expect(kit.SchemaFormAnswer).toBe(SchemaFormAnswer);
    expect(kit.SchemaFormPreview).toBe(SchemaFormPreview);
    expect(kit.attachmentArtifactIdsIn).toBe(attachmentArtifactIdsIn);
  });

  it("reports whether the chunk has been asked for", async () => {
    const loader = new SchemaFormChunk();
    expect(loader.isLoadStarted).toBe(false);
    await loader.load();
    expect(loader.isLoadStarted).toBe(true);
  });

  it("memoises: a run pane and a definition row mounting together share one fetch", () => {
    const loader = new SchemaFormChunk();
    // Promise identity is the observable. Two distinct promises would mean two entries
    // into the module, which is the race the memo exists to prevent.
    expect(loader.load()).toBe(loader.load());
  });

  it("negative control: two loaders do not share one memo", () => {
    // Without this the case above would pass against a module-level promise, which is
    // exactly the shared state the class form exists to avoid.
    expect(new SchemaFormChunk().load()).not.toBe(new SchemaFormChunk().load());
  });

  it("the page's loader is one instance, and it is a loader", () => {
    expect(schemaFormChunk).toBeInstanceOf(SchemaFormChunk);
  });
});

describe("the mounts the seats door publishes", () => {
  it("resolve their bodies out of the page's own memo", async () => {
    // One fetch behind both, which is the whole reason the mounts take a loader rather
    // than naming the specifier twice: a definition row and a waiting phase opening in
    // one frame must not start two entries into the kit.
    const answer = await schemaFormAnswerMount.load();
    const preview = await schemaFormPreviewMount.load();

    expect(answer.Body).toBe(SchemaFormAnswer);
    expect(preview.Body).toBe(SchemaFormPreview);
    expect(schemaFormChunk.isLoadStarted).toBe(true);
  });
});
