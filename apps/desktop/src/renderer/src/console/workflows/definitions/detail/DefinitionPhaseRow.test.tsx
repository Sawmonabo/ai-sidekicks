// What a phase row says about a tool binding, and the member without which two
// separately configured servers read as one.
//
// THE SUBJECT IS THE BINDING'S IDENTITY. `McpServerBindingRef` is a three-arm union
// because the scope reference is part of what a binding IS: two `project` bindings
// under different repository roots name two different configured servers, so a row
// drawing only the provider, the names and the broad scope word leaves an operator
// unable to say which one the phase will invoke. Each case below drives the real
// component over a hand-built phase — the fixture's own bodies carry one binding per
// scope arm and never two that collide, which is exactly the case this pins.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { McpServerBindingRef, WorkflowPhaseDefinition } from "../../../bridge/index.js";
import { DefinitionPhaseRow } from "./DefinitionPhaseRow.js";

afterEach(cleanup);

/** Two repository roots, which is the whole difference the collided rows had. */
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
    // The claim in one line: equal in provider, server and tool, the two rows must not
    // read the same. Without the reference they did.
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
    // The negative control for both cases above: a row that printed a reference
    // unconditionally would pass them and put an empty figure where a path belongs.
    const container = renderPhase([{ provider: "claude", scope: "user", serverName: "notes" }]);

    const row = bindingRows(container)[0];
    expect(row).toBeDefined();
    expect(row?.textContent ?? "").toContain("user");
    // One figure and not two: the server-and-tool pair, and nothing standing in for a
    // reference this arm does not have.
    expect(row === undefined ? 0 : figureCount(row)).toBe(1);
  });
});
