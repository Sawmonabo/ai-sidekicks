// The entity vocabulary and the partition set built from it.
//
// The module's own header names the failure this file exists to catch: the closed
// set is declared once as an array and the union is derived from it, so a kind that
// exists in one and not the other would leave `emptyPartitions` returning an object
// with a hole in it — and every read of that partition is `undefined` at a type that
// says it cannot be. The derivation makes half of that a compile error; the other
// half, the partition set actually being built for every declared kind, is a runtime
// fact and is checked here.
//
// The kinds themselves are checked for one thing only: that the two workflow kinds
// are two. Everything else about the enumeration is a design decision the module
// documents, and a test that restated the whole list would fail on every legitimate
// addition while catching nothing.

import { describe, expect, it } from "vitest";

import { CONSOLE_ENTITY_KINDS, emptyPartitions } from "./entities.js";

describe("the console entity vocabulary", () => {
  it("separates a workflow definition from a workflow run", () => {
    // The builder addresses a definition and the run pane a run. With one kind
    // between them the builder had to file a definition under `workflow-run`, where
    // a run transition and a definition edit invalidate each other's selectors and
    // nothing can tell the two apart by kind.
    expect(CONSOLE_ENTITY_KINDS).toContain("workflow-definition");
    expect(CONSOLE_ENTITY_KINDS).toContain("workflow-run");
  });

  it("declares each kind exactly once, so no partition is built twice", () => {
    expect(new Set(CONSOLE_ENTITY_KINDS).size).toBe(CONSOLE_ENTITY_KINDS.length);
  });
});

describe("the partition set", () => {
  it("builds one partition per declared kind and none besides", () => {
    const partitions = emptyPartitions();

    expect(Object.keys(partitions).sort()).toStrictEqual([...CONSOLE_ENTITY_KINDS].sort());
  });

  it("starts every partition empty", () => {
    const partitions = emptyPartitions();

    for (const kind of CONSOLE_ENTITY_KINDS) {
      expect(Object.keys(partitions[kind]), kind).toStrictEqual([]);
    }
  });

  it("gives each kind its own map, so one kind's write is not another's", () => {
    // Negative control for the two checks above, which a single shared empty object
    // reused across every key would pass: the key set would be right and every
    // partition would read empty, and the first upsert would appear under every
    // kind at once. Identity is the only thing that separates the two.
    const partitions = emptyPartitions();

    expect(partitions["workflow-definition"]).not.toBe(partitions["workflow-run"]);
    expect(partitions.session).not.toBe(partitions.run);
  });

  it("gives each call its own partitions, so two stores never share one", () => {
    expect(emptyPartitions()).not.toBe(emptyPartitions());
    expect(emptyPartitions()["workflow-definition"]).not.toBe(
      emptyPartitions()["workflow-definition"],
    );
  });
});
