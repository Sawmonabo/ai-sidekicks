// Plan-003 Phase 5 T5.2 — CapabilityDeclaration renderer component suite.
//
// BL-131 exit criterion (b), this view's share: bridge-only data access (no
// `node:*` / `electron` / daemon / control-plane imports) plus the view's two
// render states. Criterion (c) — the two-client attach E2E that replaces the
// T5.4 manual smoke — is out of scope here and stays open on Plan-023 Tier 8.
//
// Spec coverage:
//   • `Spec-003 §Required Behavior` (attach includes the node's DECLARED
//     capabilities): one row per declared capability, value formatted, never
//     dropped and never reordered — the view is a faithful projection of the
//     declared map, not an editorialized one.
//   • `Spec-003 §Default Behavior` (least privilege — only explicitly declared
//     capabilities are schedulable): the EMPTY map renders an explicit
//     "nothing declared / nothing schedulable" state rather than blank space.
//     An empty declared set is a meaningful fact, not a missing one.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the
//     bridge-projection source scan at the bottom of this file.
//
// The value-formatting matrix is load-bearing rather than incidental: the prop
// boundary admits arbitrary `unknown` at Tier 3 (the map is supplied by a
// parent, not read off the wire by this view), so the formatter must be TOTAL.
// The two pathological cases below drive the guarded terminal fallback — a
// value that cannot be stringified degrades to a literal, it never crashes the
// render and never takes the node's whole declaration down with it.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react`
// — see `ADR-022 §Decision Log` (2026-08-25).

import { render, screen } from "@testing-library/react";

import type { RuntimeNodeAttachRequest } from "@ai-sidekicks/contracts";

import { CapabilityDeclaration } from "../CapabilityDeclaration.js";

