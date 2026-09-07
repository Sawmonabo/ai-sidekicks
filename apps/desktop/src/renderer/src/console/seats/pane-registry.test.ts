// One owner per pane kind, and the declaration order the deck answers in.
//
// The deck rule `Spec-023 §Console Design (Meridian)` states structurally — "a
// single mount door and a tripwire that fails on a second" — is enforced by the
// registry's `"owner-scoped"` policy. Six families claim pane kinds on six
// branches, so the failure this file exists for is two of them claiming one kind:
// without the refusal, which body mounts would depend on module evaluation order,
// and the loser would be a feature that silently stopped existing.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/keyed-registry.js";
import { type ConsolePaneAddress } from "./pane-address.js";
import { PANE_KINDS, isDetachablePaneKind } from "./pane-kinds.js";
import {
  ConsolePaneRegistry,
  consolePaneRegistry,
  registeredPaneKinds,
  type ConsolePaneDescriptor,
  type ConsolePaneLink,
  type ConsolePaneOpener,
} from "./pane-registry.js";

/** A descriptor whose render is never called: these cases are about the table. */
function descriptor(kind: ConsolePaneDescriptor["kind"], owner: string): ConsolePaneDescriptor {
  return { kind, owner, render: () => null };
}

describe("pane registry — one owner per kind", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a family's module. Refusing that would make the console
    // unreloadable; silently keeping the FIRST would leave the deck rendering the
    // pre-edit body, which reads as an edit that did nothing.
    const registry = new ConsolePaneRegistry();
    const beforeEdit = descriptor("diff", "repos-family");
    const afterEdit = descriptor("diff", "repos-family");
    registry.register(beforeEdit);
    registry.register(afterEdit);
    expect(registry.registeredPaneKinds()).toStrictEqual(["diff"]);
    // Identity of the BODY, not shape and not of the descriptor object: the registry
    // normalises both registration forms into a descriptor of its own, so what says
    // which body the deck mounts is the `render` it kept. The two registrations are
    // structurally identical, so a registry that kept the FIRST would satisfy every
    // shape assertion while the deck went on rendering the pre-edit body.
    expect(registry.descriptorFor("diff")?.render).toBe(afterEdit.render);
    expect(registry.descriptorFor("diff")?.render).not.toBe(beforeEdit.render);
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

describe("pane registry — a descriptor cannot advertise a detach of its own", () => {
  it("takes the registration and still refuses the kind a detach", () => {
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "browser",
      owner: "browser-terminal-family",
      render: () => null,
      // @ts-expect-error the descriptor carries no detach member: whether a kind
      // may be torn off is `isDetachablePaneKind`'s single answer, derived from the
      // window model, and never a claim a family makes about the kind it owns.
      openInWindow: true,
    });
    // Registration is unchanged — this finding narrowed the descriptor, it did not
    // add a refusal — and the kind still cannot be torn off.
    expect(registry.descriptorFor("browser")?.owner).toBe("browser-terminal-family");
    expect(isDetachablePaneKind("browser")).toBe(false);
  });

  it("negative control: the directive above is suppressing a real error", () => {
    // A `@ts-expect-error` over a member the interface still carried would itself
    // be an unused-directive error, so this pair is what makes the removal a
    // compile-time fact rather than a comment: the type refuses the member and the
    // kind's detachability comes from the derived set.
    expect(isDetachablePaneKind("timeline")).toBe(true);
    expect(isDetachablePaneKind("agent-console")).toBe(true);
  });
});

describe("pane registry — the module-scope door", () => {
  it("claims a kind on the process-wide registry", () => {
    // Driven here rather than left to its first caller to discover: no view family
    // has shipped, so `registeredPaneKinds` is a contract that would otherwise rot
    // unexercised — the same reason `surface-registry.test.ts` drives its own door.
    // The claim goes in through the registry itself: the module-scope convenience
    // that used to write here was deleted with the arity-five composition, because a
    // family that called it would write into production from inside a composition
    // that had handed it another board.
    try {
      consolePaneRegistry.register(descriptor("workflow-builder", "pane-registry-test"));
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
    // holding the descriptor since some earlier file ran, and would keep passing if
    // `registeredPaneKinds` stopped reading the registry at all.
    expect(consolePaneRegistry.descriptorFor("workflow-builder")).toBeUndefined();
    expect(registeredPaneKinds()).not.toContain("workflow-builder");
  });
});

describe("pane opener — a pane that opens another can name itself", () => {
  /**
   * A deck-shaped opener: it records what it was asked for, exactly as a deck
   * would copy the link onto the new pane's context.
   *
   * Driven here rather than left to the ledger deck to discover, for the reason
   * the module-scope door above is driven here: the deck ships on another branch,
   * so the seat's second parameter would otherwise be a contract nothing exercises
   * until the first consumer gets it wrong.
   */
  function recordingOpener(): {
    readonly openPane: ConsolePaneOpener;
    readonly opens: {
      readonly address: ConsolePaneAddress;
      readonly link: ConsolePaneLink | undefined;
    }[];
  } {
    const opens: {
      readonly address: ConsolePaneAddress;
      readonly link: ConsolePaneLink | undefined;
    }[] = [];
    return {
      openPane: (address, link) => {
        opens.push({ address, link });
      },
      opens,
    };
  }

  // A worktree, because the address union types `entity` PER KIND and a `diff`
  // pane is a view of a worktree or a workspace. An artifact reference here is
  // not a fixture detail the compiler now lets pass.
  const diffAddress: ConsolePaneAddress = {
    kind: "diff",
    entity: { kind: "worktree", id: "worktree-7" },
  };

  it("carries the source pane id through to the deck", () => {
    const { openPane, opens } = recordingOpener();
    openPane(diffAddress, { linkedSourcePaneId: "pane-ledger-2" });
    expect(opens).toStrictEqual([
      { address: diffAddress, link: { linkedSourcePaneId: "pane-ledger-2" } },
    ]);
  });

  it("negative control: an open with no source pane carries no link", () => {
    // Without this, the case above would pass over an opener that stamped some
    // link on every open — and a pane linked to a source it was not opened from
    // is exactly the state `linkedSourcePaneId` exists to make impossible.
    const { openPane, opens } = recordingOpener();
    openPane(diffAddress);
    expect(opens[0]?.link).toBeUndefined();
  });
});
