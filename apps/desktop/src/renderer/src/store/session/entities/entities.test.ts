// The entity vocabulary and the partition set built from it. The closed set is declared once as
// an array and the union derived from it, which makes half of a mismatch a compile error; the
// other half, `emptyPartitions` building a partition for every declared kind, is checked here.
// The kinds are checked only for the two workflow kinds being two; restating the whole list
// would fail on every legitimate addition.

import { describe, expect, it } from "vitest";

import { ENTITY_KINDS } from "@renderer/lib/entity-kinds.js";
import { emptyPartitions } from "./entities.js";

describe("the console entity vocabulary", () => {
  it("separates a workflow definition from a workflow run", () => {
    // With one kind the builder had to file a definition under `workflow-run`, where a run
    // transition and a definition edit invalidate each other's selectors.
    expect(ENTITY_KINDS).toContain("workflow-definition");
    expect(ENTITY_KINDS).toContain("workflow-run");
  });

  it("declares each kind exactly once, so no partition is built twice", () => {
    expect(new Set(ENTITY_KINDS).size).toBe(ENTITY_KINDS.length);
  });
});

describe("the partition set", () => {
  it("builds one partition per declared kind and none besides", () => {
    const partitions = emptyPartitions();

    expect(Object.keys(partitions).sort()).toStrictEqual([...ENTITY_KINDS].sort());
  });

  it("starts every partition empty", () => {
    const partitions = emptyPartitions();

    for (const kind of ENTITY_KINDS) {
      expect(Object.keys(partitions[kind]), kind).toStrictEqual([]);
    }
  });

  it("gives each kind its own map, so one kind's write is not another's", () => {
    // Negative control: a single shared empty object would pass the checks above (right keys,
    // all empty) yet appear under every kind on the first upsert.
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
