// The content hash decides when a save is a new version, so a hash that moved with key order,
// layout, pinned data or tags would mint versions for nothing, and one that drifted would orphan
// every stored hash.
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

  it("leaves the hash unchanged when the layout moves, items are pinned or tags change", () => {
    const document: WorkflowDocument = {
      ...buildWorkflowDocument("Nightly"),
      layout: { nodes: { trigger: { x: 0, y: 0 }, read: { x: 240, y: 0 } } },
      tags: ["ops"],
    };
    const edited: WorkflowDocument = {
      ...document,
      layout: {
        nodes: { trigger: { x: -80, y: 400 }, read: { x: 960, y: -12.5 } },
        viewport: { x: 10, y: 20, zoom: 1.5 },
        notes: [{ id: "note", text: "Runs at night", x: 0, y: 0, width: 200, height: 80 }],
      },
      pinData: { read: [{ json: { text: "pinned" } }] },
      tags: ["ops/nightly", "billing"],
    };

    expect(hashWorkflowDocument(edited)).toEqual(hashWorkflowDocument(document));
  });

  it("hashes a fixed document to a fixed value", () => {
    // A change to this value means every stored version key stops matching its body.
    expect(hashWorkflowDocument(buildWorkflowDocument("Nightly")).contentHash).toBe(
      "b3:09ce55947a4da688ad71e87f4303c39e7cc5e2a06eb3c49d1d4977b317f25e86",
    );
  });
});
