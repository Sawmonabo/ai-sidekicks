// The address union as the compiler holds a caller to it: the cases suppress real compile errors
// with `@ts-expect-error`, which itself errors once the suppressed error stops occurring.
// `parse-pane-address.test.ts` drives the same rows through the untyped boundary. The row suites
// assert at both entries because a row missing from both is the defect they guard.

import { describe, expect, it } from "vitest";

import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { type PaneAddress } from "./pane-address.js";
import { parsePaneAddress } from "./parse-pane-address.js";
import { AGENT, ARTIFACT, BROWSER_PAGE, RUN, refusalFrom } from "./pane-address.test-support.js";

/** One arm of the address union, so a case can read the member that arm carries. */
type AddressArm<TKind extends PaneAddress["kind"]> = Extract<PaneAddress, { readonly kind: TKind }>;

describe("the address union, at a typed call site", () => {
  it("refuses an entity kind the pane is not a view of", () => {
    // @ts-expect-error a workflow-run pane is a view of a workflow run, never of an agent run
    const wrongEntity: AddressArm<"workflow-run"> = { kind: "workflow-run", entity: RUN };
    // Reads the suppressed object, so deleting the construction fails the case.
    expect(wrongEntity.entity).toBe(RUN);
  });

  it("refuses a required entity that was never resolved", () => {
    // @ts-expect-error an inspector has nothing to inspect without its entity
    const noEntity: AddressArm<"inspector"> = { kind: "inspector" };
    expect(noEntity.kind).toBe("inspector");
  });

  it("refuses an entity on a session-scoped pane", () => {
    // @ts-expect-error the session's terminal takes no entity at all
    const strayEntity: AddressArm<"terminal"> = { kind: "terminal", entity: RUN };
    expect(strayEntity.kind).toBe("terminal");
  });

  it("refuses an entity on the browser pane, which the seam keys by pane id", () => {
    // @ts-expect-error the browser seam keys every operation by `paneId`; there is
    // no page entity for a browser address to be over
    const strayPage: AddressArm<"browser"> = { kind: "browser", entity: BROWSER_PAGE };
    expect(strayPage.kind).toBe("browser");
  });

  it("admits the documented no-agent arm, so the optionality that is real survives", () => {
    // Negative control for the three cases above: a union that refused everything would
    // satisfy them all.
    const pickerArm: AddressArm<"agents"> = { kind: "agents", entity: undefined };
    const bareBuilder: AddressArm<"workflow-builder"> = {
      kind: "workflow-builder",
      entity: undefined,
    };
    const namedAgent: AddressArm<"agents"> = { kind: "agents", entity: AGENT };

    expect(pickerArm.entity).toBeUndefined();
    expect(bareBuilder.entity).toBeUndefined();
    expect(namedAgent.entity).toBe(AGENT);
  });

  it("admits the bare object on every entity-optional arm, with no `entity` key at all", () => {
    // `entity: undefined` and an absent key are different types; these three are the bare
    // objects the parse returns, so the static and runtime contracts agree.
    const bareTranscript: AddressArm<"transcript"> = { kind: "transcript" };
    const bareBuilder: AddressArm<"workflow-builder"> = { kind: "workflow-builder" };
    const barePicker: AddressArm<"agents"> = { kind: "agents" };

    expect(bareTranscript).toStrictEqual({ kind: "transcript" });
    expect(bareBuilder).toStrictEqual({ kind: "workflow-builder" });
    expect(barePicker).toStrictEqual({ kind: "agents" });
  });

  it("negative control: the bare object stays refused on an entity-REQUIRED arm", () => {
    // Without it, the case above passes over a union that made every `entity` member
    // optional, which would let a caller open a diff pane with nothing to diff.
    // @ts-expect-error a diff pane is the changes OF something and takes no bare form
    const bareDiff: AddressArm<"diff"> = { kind: "diff" };
    // @ts-expect-error a workflow-run pane is a view of one run and takes no bare form
    const bareWorkflowRun: AddressArm<"workflow-run"> = { kind: "workflow-run" };

    expect(bareDiff.kind).toBe("diff");
    expect(bareWorkflowRun.kind).toBe("workflow-run");
  });
});

/** The entity kinds that own a checkout, which the inspector and the diff pane view. */
const CHECKOUT_ENTITY_KINDS = ["workspace", "worktree"] as const;

/** Entity kinds that own no checkout, so no record or change set is drawn. */
const KINDS_WITHOUT_A_CHECKOUT = ["user", "repo"] as const;

const REPO: EntityRef & { readonly kind: "repo" } = { kind: "repo", id: "repo-1" };

describe("the inspector, over the checkout the session is holding", () => {
  it("parses an inspector address for a workspace and for a worktree", () => {
    for (const entityKind of CHECKOUT_ENTITY_KINDS) {
      const entity = { kind: entityKind, id: `${entityKind}-1` } satisfies EntityRef;

      expect(parsePaneAddress("inspector", entity)).toStrictEqual({
        kind: "inspector",
        entity,
      });
    }
  });

  it("negative control: the inspector refuses every kind that owns no checkout", () => {
    // Without it, the case above passes over a scope that admitted every entity kind.
    // @ts-expect-error a repo owns no checkout, so nothing routes it to the inspector
    const repoInspector: AddressArm<"inspector"> = { kind: "inspector", entity: REPO };
    expect(repoInspector.entity.kind).toBe("repo");
    for (const entityKind of [...KINDS_WITHOUT_A_CHECKOUT, "run"]) {
      const entity = { kind: entityKind, id: `${entityKind}-1` };

      expect(refusalFrom(parsePaneAddress("inspector", entity)).code).toBe(
        "pane-entity-kind-mismatch",
      );
    }
  });
});

describe("the diff pane, over the same checkout", () => {
  it("parses a diff address for a workspace and for a worktree", () => {
    for (const entityKind of CHECKOUT_ENTITY_KINDS) {
      const entity = { kind: entityKind, id: `${entityKind}-1` } satisfies EntityRef;

      expect(parsePaneAddress("diff", entity)).toStrictEqual({ kind: "diff", entity });
    }
  });

  it("negative control: the diff refuses a kind that owns no checkout", () => {
    // Without it, the case above passes over a scope that admitted every entity kind.
    // @ts-expect-error a run owns no checkout, so no change set is drawn for it
    const runDiff: AddressArm<"diff"> = { kind: "diff", entity: RUN };
    expect(runDiff.entity.kind).toBe("run");
    expect(refusalFrom(parsePaneAddress("diff", RUN)).code).toBe("pane-entity-kind-mismatch");
    expect(refusalFrom(parsePaneAddress("diff", ARTIFACT)).code).toBe("pane-entity-kind-mismatch");
    for (const entityKind of KINDS_WITHOUT_A_CHECKOUT) {
      const entity = { kind: entityKind, id: `${entityKind}-1` };

      expect(refusalFrom(parsePaneAddress("diff", entity)).code).toBe("pane-entity-kind-mismatch");
    }
  });
});
