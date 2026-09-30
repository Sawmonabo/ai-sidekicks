// The deferred edge into the schema form: one fetch per loader, the real components at the end
// of it, and two mounts that share the one memo. That the kit lands in a lazy chunk is not
// assertable here.

import { describe, expect, it } from "vitest";

import { SchemaFormAnswer } from "./components/SchemaFormAnswer.js";
import { SchemaFormPreview } from "./components/SchemaFormPreview.js";
import {
  SchemaFormChunk,
  schemaFormAnswerBody,
  schemaFormChunk,
  schemaFormPreviewBody,
  type SchemaFormModule,
} from "./schema-form-mounts.js";

describe("the schema form chunk's loader", () => {
  it("resolves the real kit, not a stand-in for it", async () => {
    const kit: SchemaFormModule = await new SchemaFormChunk().load();
    // Identity, not shape: the imports name the declaring modules while the loader goes through
    // the chunk root, so this also holds that root to re-exporting rather than wrapping.
    expect(kit.SchemaFormAnswer).toBe(SchemaFormAnswer);
    expect(kit.SchemaFormPreview).toBe(SchemaFormPreview);
  });

  it("reports whether the chunk has been asked for", async () => {
    const loader = new SchemaFormChunk();
    expect(loader.isLoadStarted).toBe(false);
    await loader.load();
    expect(loader.isLoadStarted).toBe(true);
  });

  it("memoizes: a run pane and a definition row mounting together share one fetch", () => {
    const loader = new SchemaFormChunk();
    // Promise identity is the observable: two promises would be two entries into the module.
    expect(loader.load()).toBe(loader.load());
  });

  it("negative control: two loaders do not share one memo", () => {
    // Without this, the case above would pass against a module-level promise.
    expect(new SchemaFormChunk().load()).not.toBe(new SchemaFormChunk().load());
  });

  it("the page's loader is one instance, and it is a loader", () => {
    expect(schemaFormChunk).toBeInstanceOf(SchemaFormChunk);
  });
});

describe("the answer and preview mounts", () => {
  it("resolve their bodies out of the page's own memo", async () => {
    // A definition row and a waiting phase opening in one frame must not start two entries.
    const answer = await schemaFormAnswerBody.load();
    const preview = await schemaFormPreviewBody.load();

    expect(answer.Body).toBe(SchemaFormAnswer);
    expect(preview.Body).toBe(SchemaFormPreview);
    expect(schemaFormChunk.isLoadStarted).toBe(true);
  });
});
