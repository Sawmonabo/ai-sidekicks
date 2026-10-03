// What the untyped boundary does with the pane-address rows, and which name each refusal carries.
// The sweep at the bottom drives every pane kind against every scoped entity kind, so a parse that
// admits everything fails on the cross-product and not on one hand-picked pair.

import { describe, expect, it } from "vitest";

import { IDENTIFIER_MAX_LENGTH } from "@renderer/lib/identifier-grammar.js";
import { isRefusal } from "@renderer/lib/refusal.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { paneEntityScopeFor } from "./pane-address.js";
import { parsePaneAddress } from "./parse-pane-address.js";
import { PANE_KINDS } from "./pane-kinds.js";

/** Every entity kind any pane kind admits, read off the real table. */
const SCOPED_ENTITY_KINDS: readonly EntityRef["kind"][] = [
  ...new Set(PANE_KINDS.flatMap((kind) => paneEntityScopeFor(kind).entityKinds)),
];

/** The refusal a parse answered with, or a failure naming what it admitted instead. */
function refusalFrom(outcome: ReturnType<typeof parsePaneAddress>): {
  readonly code: string;
  readonly detail: string;
  readonly origin: string;
} {
  if (!isRefusal(outcome)) {
    throw new Error(`the parse admitted a "${outcome.kind}" address it should have refused`);
  }
  return outcome;
}

describe("the boundary parse — what it refuses, and by which name", () => {
  it("drops a pane kind this build does not render", () => {
    const refusal = refusalFrom(parsePaneAddress("gallery", undefined));

    expect(refusal.code).toBe("pane-kind-unknown");
    expect(refusal.origin).toBe("pane-address");
    expect(refusal.detail).toContain(String(PANE_KINDS.length));
  });

  it("rejects a value that is not an entity reference at all", () => {
    // What a snapshot written by another build can hand back: a bare identifier where a
    // reference belongs, and an empty id, which names no row.
    for (const malformed of [
      "workflow-run-1",
      { kind: "workflow-run" },
      { kind: "workflow-run", id: "" },
    ]) {
      expect(refusalFrom(parsePaneAddress("workflow-run", malformed)).code).toBe(
        "pane-entity-malformed",
      );
    }
  });

  it.each([
    ["a space", "run 1"],
    ["a tab", "run\t1"],
    ["a newline", "run\n1"],
    ["a NUL", "run\u00001"],
    ["a path", "../../etc/passwd"],
    ["a bare path separator", "runs/run-1"],
    ["prose", "the run Priya started this morning"],
    ["a quote", 'run-"1"'],
    ["an over-length string", `run-${"9".repeat(IDENTIFIER_MAX_LENGTH)}`],
  ])("rejects an id carrying %s", (_class, id) => {
    // The layout snapshot is written through the persistence value walk, which refuses each
    // of these; the route boundary must refuse the same strings.
    const refusal = refusalFrom(parsePaneAddress("workflow-run", { kind: "workflow-run", id }));

    expect(refusal.code).toBe("pane-entity-malformed");
    expect(refusal.origin).toBe("pane-address");
    // The refused string is never echoed, but the ceiling is named.
    expect(refusal.detail).not.toContain(id);
    expect(refusal.detail).toContain(String(IDENTIFIER_MAX_LENGTH));
  });
});

describe("every pane kind against every scoped entity kind", () => {
  it("admits a pairing exactly when the kind's own row names it", () => {
    // A parse that admitted every pairing fails on the first row narrower than everything.
    for (const paneKind of PANE_KINDS) {
      const scope = paneEntityScopeFor(paneKind);
      for (const entityKind of SCOPED_ENTITY_KINDS) {
        const outcome = parsePaneAddress(paneKind, { kind: entityKind, id: "entity-1" });
        expect(
          isRefusal(outcome),
          `"${paneKind}" answered the wrong way for a "${entityKind}"`,
        ).toBe(!scope.entityKinds.includes(entityKind));
      }
    }
  });

  it("admits an absent entity exactly where the kind's own row calls it optional", () => {
    for (const paneKind of PANE_KINDS) {
      const outcome = parsePaneAddress(paneKind, undefined);
      expect(isRefusal(outcome), `"${paneKind}" answered the wrong way for no entity`).toBe(
        paneEntityScopeFor(paneKind).entityRequired,
      );
    }
  });
});
