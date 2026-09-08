// Definitions, keyed by the message that carried them.

import type { RootContent } from "mdast";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "./footnote-registry.js";

const BODY: readonly RootContent[] = [
  { type: "paragraph", children: [{ type: "text", value: "the note" }] },
];

describe("the footnote registry", () => {
  it("resolves a definition under the source that declared it", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    expect(registry.definitionsFor("event-01").get("1")?.bodyNodes).toBe(BODY);
  });

  it("keys on BOTH halves, so two messages may each define `1`", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    registry.register({ sourceId: "event-02", identifier: "1", bodyNodes: [] });
    expect(registry.definitionsFor("event-01").get("1")?.bodyNodes).toBe(BODY);
    expect(registry.definitionsFor("event-02").get("1")?.bodyNodes).toStrictEqual([]);
  });

  it("negative control: an identifier from another message does not resolve", () => {
    // Without this, a registry keyed on the identifier alone would pass every case above
    // and show one message's note under another message's marker.
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    expect(registry.definitionsFor("event-99").get("1")).toBeUndefined();
  });

  it("cannot be confused by a separator character in an identifier", () => {
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "a", identifier: "b:c", bodyNodes: BODY });
    expect(registry.definitionsFor("a:b").get("c")).toBeUndefined();
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

  it("hands back one snapshot identity until that source's definitions move", () => {
    // `useSyncExternalStore` compares snapshots by identity, so a view rebuilt per read
    // would report a change on every render — and one held past a change would report
    // none on the render that matters.
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    const first = registry.definitionsFor("event-01");

    expect(registry.definitionsFor("event-01")).toBe(first);

    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: [] });
    expect(registry.definitionsFor("event-01")).not.toBe(first);
  });

  it("negative control: an unchanged re-registration moves neither snapshot nor sink", () => {
    // Without this, a registry that announced every write would re-render every open
    // popover on every frame of every stream — the settled blocks re-register the same
    // node arrays constantly, and that is not a change to anything on screen.
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    const first = registry.definitionsFor("event-01");
    let changes = 0;
    registry.subscribeToSource("event-01", () => {
      changes += 1;
    });

    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });

    expect(registry.definitionsFor("event-01")).toBe(first);
    expect(changes).toBe(0);
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

  it("stops telling a source once its subscription is dropped", () => {
    const registry = new FootnoteRegistry();
    let changes = 0;
    const unsubscribe = registry.subscribeToSource("event-01", () => {
      changes += 1;
    });
    unsubscribe();

    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });

    expect(changes).toBe(0);
  });

  it("tells the source an eviction took a definition from", () => {
    // A popover open over an evicted note is showing something the registry no longer
    // holds, so eviction is a change to that source exactly as a rewrite is — and the
    // source it names comes off the evicted KEY, which is the only place it is written.
    const registry = new FootnoteRegistry();
    registry.register({ sourceId: "event-01", identifier: "1", bodyNodes: BODY });
    let evictedSourceChanges = 0;
    registry.subscribeToSource("event-01", () => {
      evictedSourceChanges += 1;
    });
    for (let index = 0; index < FOOTNOTE_DEFINITION_CAP; index += 1) {
      registry.register({ sourceId: "event-02", identifier: String(index), bodyNodes: BODY });
    }

    expect(registry.definitionsFor("event-01").get("1")).toBeUndefined();
    expect(evictedSourceChanges).toBe(1);
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
import { FOOTNOTE_DEFINITION_CAP } from "../../../core/index.js";
