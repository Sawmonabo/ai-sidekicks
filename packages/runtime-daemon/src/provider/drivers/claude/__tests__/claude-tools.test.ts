/**
 * Plan-005 T3.9 — Claude tool metadata (I-005-3).
 *
 * These tests drive THIS module's closing helper, deliberately not the
 * contract's `ProviderToolMetadataSchema` default: the schema's
 * `.optional().default("manual_reconcile_only")` is a second, independent
 * application of the same rule at the write seam, and asserting on it would
 * prove the contract works while proving nothing about the driver.
 */

import { describe, expect, it } from "vitest";

import {
  ProviderToolMetadataSchema,
  type IdempotencyClass,
  type ProviderToolMetadata,
} from "@ai-sidekicks/contracts";

import {
  CLAUDE_TOOL_CATALOG,
  CLAUDE_TOOL_DECLARATIONS,
  DEFAULT_TOOL_IDEMPOTENCY_CLASS,
  closeToolIdempotencyClass,
  closeToolIdempotencyClasses,
} from "../tools.js";

const RECOGNIZED_CLASSES: readonly IdempotencyClass[] = [
  "idempotent",
  "compensable",
  "manual_reconcile_only",
];

describe("Claude tool metadata — the conservative default (I-005-3)", () => {
  it("fixes the default at manual_reconcile_only", () => {
    expect(DEFAULT_TOOL_IDEMPOTENCY_CLASS).toBe("manual_reconcile_only");
  });

  it("closes an unannotated declaration to the floor", () => {
    const closed = closeToolIdempotencyClass({ name: "SomeUnannotatedTool" });
    expect(closed).toStrictEqual({
      name: "SomeUnannotatedTool",
      idempotency_class: "manual_reconcile_only",
    });
  });

  it("closes an explicitly-undefined class to the floor", () => {
    const closed = closeToolIdempotencyClass({
      name: "SomeUnannotatedTool",
      idempotency_class: undefined,
    });
    expect(closed.idempotency_class).toBe("manual_reconcile_only");
  });

  it("floors an UNRECOGNIZED class rather than passing it through or throwing", () => {
    // The static type is erased at runtime; T3.13 routes MCP-discovered tools
    // through this helper, so an out-of-vocabulary value is reachable. A value
    // outside the vocabulary declares nothing, so it takes absence's treatment.
    const hostile = {
      name: "HostileTool",
      idempotency_class: "idempotent ",
    } as unknown as ProviderToolMetadata;
    expect(closeToolIdempotencyClass(hostile).idempotency_class).toBe("manual_reconcile_only");

    const nulled = {
      name: "NulledTool",
      idempotency_class: null,
    } as unknown as ProviderToolMetadata;
    expect(closeToolIdempotencyClass(nulled).idempotency_class).toBe("manual_reconcile_only");
  });

  it("preserves an explicitly-declared recognized class", () => {
    const closed = closeToolIdempotencyClass({ name: "Read", idempotency_class: "idempotent" });
    expect(closed.idempotency_class).toBe("idempotent");
  });

  it("never mutates the caller's declaration and never shares its reference", () => {
    const declaration: ProviderToolMetadata = { name: "Bash" };
    const closed = closeToolIdempotencyClass(declaration);
    expect(declaration.idempotency_class).toBeUndefined();
    expect(Object.is(closed, declaration)).toBe(false);
  });

  it("carries a description only when one was declared", () => {
    const withDescription = closeToolIdempotencyClass({
      name: "Described",
      description: "provider-supplied text",
    });
    expect(withDescription.description).toBe("provider-supplied text");

    const withoutDescription = closeToolIdempotencyClass({ name: "Undescribed" });
    expect(Object.hasOwn(withoutDescription, "description")).toBe(false);
  });

  it("closes a whole table, preserving order and length", () => {
    const closed = closeToolIdempotencyClasses([
      { name: "Alpha", idempotency_class: "idempotent" },
      { name: "Beta" },
    ]);
    expect(closed.map((tool) => tool.name)).toStrictEqual(["Alpha", "Beta"]);
    expect(closed.map((tool) => tool.idempotency_class)).toStrictEqual([
      "idempotent",
      "manual_reconcile_only",
    ]);
  });
});

describe("Claude tool catalog", () => {
  it("keeps the floor LOAD-BEARING on shipped declarations", () => {
    // Guards against a vacuous version of the test above: if every shipped
    // declaration were annotated, the default would be untested in production
    // data. At least one real Claude tool must rely on it, and every such
    // tool must appear floored in the catalog.
    const unannotated = CLAUDE_TOOL_DECLARATIONS.filter(
      (declaration) => declaration.idempotency_class === undefined,
    );
    expect(unannotated.length).toBeGreaterThan(0);
    for (const declaration of unannotated) {
      const entry = CLAUDE_TOOL_CATALOG.find((tool) => tool.name === declaration.name);
      expect(entry?.idempotency_class).toBe("manual_reconcile_only");
    }
  });

  it("classifies every entry with a recognized class", () => {
    expect(CLAUDE_TOOL_CATALOG.length).toBe(CLAUDE_TOOL_DECLARATIONS.length);
    for (const tool of CLAUDE_TOOL_CATALOG) {
      expect(RECOGNIZED_CLASSES).toContain(tool.idempotency_class);
    }
  });

  it("annotates exactly the pure local reads as idempotent", () => {
    // Spec-005 §Tool Metadata defines `idempotent` as a pure read. Adding a
    // name here is a decision to re-execute that tool during recovery.
    const idempotent = CLAUDE_TOOL_CATALOG.filter(
      (tool) => tool.idempotency_class === "idempotent",
    ).map((tool) => tool.name);
    expect(idempotent.slice().sort()).toStrictEqual(["Glob", "Grep", "Read"]);
  });

  it("declares no compensable tool (no Claude built-in honors a dedupe_key)", () => {
    expect(CLAUDE_TOOL_CATALOG.some((tool) => tool.idempotency_class === "compensable")).toBe(
      false,
    );
  });

  it("floors every effectful tool, including the plausible-but-unproven ones", () => {
    for (const name of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "TodoWrite", "Task"]) {
      const entry = CLAUDE_TOOL_CATALOG.find((tool) => tool.name === name);
      expect(entry, `${name} must be catalogued`).toBeDefined();
      expect(entry?.idempotency_class, `${name} must floor`).toBe("manual_reconcile_only");
    }
  });

  it("declares no duplicate tool names (the write seam rejects duplicates)", () => {
    const names = CLAUDE_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is accepted verbatim by the contract's tool-metadata schema", () => {
    // The write seam parses each entry; a name that violates the contract's
    // bounds would be rejected there, so it must be rejected here first.
    for (const tool of CLAUDE_TOOL_CATALOG) {
      const parsed = ProviderToolMetadataSchema.safeParse(tool);
      expect(parsed.success, `${tool.name} must parse`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.idempotency_class).toBe(tool.idempotency_class);
      }
    }
  });

  it("carries no daemon-invented descriptions", () => {
    for (const tool of CLAUDE_TOOL_CATALOG) {
      expect(Object.hasOwn(tool, "description")).toBe(false);
    }
  });
});
