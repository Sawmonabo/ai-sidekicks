// What a phase row says about a tool binding. `McpServerBindingRef` is a three-arm union because
// the scope reference is part of the binding's identity: two `project` bindings under different
// roots are different servers. Cases drive the real component over a hand-built phase, since a
// body with one binding per arm never has two that collide.

import type { McpServerBindingRef } from "@ai-sidekicks/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { WorkflowPhaseDefinition } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { schemaFormPreviewBody } from "../../../schema-form/schema-form-mounts.js";
import { DefinitionPhaseRow } from "./DefinitionPhaseRow.js";

afterEach(cleanup);

/** Two repository roots, the whole difference between the colliding rows. */
const ATLAS_ROOT = "/Users/operator/work/atlas";
const BEACON_ROOT = "/Users/operator/work/beacon";

/** The tool name every binding below references, so only the binding varies. */
const TOOL_NAME = "run_release_suite";

/** One phase carrying the given bindings and nothing else worth asserting on. */
function phaseBinding(bindings: readonly McpServerBindingRef[]): WorkflowPhaseDefinition {
  return {
    phaseId: "019b7a10-0280-7d22-8100-be5100150101",
    name: "Run the release checks",
    type: "automated",
    gateType: "quality-checks",
    failureBehavior: "retry",
    toolBindings: bindings.map((binding) => ({ binding, toolName: TOOL_NAME })),
  };
}

/** The phase row, mounted in a list so the `li` it renders sits where it belongs. */
function renderPhase(bindings: readonly McpServerBindingRef[]): HTMLElement {
  const { container } = render(
    <ul>
      <DefinitionPhaseRow phase={phaseBinding(bindings)} />
    </ul>,
  );
  return container;
}

/** Each binding row's text, in the order the definition states them. */
function bindingRows(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".meridian-definition-detail__bindings li")];
}

/** How many wire figures one binding row draws. The reference is the second. */
function figureCount(row: HTMLElement): number {
  return row.querySelectorAll(".meridian-figure").length;
}

// Resolved once so every case renders the loaded preview, not its reserved region.
beforeAll(async () => {
  await schemaFormPreviewBody.load();
});

describe("a phase's tool bindings — the scope and what it refers to", () => {
  it("tells apart two bindings differing only in their scope reference", () => {
    const container = renderPhase([
      { provider: "codex", scope: "project", scopeRef: ATLAS_ROOT, serverName: "release" },
      { provider: "codex", scope: "project", scopeRef: BEACON_ROOT, serverName: "release" },
    ]);

    const rows = bindingRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent ?? "").toContain(ATLAS_ROOT);
    expect(rows[1]?.textContent ?? "").toContain(BEACON_ROOT);
    // Equal in provider, server and tool, the two rows must not read the same.
    expect(rows[0]?.textContent).not.toBe(rows[1]?.textContent);
  });

  it("draws the reference on the `local` arm too, which carries one", () => {
    const container = renderPhase([
      { provider: "claude", scope: "local", scopeRef: ATLAS_ROOT, serverName: "incident-log" },
    ]);

    const row = bindingRows(container)[0];
    expect(row).toBeDefined();
    expect(row?.textContent ?? "").toContain(ATLAS_ROOT);
    expect(row === undefined ? 0 : figureCount(row)).toBe(2);
  });

  it("draws no reference for the `user` arm, which carries none", () => {
    // A row that printed a reference unconditionally would put an empty figure where a path
    // belongs.
    const container = renderPhase([{ provider: "claude", scope: "user", serverName: "notes" }]);

    const row = bindingRows(container)[0];
    expect(row).toBeDefined();
    expect(row?.textContent ?? "").toContain("user");
    // One figure, the server-and-tool pair, with nothing standing in for a reference.
    expect(row === undefined ? 0 : figureCount(row)).toBe(1);
  });
});
