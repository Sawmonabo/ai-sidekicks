// Which entity each pane kind is a view of, as the COMPILER holds a caller to it.
//
// The defect this file exists for: every pane kind used to pair with every entity
// reference or with `undefined`, so a workflow-run pane over an agent run reference and
// an inspector over nothing were both constructible, and neither the address type nor the
// registry refused either. A body handed one of those queries a partition that has never
// held the row, which renders exactly like an entity the fetch has not answered for yet.
//
// The mechanism here is the union, so the cases below suppress real compile errors with
// `@ts-expect-error` — a directive that becomes an error itself the moment the error it
// suppresses stops occurring, which is what keeps them honest. What the UNTYPED boundary
// does with the same rows is `pane-address-parse.test.ts`', including the cross-product
// sweep that makes the pre-fold behavior — admit everything — fail on every pair rather
// than on one hand-picked one.
//
// THE TWO ROW SUITES BELOW ASSERT AT BOTH DOORS, and that is deliberate rather than a
// leak across the seam. A row is one fact; the union and the table are two readings of
// it, and the failure those suites were written for was a row missing from BOTH. A suite
// that proved the row only where it was already right would have passed through exactly
// that defect.

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
    // Reads the object the directive above suppressed, so the case fails if the
    // construction is ever deleted rather than passing vacuously.
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
    // The negative control for the three cases above: a union that refused
    // everything would satisfy them all. The Agents pane's bare arm is the
    // picker's — a session is chosen and no agent is named yet — and the workflow
    // builder's is the workflows destination opening it with nothing defined.
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
    // The arm the union could not express. `entity: undefined` and an absent key read
    // identically at a call site and are not the same TYPE: a required member whose
    // value may be undefined made the documented bare `{ kind: "workflow-builder" }`
    // unwritable, while the parse returned exactly that object through a cast — so the
    // static contract and the runtime contract disagreed and the cast hid it. These
    // three are what the parse now returns, constructed by hand at the same type.
    const bareTranscript: AddressArm<"transcript"> = { kind: "transcript" };
    const bareBuilder: AddressArm<"workflow-builder"> = { kind: "workflow-builder" };
    const barePicker: AddressArm<"agents"> = { kind: "agents" };

    expect(bareTranscript).toStrictEqual({ kind: "transcript" });
    expect(bareBuilder).toStrictEqual({ kind: "workflow-builder" });
    expect(barePicker).toStrictEqual({ kind: "agents" });
  });

  it("negative control: the bare object stays refused on an entity-REQUIRED arm", () => {
    // Without this, the case above would hold over a union that made every `entity`
    // member optional — which is the fix's own failure mode, and it would let a caller
    // open a diff pane with nothing to diff.
    // @ts-expect-error a diff pane is the changes OF something and takes no bare form
    const bareDiff: AddressArm<"diff"> = { kind: "diff" };
    // @ts-expect-error a workflow-run pane is a view of one run and takes no bare form
    const bareWorkflowRun: AddressArm<"workflow-run"> = { kind: "workflow-run" };

    expect(bareDiff.kind).toBe("diff");
    expect(bareWorkflowRun.kind).toBe("workflow-run");
  });
});

/** The two kinds that own a checkout, which the inspector and the diff pane are views of. */
const CHECKOUT_ENTITY_KINDS = ["workspace", "worktree"] as const;

/** Kinds that exist in the store and own no checkout, so no record or change set is drawn. */
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
    // Without this the case above would hold over a scope that admitted every entity
    // kind — an inspector opened over a run, a repo, or the user has no record to draw.
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
    // Without this the case above would hold over a scope that admitted every entity
    // kind — a diff opened over a run, an artifact, a repo, or the user is a pane with
    // nothing to show and a body querying a partition that has never held the row.
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
