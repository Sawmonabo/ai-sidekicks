// Definitions, keyed by the message that carried them.

import type { RootContent } from "mdast";
import { describe, expect, it } from "vitest";

import { FOOTNOTE_DEFINITION_CAP } from "../card-bounds.js";
import { FootnoteRegistry } from "./footnote-registry.js";

const BODY: readonly RootContent[] = [
  { type: "paragraph", children: [{ type: "text", value: "the note" }] },
];

describe("the footnote registry", () => {
  it("resolves a definition under the source that declared it", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    expect(registry.resolve("event-01", "1")?.bodyNodes).toBe(BODY);
  });

  it("keys on BOTH halves, so two messages may each define `1`", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-02", identifier: "1", bodyNodes: [] });
    expect(registry.resolve("event-01", "1")?.bodyNodes).toBe(BODY);
    expect(registry.resolve("event-02", "1")?.bodyNodes).toStrictEqual([]);
  });

  it("negative control: an identifier from another message does not resolve", () => {
    // Without this, a registry keyed on the identifier alone would pass every case above
    // and show one message's note under another message's marker.
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    expect(registry.resolve("event-99", "1")).toBeUndefined();
  });

  it("cannot be confused by a separator character in an identifier", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "a", identifier: "b:c", bodyNodes: BODY });
    expect(registry.resolve("a:b", "c")).toBeUndefined();
  });

  it("forgets everything one source declared when its row leaves the window", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-01", identifier: "2", bodyNodes: BODY });
    registry.register({ sourceId: "event-02", identifier: "1", bodyNodes: BODY });
    registry.forgetSource("event-01");
    expect(registry.resolve("event-01", "1")).toBeUndefined();
    expect(registry.resolve("event-01", "2")).toBeUndefined();
    expect(registry.resolve("event-02", "1")).not.toBeUndefined();
  });

  it("re-registering one identifier replaces rather than accumulates", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: [] });
    expect(registry.definitionCount).toBe(1);
    expect(registry.resolve("event-01", "1")?.bodyNodes).toStrictEqual([]);
  });

  it("holds a bounded number of definitions and drops the oldest first", () => {
    const registry = new FootnoteRegistry();
    for (let index = 0; index < FOOTNOTE_DEFINITION_CAP + 5; index += 1) {
      registry.register({ sourceId: "event-01", identifier: String(index), bodyNodes: BODY });
    }
    expect(registry.definitionCount).toBe(FOOTNOTE_DEFINITION_CAP);
    expect(registry.resolve("event-01", "0")).toBeUndefined();
    expect(registry.resolve("event-01", String(FOOTNOTE_DEFINITION_CAP + 4))).not.toBeUndefined();
  });
});
