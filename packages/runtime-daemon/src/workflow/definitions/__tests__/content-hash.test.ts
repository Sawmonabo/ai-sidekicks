// The content hash decides when a save is a new version, so a hash that moved with key order would
// mint versions for nothing, and one that drifted would orphan every stored hash.
import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/document";
import { describe, expect, it } from "vitest";

import { hashWorkflowDocument } from "../content-hash.js";
import { buildWorkflowDocument } from "./store.test-support.js";

describe("hashWorkflowDocument", () => {
  it("hashes the same body the same whatever its key order", () => {
    const document = buildWorkflowDocument("Nightly");
    // The same document with every object's keys written in reverse order.
    const reordered = JSON.parse(
      JSON.stringify(document, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as WorkflowDocument;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(document));

    expect(hashWorkflowDocument(reordered)).toEqual(hashWorkflowDocument(document));
  });

  it("stores a fixed document as fixed canonical text under a fixed hash", () => {
    // A change to either value means every stored version key stops matching its body.
    expect(hashWorkflowDocument(buildWorkflowDocument("Nightly"))).toEqual({
      canonicalBody:
        '{"edges":[{"id":"trigger-to-read","source":"trigger","sourceHandle":"outputs/main/0",' +
        '"target":"read","targetHandle":"inputs/main/0"}],"name":"Nightly","nodes":[{"id":"read",' +
        '"kind":"files.read","kindVersion":1,"name":"Read notes","order":0,' +
        '"params":{"path":"notes.md"}}],"trigger":{"id":"trigger","kind":"trigger.manual",' +
        '"kindVersion":1,"name":"Start","order":0,"params":{}}}',
      contentHash: "b3:09ce55947a4da688ad71e87f4303c39e7cc5e2a06eb3c49d1d4977b317f25e86",
    });
  });
});
