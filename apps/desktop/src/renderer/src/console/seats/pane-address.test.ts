// Which entity each pane kind is a view of, as the COMPILER holds a caller to it.
//
// The defect this file exists for: every pane kind used to pair with every entity
// reference or with `undefined`, so an artifact pane over a run reference and an
// inspector over nothing were both constructible, and neither the address type nor the
// registry refused either. A body handed one of those queries a partition that has never
// held the row, which renders exactly like an entity the fetch has not answered for yet.
//
// The mechanism here is the union, so the cases below suppress real compile errors with
// `@ts-expect-error` — a directive that becomes an error itself the moment the error it
// suppresses stops occurring, which is what keeps them honest. What the UNTYPED boundary
// does with the same rows is `pane-address-parse.test.ts`', including the cross-product
// sweep that makes the pre-fold behaviour — admit everything — fail on every pair rather
// than on one hand-picked one.
//
// THE TWO ROW SUITES BELOW ASSERT AT BOTH DOORS, and that is deliberate rather than a
// leak across the seam. A row is one fact; the union and the table are two readings of
// it, and the failure those suites were written for was a row missing from BOTH. A suite
// that proved the row only where it was already right would have passed through exactly
// that defect.

import { describe, expect, it } from "vitest";

import type { ConsoleEntityRef } from "../store/index.js";
import { paneEntityScopeFor, type ConsolePaneAddress } from "./pane-address.js";
import { parseConsolePaneAddress } from "./pane-address-parse.js";
import { AGENT, ARTIFACT, BROWSER_PAGE, RUN, refusalFrom } from "./pane-address.test-support.js";

/** One arm of the address union, so a case can read the member that arm carries. */
type AddressArm<TKind extends ConsolePaneAddress["kind"]> = Extract<
  ConsolePaneAddress,
  { readonly kind: TKind }
>;

describe("the address union, at a typed call site", () => {
  it("refuses an entity kind the pane is not a view of", () => {
    // @ts-expect-error an artifact pane is a view of an artifact, never of a run
    const wrongEntity: AddressArm<"artifact"> = { kind: "artifact", entity: RUN };
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
    // @ts-expect-error the session's runs list takes no entity at all
    const strayEntity: AddressArm<"runs"> = { kind: "runs", entity: RUN };
    expect(strayEntity.kind).toBe("runs");
  });

  it("refuses an entity on the browser pane, which the seam keys by pane id", () => {
    // @ts-expect-error the browser seam keys every operation by `paneId`; there is
    // no page entity for a browser address to be over
    const strayPage: AddressArm<"browser"> = { kind: "browser", entity: BROWSER_PAGE };
    expect(strayPage.kind).toBe("browser");
  });

  it("admits the documented no-agent arm, so the optionality that is real survives", () => {
    // The negative control for the three cases above: a union that refused
    // everything would satisfy them all. The agent console's bare arm is the
    // picker's — a session is chosen and no agent is named yet — and the workflow
    // builder's is the workflows destination opening it with nothing defined.
    const pickerArm: AddressArm<"agent-console"> = { kind: "agent-console", entity: undefined };
    const bareBuilder: AddressArm<"workflow-builder"> = {
      kind: "workflow-builder",
      entity: undefined,
    };
    const namedAgent: AddressArm<"agent-console"> = { kind: "agent-console", entity: AGENT };

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
    const bareTimeline: AddressArm<"timeline"> = { kind: "timeline" };
    const bareBuilder: AddressArm<"workflow-builder"> = { kind: "workflow-builder" };
    const barePicker: AddressArm<"agent-console"> = { kind: "agent-console" };

    expect(bareTimeline).toStrictEqual({ kind: "timeline" });
    expect(bareBuilder).toStrictEqual({ kind: "workflow-builder" });
    expect(barePicker).toStrictEqual({ kind: "agent-console" });
  });

  it("negative control: the bare object stays refused on an entity-REQUIRED arm", () => {
    // Without this, the case above would hold over a union that made every `entity`
    // member optional — which is the fix's own failure mode, and it would let a caller
    // open a diff pane with nothing to diff.
    // @ts-expect-error a diff pane is the changes OF something and takes no bare form
    const bareDiff: AddressArm<"diff"> = { kind: "diff" };
    // @ts-expect-error an artifact pane is a view of an artifact and takes no bare form
    const bareArtifact: AddressArm<"artifact"> = { kind: "artifact" };

    expect(bareDiff.kind).toBe("diff");
    expect(bareArtifact.kind).toBe("artifact");
  });
});

/** The five kinds `Spec-023 §The surface set` enumerates as sidebar cards. */
const SIDEBAR_CARD_ENTITY_KINDS = [
  "participant",
  "workspace",
  "worktree",
  "repo",
  "invite",
] as const;

