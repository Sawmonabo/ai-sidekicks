// Tool bindings in the file form, checked on the rule that is not a shape rule: a definition
// carries a reference to a configured server and never the policy it runs under, and a member
// its arm has no place for is refused rather than dropped. The three arms are checked as
// three, since the identity is a union on scope.

import { describe, expect, it } from "vitest";

import type { WorkflowToolBinding } from "@ai-sidekicks/contracts/workflow-definition";

import { readToolBindings, toolBindingFileRecords } from "./workflow-definition-file-bindings.js";

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

function bindingDocumentWith(binding: unknown): readonly unknown[] {
  return [{ binding, toolName: "run_suite" }];
}

describe("tool bindings in the file form", () => {
  it("round-trips all three arms of the binding identity", () => {
    expect(readToolBindings(writtenBindings(), PHASE_PROSE)).toStrictEqual(EVERY_ARM);
  });

  it("refuses a binding carrying a policy member, naming the field", () => {
    // A tool's approval lives in the MCP server settings; a definition never carries it.
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
    }
  });

  it("refuses a `scopeRef` on a user-scoped binding, which that arm has no member for", () => {
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
});
