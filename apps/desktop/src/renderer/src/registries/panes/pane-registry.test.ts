// One owner per pane kind, and the declaration order the layout answers in. Without the
// `"owner-scoped"` refusal, two features claiming one kind would leave the mounted body dependent
// on module evaluation order and the loser silently missing.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  type PaneAddress,
  type PaneLink,
  type PaneOpener,
} from "@renderer/routing/panes/pane-address.js";
import { PANE_KINDS } from "@renderer/routing/panes/pane-kinds.js";
import {
  PaneRegistry,
  paneRegistry,
  registeredPaneKinds,
  type PaneDescriptor,
} from "./pane-registry.js";

/** A descriptor whose render is never called. */
function descriptor(kind: PaneDescriptor["kind"], owner: string): PaneDescriptor {
  return { kind, owner, render: () => null };
}

describe("pane registry — one owner per kind", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a feature's module; keeping the first body would render a stale pane.
    const registry = new PaneRegistry();
    const beforeEdit = descriptor("diff", "repos-feature");
    const afterEdit = descriptor("diff", "repos-feature");
    registry.register(beforeEdit);
    registry.register(afterEdit);
    expect(registry.registeredPaneKinds()).toStrictEqual(["diff"]);
    // Compares the kept `render` by identity, since the two registrations are structurally
    // identical and a registry keeping the first would pass any shape assertion.
    expect(registry.descriptorFor("diff")?.render).toBe(afterEdit.render);
    expect(registry.descriptorFor("diff")?.render).not.toBe(beforeEdit.render);
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new PaneRegistry();
    registry.register(descriptor("transcript", "transcript-feature"));
    expect(() => {
      registry.register(descriptor("transcript", "second-owner"));
    }).toThrow(DuplicateRegistrationError);
    // A refused claim must not half-apply.
    expect(registry.descriptorFor("transcript")?.owner).toBe("transcript-feature");
  });

  it("names both owners in the refusal, so the conflict is actionable", () => {
    const registry = new PaneRegistry();
    registry.register(descriptor("terminal", "terminal-feature"));
    expect(() => {
      registry.register(descriptor("terminal", "browser-feature"));
    }).toThrow(/terminal-feature[\s\S]*browser-feature/u);
  });
});

describe("pane registry — declaration order, not registration order", () => {
  it("reports registered kinds in the spec's order", () => {
    const registry = new PaneRegistry();
    // Registered back to front, so insertion order would answer differently.
    registry.register(descriptor("agents", "third"));
    registry.register(descriptor("diff", "second"));
    registry.register(descriptor("transcript", "first"));
    expect(registry.registeredPaneKinds()).toStrictEqual(["transcript", "diff", "agents"]);
  });

  it("reports only kinds that were claimed", () => {
    const registry = new PaneRegistry();
    registry.register(descriptor("workflow-builder", "workflows-feature"));
    for (const kind of PANE_KINDS) {
      expect(registry.registeredPaneKinds().includes(kind)).toBe(kind === "workflow-builder");
    }
  });

  it("forgets a kind once it is released", () => {
    const registry = new PaneRegistry();
    registry.register(descriptor("browser", "browser-terminal-feature"));
    registry.unregister("browser");
    expect(registry.registeredPaneKinds()).toStrictEqual([]);
    expect(registry.descriptorFor("browser")).toBeUndefined();
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Every case above would pass over a registry that reported kinds nobody registered.
    expect(new PaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});

describe("pane registry — the process-wide instance", () => {
  it("claims a kind on the process-wide registry", () => {
    // Driven directly so `registeredPaneKinds` is exercised; the claim goes through the registry.
    try {
      paneRegistry.register(descriptor("workflow-builder", "pane-registry-test"));
      expect(paneRegistry.descriptorFor("workflow-builder")?.owner).toBe("pane-registry-test");
      expect(registeredPaneKinds()).toContain("workflow-builder");
    } finally {
      paneRegistry.unregister("workflow-builder");
    }
  });

  it("negative control: the kind is absent once released", () => {
    // Without this, a descriptor left by an earlier file would pass the case above.
    expect(paneRegistry.descriptorFor("workflow-builder")).toBeUndefined();
    expect(registeredPaneKinds()).not.toContain("workflow-builder");
  });
});

describe("pane opener — a pane that opens another can name itself", () => {
  /**
   * An opener that records what it was asked for, as the layout copies the link onto the new pane.
   */
  function recordingOpener(): {
    readonly openPane: PaneOpener;
    readonly opens: {
      readonly address: PaneAddress;
      readonly link: PaneLink | undefined;
    }[];
  } {
    const opens: {
      readonly address: PaneAddress;
      readonly link: PaneLink | undefined;
    }[] = [];
    return {
      openPane: (address, link) => {
        opens.push({ address, link });
      },
      opens,
    };
  }

  // A worktree, because the address union types `entity` per kind and a `diff` pane views a
  // worktree or a workspace.
  const diffAddress: PaneAddress = {
    kind: "diff",
    entity: { kind: "worktree", id: "worktree-7" },
  };

  it("carries the source pane id through to the pane layout", () => {
    const { openPane, opens } = recordingOpener();
    openPane(diffAddress, { linkedSourcePaneId: "pane-transcript-2" });
    expect(opens).toStrictEqual([
      { address: diffAddress, link: { linkedSourcePaneId: "pane-transcript-2" } },
    ]);
  });

  it("negative control: an open with no source pane carries no link", () => {
    // Without this, an opener that stamped a link on every open would pass the case above.
    const { openPane, opens } = recordingOpener();
    openPane(diffAddress);
    expect(opens[0]?.link).toBeUndefined();
  });
});