describe("the inspector, over the entities the spec routes to it", () => {
  it("parses an inspector address for every entity kind the spec names", () => {
    // `Spec-023 §Console Design (Meridian)` §The surface set routes five kinds to the
    // inspector, and two of them — repo and invite — were not console entity kinds at
    // all, so the address union could not represent them and the runtime scope table
    // rejected them as kind mismatches. The repos and collaboration branches would
    // have had to reopen this shared substrate to open a pane the spec already routes.
    for (const entityKind of SIDEBAR_CARD_ENTITY_KINDS) {
      const entity = { kind: entityKind, id: `${entityKind}-1` } satisfies ConsoleEntityRef;

      expect(parseConsolePaneAddress("inspector", entity)).toStrictEqual({
        kind: "inspector",
        entity,
      });
    }
  });

  it("admits the repo and invite refs at a typed call site too", () => {
    // The compile-time half. Both were unconstructible before, at a type the union
    // derived from an entity vocabulary that named neither.
    const repoInspector: AddressArm<"inspector"> = {
      kind: "inspector",
      entity: { kind: "repo", id: "repo-1" },
    };
    const inviteInspector: AddressArm<"inspector"> = {
      kind: "inspector",
      entity: { kind: "invite", id: "invite-1" },
    };

    expect(repoInspector.entity.kind).toBe("repo");
    expect(inviteInspector.entity.kind).toBe("invite");
  });

  it("negative control: the inspector still refuses a kind the spec does not route to it", () => {
    // Without this the two cases above would hold over a scope that admitted every
    // entity kind, which is what the fix's own failure mode looks like — an inspector
    // opened over a run has no card to render.
    // @ts-expect-error the spec routes no run entity to the inspector
    const runInspector: AddressArm<"inspector"> = { kind: "inspector", entity: RUN };
    expect(runInspector.entity.kind).toBe("run");
    expect(refusalFrom(parseConsolePaneAddress("inspector", RUN)).code).toBe(
      "pane-entity-kind-mismatch",
    );
  });
});

describe("the diff pane, over the entities whose changes the spec routes to it", () => {
  it("parses a diff address for every entity kind that sentence enumerates", () => {
    // `Spec-023 §Console Design (Meridian)` §The surface set, one sentence: "a repo,
    // workspace, worktree, invite, or member entity is a card in its sidebar section
    // and opens as an `inspector` pane keyed by its entity kind, its changes opening
    // the `diff` pane". "its changes" has one antecedent, and it is the same
    // enumerated subject the inspector clause takes — so both clauses distribute over
    // one list. The row was `worktree | workspace`, which refused a repo's changes
    // statically and answered `pane-entity-kind-mismatch` at the runtime parse.
    for (const entityKind of SIDEBAR_CARD_ENTITY_KINDS) {
      const entity = { kind: entityKind, id: `${entityKind}-1` } satisfies ConsoleEntityRef;

      expect(parseConsolePaneAddress("diff", entity)).toStrictEqual({ kind: "diff", entity });
    }
  });

  it("admits the three added refs at a typed call site too", () => {
    // The compile-time half. All three were unconstructible before, at a type derived
    // from a narrower list than the sentence its sibling row already reads.
    const repoDiff: AddressArm<"diff"> = { kind: "diff", entity: { kind: "repo", id: "repo-1" } };
    const inviteDiff: AddressArm<"diff"> = {
      kind: "diff",
      entity: { kind: "invite", id: "invite-1" },
    };
    const memberDiff: AddressArm<"diff"> = {
      kind: "diff",
      entity: { kind: "participant", id: "participant-1" },
    };

    expect(repoDiff.entity.kind).toBe("repo");
    expect(inviteDiff.entity.kind).toBe("invite");
    expect(memberDiff.entity.kind).toBe("participant");
  });

  it("reads the same list as the inspector, because it is the same sentence", () => {
    // The set is declared once and both rows read it, so the two cannot drift into
    // two readings of one clause.
    expect(paneEntityScopeFor("diff").entityKinds).toStrictEqual(
      paneEntityScopeFor("inspector").entityKinds,
    );
  });

  it("negative control: the diff still refuses a kind that sentence does not name", () => {
    // Without this the cases above would hold over a scope that admitted every entity
    // kind, which is the fix's own failure mode — a diff opened over a run or an
    // artifact is a pane with nothing to show and a body querying a partition that
    // has never held the row.
    // @ts-expect-error the spec routes no run entity to the diff pane
    const runDiff: AddressArm<"diff"> = { kind: "diff", entity: RUN };
    expect(runDiff.entity.kind).toBe("run");
    expect(refusalFrom(parseConsolePaneAddress("diff", RUN)).code).toBe(
      "pane-entity-kind-mismatch",
    );
    expect(refusalFrom(parseConsolePaneAddress("diff", ARTIFACT)).code).toBe(
      "pane-entity-kind-mismatch",
    );
  });
});
