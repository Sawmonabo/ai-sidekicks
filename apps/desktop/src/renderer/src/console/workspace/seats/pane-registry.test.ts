// One owner per pane kind, and the declaration order the deck answers in.
//
// The deck rule `Spec-023 §Console Design (Meridian)` states structurally — "a
// single mount door and a tripwire that fails on a second" — is enforced by the
// registry's `"owner-scoped"` policy. Six families claim pane kinds on six
// branches, so the failure this file exists for is two of them claiming one kind:
// without the refusal, which body mounts would depend on module evaluation order,
// and the loser would be a feature that silently stopped existing.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../../core/index.js";
import { PANE_KINDS } from "./pane-kinds.js";
import {
  ConsolePaneRegistry,
  consolePaneRegistry,
  registerConsolePane,
  registeredPaneKinds,
  type ConsolePaneDescriptor,
} from "./pane-registry.js";

/** A descriptor whose render is never called: these cases are about the table. */
function descriptor(
  kind: ConsolePaneDescriptor["kind"],
  owner: string,
  openInWindow = false,
): ConsolePaneDescriptor {
  return { kind, owner, render: () => null, openInWindow };
}

describe("pane registry — one owner per kind", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a family's module. Refusing that would make the console
    // unreloadable; silently keeping the FIRST would leave the deck rendering the
    // pre-edit body, which reads as an edit that did nothing.
    const registry = new ConsolePaneRegistry();
    registry.register(descriptor("diff", "repos-family"));
    registry.register(descriptor("diff", "repos-family", true));
    expect(registry.registeredPaneKinds()).toStrictEqual(["diff"]);
    expect(registry.descriptorFor("diff")?.openInWindow).toBe(true);
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new ConsolePaneRegistry();
    registry.register(descriptor("timeline", "workspace-family"));
    expect(() => {
      registry.register(descriptor("timeline", "collaboration-family"));
    }).toThrow(DuplicateRegistrationError);
    // The first owner keeps the kind: a refused claim must not have half-applied.
    expect(registry.descriptorFor("timeline")?.owner).toBe("workspace-family");
  });

  it("names both owners in the refusal, so the conflict is actionable", () => {
    const registry = new ConsolePaneRegistry();
    registry.register(descriptor("runs", "composer-family"));
    expect(() => {
      registry.register(descriptor("runs", "workflows-family"));
    }).toThrow(/composer-family[\s\S]*workflows-family/u);
  });
});

describe("pane registry — declaration order, not registration order", () => {
  it("reports registered kinds in the spec's order", () => {
    const registry = new ConsolePaneRegistry();
    // Registered back to front, so an implementation that reported insertion
    // order rather than declaration order would answer differently.
    registry.register(descriptor("agent-console", "third"));
    registry.register(descriptor("approvals", "second"));
    registry.register(descriptor("timeline", "first"));
    expect(registry.registeredPaneKinds()).toStrictEqual([
      "timeline",
      "approvals",
      "agent-console",
    ]);
  });

  it("reports only kinds that were claimed", () => {
    const registry = new ConsolePaneRegistry();
    registry.register(descriptor("artifact", "repos-family"));
    for (const kind of PANE_KINDS) {
      expect(registry.registeredPaneKinds().includes(kind)).toBe(kind === "artifact");
    }
  });

  it("forgets a kind once it is released", () => {
    const registry = new ConsolePaneRegistry();
    registry.register(descriptor("browser", "browser-terminal-family"));
    registry.unregister("browser");
    expect(registry.registeredPaneKinds()).toStrictEqual([]);
    expect(registry.descriptorFor("browser")).toBeUndefined();
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Every case above reads `registeredPaneKinds`, and all of them would pass
    // over a registry that reported kinds nobody registered.
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});

describe("pane registry — the module-scope door", () => {
  it("claims a kind on the process-wide registry", () => {
    // Driven here rather than left to its first caller to discover: no view
    // family has shipped, so `registerConsolePane` is a contract that would
    // otherwise rot unexercised — the same reason `surface-registry.test.ts`
    // drives its own door.
    try {
      registerConsolePane(descriptor("workflow-builder", "pane-registry-test"));
      expect(consolePaneRegistry.descriptorFor("workflow-builder")?.owner).toBe(
        "pane-registry-test",
      );
      expect(registeredPaneKinds()).toContain("workflow-builder");
    } finally {
      consolePaneRegistry.unregister("workflow-builder");
    }
  });

  it("negative control: the kind is absent once released", () => {
    // Without this the case above would pass against a registry that had been
    // holding the descriptor since some earlier file ran, and would keep passing
    // if `registerConsolePane` stopped registering anything at all.
    expect(consolePaneRegistry.descriptorFor("workflow-builder")).toBeUndefined();
    expect(registeredPaneKinds()).not.toContain("workflow-builder");
  });
});
