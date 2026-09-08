// A phase's tool bindings in the file form, checked on the rule that is not a shape
// rule: a definition carries a REFERENCE to a configured server and never the governance
// posture that server runs under.
//
// The three arms are checked as three, because the identity is a discriminated union —
// `user` carries no scope reference at all and `local` exists only under `claude` — and
// a reader that took one flat shape would admit a binding the schema layer rejects.

import { describe, expect, it } from "vitest";

import { readToolBindings, toolBindingFileRecords } from "./workflow-definition-file-bindings.js";
import type { WorkflowToolBinding } from "./workflow-definition-body.js";

const PHASE_PROSE = "Phase 1";

/** The three arms, each as a definition would carry it. */
const EVERY_ARM: readonly WorkflowToolBinding[] = [
  { binding: { provider: "codex", scope: "user", serverName: "checks" }, toolName: "run_suite" },
  {
    binding: {
      provider: "codex",
      scope: "project",
      scopeRef: "/Users/release/checks",
      serverName: "release-tools",
    },
    toolName: "cut_release_notes",
  },
  {
    binding: {
      provider: "claude",
      scope: "local",
      scopeRef: "/Users/release/checks",
      serverName: "scratch",
    },
    toolName: "read_scratch",
  },
];

/** The bindings a document states, starting from what the writer produced. */
function writtenBindings(overrides: Record<string, unknown> = {}): readonly unknown[] {
  return toolBindingFileRecords(EVERY_ARM).map((record) => ({ ...record, ...overrides }));
}

/** One binding document, with the reference member replaced. */
function bindingDocumentWith(binding: unknown): readonly unknown[] {
  return [{ binding, toolName: "run_suite" }];
}

describe("tool bindings in the file form", () => {
  it("round-trips all three arms of the binding identity", () => {
    expect(readToolBindings(writtenBindings(), PHASE_PROSE)).toStrictEqual(EVERY_ARM);
  });

  it("refuses a binding carrying a governance facet, and says whose setting it is", () => {
    // The rule the refusal exists for: `enabled`, `approvalMode` and `idempotencyClass`
    // are node-operator surface, so a definition exported from one machine cannot import
    // a weakened posture onto another.
    for (const facet of ["enabled", "approvalMode", "idempotencyClass"]) {
      const reading = readToolBindings(
        bindingDocumentWith({
          provider: "claude",
          scope: "user",
          serverName: "checks",
          [facet]: facet === "enabled" ? true : "auto",
        }),
        PHASE_PROSE,
      );

      expect(reading).toContain(facet);
      expect(reading).toContain("node operator");
    }
  });

  it("refuses a local binding under the provider the union does not admit", () => {
    const reading = readToolBindings(
      bindingDocumentWith({
        provider: "codex",
        scope: "local",
        scopeRef: "/Users/release/checks",
        serverName: "scratch",
      }),
      PHASE_PROSE,
    );

    expect(reading).toContain("local");
    expect(reading).toContain("codex");
  });

  it("refuses a scope-qualified binding that names no scope", () => {
    expect(
      readToolBindings(
        bindingDocumentWith({ provider: "claude", scope: "project", serverName: "release-tools" }),
        PHASE_PROSE,
      ),
    ).toContain("scopeRef");
  });

  it("refuses a user-scoped binding that carries one, because that arm has no such member", () => {
    expect(
      readToolBindings(
        bindingDocumentWith({
          provider: "claude",
          scope: "user",
          scopeRef: "/Users/release/checks",
          serverName: "checks",
        }),
        PHASE_PROSE,
      ),
    ).toContain("scopeRef");
  });

  it("refuses a provider or a scope the vocabulary does not declare", () => {
    expect(
      readToolBindings(
        bindingDocumentWith({ provider: "gemini", scope: "user", serverName: "checks" }),
        PHASE_PROSE,
      ),
    ).toContain("provider");
    expect(
      readToolBindings(
        bindingDocumentWith({ provider: "claude", scope: "machine", serverName: "checks" }),
        PHASE_PROSE,
      ),
    ).toContain("scope");
  });

  it("refuses a binding that names no tool, and a list that is not a list", () => {
    expect(readToolBindings([{ binding: EVERY_ARM[0]?.binding }], PHASE_PROSE)).toContain(
      "toolName",
    );
    expect(typeof readToolBindings({ toolName: "run_suite" }, PHASE_PROSE)).toBe("string");
  });

  it("names the binding it refused, so two bindings differ by index", () => {
    const reading = readToolBindings(
      [
        ...toolBindingFileRecords(EVERY_ARM.slice(0, 1)),
        { binding: { provider: "gemini", scope: "user", serverName: "checks" }, toolName: "x" },
      ],
      PHASE_PROSE,
    );

    expect(reading).toContain("binding 2");
  });

  it("negative control: every perturbation above starts from bindings that read", () => {
    expect(typeof readToolBindings(writtenBindings(), PHASE_PROSE)).not.toBe("string");
  });
});