// CP-003-3 source-text read — Vite `import.meta.glob` raw form. See the
// MixedVersionStatus suite's header for the full rationale (`node:fs` is doubly
// banned in renderer programs, so the source text arrives inlined at transform
// time instead). The augmentation is scoped to this test program.
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const runtimeNodeViewSources = import.meta.glob("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

type DeclaredCapabilityMap = RuntimeNodeAttachRequest["capabilities"];

describe("CapabilityDeclaration (Plan-003 Phase 5 T5.2)", () => {
  describe("declared-set projection", () => {
    it("renders the explicit least-privilege state for an empty declaration", () => {
      render(<CapabilityDeclaration capabilities={{}} />);

      const emptySection = screen.getByLabelText("capability-declaration-empty");
      expect(emptySection.getAttribute("data-capability-count")).toBe("0");
      expect(
        screen.getByText("No capabilities declared — nothing on this node is schedulable."),
      ).toBeDefined();
      // The populated section is not rendered at all — an empty map is its own
      // state, not a zero-row table.
      expect(screen.queryByLabelText("capability-declaration")).toBeNull();
    });

    it("renders one row per declared capability with the declared count", () => {
      const declaredCapabilities: DeclaredCapabilityMap = {
        "shell.exec": true,
        "worktree.write": { maxConcurrency: 2 },
        "pty.spawn": "sidecar",
      };

      render(<CapabilityDeclaration capabilities={declaredCapabilities} />);

      const declarationSection = screen.getByLabelText("capability-declaration");
      expect(declarationSection.getAttribute("data-capability-count")).toBe("3");
      expect(declarationSection.querySelectorAll("li")).toHaveLength(3);
      for (const capabilityName of Object.keys(declaredCapabilities)) {
        expect(screen.getByText(`capability: ${capabilityName}`)).toBeDefined();
        expect(
          declarationSection.querySelector(`[data-capability="${capabilityName}"]`),
        ).not.toBeNull();
      }
    });

    it("preserves the declared map's own key order rather than sorting it", () => {
      // A faithful projection: the renderer does not editorialize the declared
      // set. A sorted render would put "alpha" first and fail here.
      const declaredCapabilities: DeclaredCapabilityMap = {
        "zulu.capability": true,
        "alpha.capability": true,
        "mike.capability": true,
      };

      render(<CapabilityDeclaration capabilities={declaredCapabilities} />);

      const renderedCapabilityNames = Array.from(
        screen.getByLabelText("capability-declaration").querySelectorAll("li"),
      ).map((capabilityRow) => capabilityRow.getAttribute("data-capability"));
      expect(renderedCapabilityNames).toEqual([
        "zulu.capability",
        "alpha.capability",
        "mike.capability",
      ]);
    });
  });

  describe("declared-value formatting (total over `unknown`)", () => {
    // `[caseLabel, declaredValue, renderedText]`. A plain string renders
    // verbatim (no JSON quoting noise); everything else rides `JSON.stringify`,
    // whose two non-string outcomes both route through the guarded fallback.
    const declaredValueCases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["a plain string, verbatim and unquoted", "sidecar", "sidecar"],
      ["a number", 4, "4"],
      ["a boolean", true, "true"],
      ["null", null, "null"],
      ["an object", { maxConcurrency: 2 }, '{"maxConcurrency":2}'],
      ["an array", ["read", "write"], '["read","write"]'],
      // `JSON.stringify(undefined)` RETURNS `undefined` (it does not throw), so
      // this drives the `?? lossyStringify(...)` arm, not the catch.
      ["undefined (stringify returns undefined)", undefined, "undefined"],
      // `JSON.stringify` THROWS on BigInt, so this drives the catch arm — and
      // `String(10n)` succeeds, so it stops at the ordinary string fallback.
      ["a BigInt (stringify throws, String succeeds)", BigInt(10), "10"],
    ];

    it.each(declaredValueCases)("renders %s", (_caseLabel, declaredValue, expectedRenderedText) => {
      render(<CapabilityDeclaration capabilities={{ "probe.capability": declaredValue }} />);

      expect(screen.getByText(`declared as: ${expectedRenderedText}`)).toBeDefined();
    });

    it("renders a circular value through the string fallback", () => {
      const circularDeclaredValue: Record<string, unknown> = {};
      circularDeclaredValue["self"] = circularDeclaredValue;

      render(
        <CapabilityDeclaration capabilities={{ "probe.capability": circularDeclaredValue }} />,
      );

      expect(screen.getByText("declared as: [object Object]")).toBeDefined();
    });

    it("degrades a null-prototype function to the lossy literal", () => {
      // `JSON.stringify` returns `undefined` for ANY function, and `String(...)`
      // on a null-prototype one THROWS (ToPrimitive finds no
      // `toString`/`valueOf`/`Symbol.toPrimitive`). This is the
      // stringify-returned-undefined → String-threw path.
      const nullPrototypeFunction = Object.setPrototypeOf(
        function declaredCapabilityProbe(): void {},
        null,
      ) as unknown;
      expect(JSON.stringify(nullPrototypeFunction)).toBeUndefined();
      expect(() => String(nullPrototypeFunction)).toThrow();

      render(
        <CapabilityDeclaration capabilities={{ "probe.capability": nullPrototypeFunction }} />,
      );

      expect(screen.getByText("declared as: [unrepresentable value]")).toBeDefined();
    });

    it("degrades a circular null-prototype object to the lossy literal", () => {
      // The other pathological path: `JSON.stringify` THROWS (circular) AND
      // `String(...)` throws (null prototype), so both guards fire in sequence.
      // A bare `Object.create(null)` would NOT reach here — `JSON.stringify`
      // renders it as `{}` — so the cycle is what makes this case real.
      const circularNullPrototypeValue = Object.create(null) as Record<string, unknown>;
      circularNullPrototypeValue["self"] = circularNullPrototypeValue;
      expect(() => JSON.stringify(circularNullPrototypeValue)).toThrow();
      expect(() => String(circularNullPrototypeValue)).toThrow();

      render(
        <CapabilityDeclaration capabilities={{ "probe.capability": circularNullPrototypeValue }} />,
      );

      expect(screen.getByText("declared as: [unrepresentable value]")).toBeDefined();
      // The capability is still NAMED — a pathological value loses its
      // rendering, never its row.
      expect(screen.getByText("capability: probe.capability")).toBeDefined();
    });
  });

  describe("bridge-projection (CP-003-3)", () => {
    // Spec-023 §Trust Stance + Plan-003 CP-003-3, and BL-131 exit criterion (b)
    // ("assert bridge-only data access (no `node:*`/`electron` imports)"). The
    // `@ai-sidekicks/runtime-daemon` / `@ai-sidekicks/control-plane` arm has no
    // lint rule today (deferred to the Plan-023 Tier 8 remainder), so for that
    // arm this tripwire is the sole operational enforcement.
    //
    // All three patterns anchor on the IMPORT SURFACE, never on bare words:
    // this source spells "no `electron`, no `node:*`" in PROSE, which a naive
    // substring match would false-positive.
    const bannedModuleSource =
      "(?:@ai-sidekicks/(?:runtime-daemon|control-plane)(?:/[^\"'`]*)?" +
      "|[^\"'`]*packages/(?:runtime-daemon|control-plane)/[^\"'`]*" +
      "|node:[^\"'`]+" +
      "|(?:fs|path|os|net|child_process|process)" +
      "|electron(?:/[^\"'`]*)?)";

    const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp, string]> = [
      [
        "bannedFromImport",
        new RegExp(`from\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import { readFile } from "node:fs/promises";',
      ],
      [
        "bannedSideEffectImport",
        new RegExp(`import\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import "@ai-sidekicks/control-plane";',
      ],
      [
        "bannedDynamicImport",
        new RegExp(`import\\s*\\(\\s*["'\`]${bannedModuleSource}["'\`]`),
        'const daemon = await import("@ai-sidekicks/runtime-daemon");',
      ],
    ];

    const capabilityDeclarationSource = runtimeNodeViewSources["../CapabilityDeclaration.tsx"];
    if (typeof capabilityDeclarationSource !== "string") {
      throw new Error("CapabilityDeclaration.tsx source was not loaded by import.meta.glob");
    }

    // Negative control: a tripwire that has never fired positive proves nothing.
    it.each(bannedDirectImportPatterns)(
      "%s matches a synthetic violating import (negative control)",
      (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
        expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
      },
    );

    it.each(bannedDirectImportPatterns)(
      "CapabilityDeclaration.tsx source matches no %s",
      (_bannedImportPatternName, bannedImportPattern) => {
        expect(bannedImportPattern.test(capabilityDeclarationSource)).toBe(false);
      },
    );
  });
});
