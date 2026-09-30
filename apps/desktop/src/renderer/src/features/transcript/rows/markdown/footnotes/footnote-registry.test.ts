import type { RootContent } from "mdast";
import { describe, expect, it } from "vitest";

import { FOOTNOTE_DEFINITION_CAP } from "../../../cards/card-caps.js";
import { FootnoteRegistry } from "./footnote-registry.js";

const BODY: readonly RootContent[] = [
  { type: "paragraph", children: [{ type: "text", value: "the note" }] },
];

describe("the footnote registry", () => {
  it("keys on BOTH halves, so two messages may each define `1`", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-02", identifier: "1", bodyNodes: [] });
    expect(registry.definitionsFor("event-01").get("1")?.bodyNodes).toBe(BODY);
    expect(registry.definitionsFor("event-02").get("1")?.bodyNodes).toStrictEqual([]);
  });

  it("forgets everything one source declared when its row leaves the window", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-01", identifier: "2", bodyNodes: BODY });
    registry.register({ sourceId: "event-02", identifier: "1", bodyNodes: BODY });
    registry.forgetSource("event-01");
    expect(registry.definitionsFor("event-01").get("1")).toBeUndefined();
    expect(registry.definitionsFor("event-01").get("2")).toBeUndefined();
    expect(registry.definitionsFor("event-02").get("1")).not.toBeUndefined();
  });

  it("re-registering one identifier replaces rather than accumulates", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: [] });
    expect(registry.definitionCount).toBe(1);
    expect(registry.definitionsFor("event-01").get("1")?.bodyNodes).toStrictEqual([]);
  });

  it("tells the source whose definition moved, and only that source", () => {
    const registry = new FootnoteRegistry();
    const changed: string[] = [];
    registry.subscribeToSource("event-01", () => {
      changed.push("event-01");
    });
    registry.subscribeToSource("event-02", () => {
      changed.push("event-02");
    });

    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-02", identifier: "1", bodyNodes: [] });
    registry.forgetSource("event-01");

    expect(changed).toStrictEqual(["event-01", "event-02", "event-01"]);
  });

  it("holds a bounded number of definitions and drops the oldest first", () => {
    const registry = new FootnoteRegistry();
    for (let index = 0; index < FOOTNOTE_DEFINITION_CAP + 5; index += 1) {
      registry.register({ sourceId: "event-01", identifier: String(index), bodyNodes: BODY });
    }
    expect(registry.definitionCount).toBe(FOOTNOTE_DEFINITION_CAP);
    expect(registry.definitionsFor("event-01").get("0")).toBeUndefined();
    expect(
      registry.definitionsFor("event-01").get(String(FOOTNOTE_DEFINITION_CAP + 4)),
    ).not.toBeUndefined();
  });
});
