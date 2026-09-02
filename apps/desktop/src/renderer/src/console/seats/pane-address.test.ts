// Each pane kind's entity scope, at both the compile-time and the runtime door.
//
// The defect this file exists for: every pane kind used to pair with every entity
// reference or with `undefined`, so an artifact pane over a run reference and an
// inspector over nothing were both constructible, and neither the address type nor
// the registry refused either. A body handed one of those queries a partition that
// has never held the row, which renders exactly like an entity the fetch has not
// answered for yet.
//
// Two claims, and they are answered by two different mechanisms. The union is what
// a typed call site is held to, so the cases below suppress real compile errors
// with `@ts-expect-error` — a directive that becomes an error itself the moment the
// error it suppresses stops occurring, which is what keeps them honest. The parse
// is what an UNTYPED boundary is held to, and the sweep at the bottom drives every
// pane kind against every entity kind the table names, so the pre-fold behaviour —
// admit everything — fails on the cross-product rather than on one hand-picked pair.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../core/index.js";
import { IDENTIFIER_MAX_LENGTH } from "../persistence/index.js";
import type { ConsoleEntityRef } from "../store/index.js";
import {
  paneEntityScopeFor,
  parseConsolePaneAddress,
  type ConsolePaneAddress,
} from "./pane-address.js";
import { PANE_KINDS } from "./pane-kinds.js";

const AGENT = { kind: "agent", id: "agent-1" } as const satisfies ConsoleEntityRef;
const RUN = { kind: "run", id: "run-1" } as const satisfies ConsoleEntityRef;
const ARTIFACT = { kind: "artifact", id: "artifact-1" } as const satisfies ConsoleEntityRef;
/** Still a registered entity kind, and no longer one any pane kind is a view of. */
const BROWSER_PAGE = { kind: "browser-page", id: "page-1" } as const satisfies ConsoleEntityRef;

/** One arm of the address union, so a case can read the member that arm carries. */
type AddressArm<TKind extends ConsolePaneAddress["kind"]> = Extract<
  ConsolePaneAddress,
  { readonly kind: TKind }
>;

/** Every entity kind any pane kind admits, read off the real table. */
const SCOPED_ENTITY_KINDS: readonly ConsoleEntityRef["kind"][] = [
  ...new Set(PANE_KINDS.flatMap((kind) => paneEntityScopeFor(kind).entityKinds)),
];

/** The refusal a parse answered with, or a failure naming what it admitted instead. */
function refusalFrom(outcome: ReturnType<typeof parseConsolePaneAddress>): {
  readonly code: string;
  readonly detail: string;
  readonly origin: string;
} {
  if (!isConsoleRefusal(outcome)) {
    throw new Error(`the parse admitted a "${outcome.kind}" address it should have refused`);
  }
  return outcome;
}

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

describe("the boundary parse — what it admits", () => {
  it("admits a pane over an entity kind its row names", () => {
    const outcome = parseConsolePaneAddress("artifact", ARTIFACT);

    expect(isConsoleRefusal(outcome)).toBe(false);
    expect(outcome).toStrictEqual({ kind: "artifact", entity: ARTIFACT });
  });

  it("admits a session-scoped pane with no entity, and answers no entity member", () => {
    const outcome = parseConsolePaneAddress("runs", undefined);

    expect(outcome).toStrictEqual({ kind: "runs" });
  });

  it("admits the bare agent console, because that arm is the picker's", () => {
    expect(parseConsolePaneAddress("agent-console", undefined)).toStrictEqual({
      kind: "agent-console",
    });
  });

  it("returns the bare object itself on an entity-optional arm, with no entity key", () => {
    // `toStrictEqual` against the bare literal is the assertion that pins it: an
    // `entity: undefined` key would fail here, and it is what the union used to
    // require of a typed caller while the parse returned this instead.
    const bareBuilder = parseConsolePaneAddress("workflow-builder", undefined);
    const bareTimeline = parseConsolePaneAddress("timeline", undefined);

    expect(bareBuilder).toStrictEqual({ kind: "workflow-builder" });
    expect(bareTimeline).toStrictEqual({ kind: "timeline" });
    expect("entity" in (bareBuilder as object)).toBe(false);
  });

  it("admits a bare browser pane at both untyped boundaries", () => {
    // The two shapes the parse actually receives, and the pre-fold arm refused
    // both: a restored layout row that carries a kind and no entity, and a route
    // that resolves to a pane kind and nothing else. A page entity a caller could
    // have supplied instead does not exist — the browser seam keys navigate,
    // reload, stop, back, forward, and its navigation subscription by `paneId`.
    const restoredLayoutRow: unknown = { kind: "browser" };
    const { kind: restoredKind, entity: restoredEntity } = restoredLayoutRow as {
      readonly kind: unknown;
      readonly entity?: unknown;
    };

    expect(parseConsolePaneAddress(restoredKind, restoredEntity)).toStrictEqual({
      kind: "browser",
    });
    expect(parseConsolePaneAddress("browser", undefined)).toStrictEqual({ kind: "browser" });
  });
});

describe("the boundary parse — what it refuses, and by which name", () => {
  it("drops a pane kind this build does not render", () => {
    const refusal = refusalFrom(parseConsolePaneAddress("gallery", undefined));

    expect(refusal.code).toBe("pane-kind-unknown");
    expect(refusal.origin).toBe("pane-address");
    expect(refusal.detail).toContain(String(PANE_KINDS.length));
  });

  it("rejects an entity kind the pane is not a view of", () => {
    const refusal = refusalFrom(parseConsolePaneAddress("artifact", RUN));

    expect(refusal.code).toBe("pane-entity-kind-mismatch");
    expect(refusal.detail).toContain("run");
  });

  it("rejects a required entity that was never resolved", () => {
    const refusal = refusalFrom(parseConsolePaneAddress("inspector", undefined));

    expect(refusal.code).toBe("pane-entity-required");
  });

  it("rejects an entity handed to a session-scoped pane", () => {
    const refusal = refusalFrom(parseConsolePaneAddress("runs", RUN));

    expect(refusal.code).toBe("pane-entity-unexpected");
  });

  it("rejects a page entity handed to the browser pane", () => {
    // The other direction of the same fold. The arm takes no entity, so a caller
    // that resolved one is naming a locator the browser seam never issued, and the
    // refusal says so rather than letting a body query a partition nothing fills.
    const refusal = refusalFrom(parseConsolePaneAddress("browser", BROWSER_PAGE));

    expect(refusal.code).toBe("pane-entity-unexpected");
    expect(refusal.detail).toContain("browser-page");
  });

  it("rejects a value that is not an entity reference at all", () => {
    // The shape a layout snapshot written by another build hands back: a row that
    // kept a bare identifier where a reference belongs, and one that kept an empty
    // id, which names no row and would look up as permanently missing.
    for (const malformed of ["artifact-1", { kind: "artifact" }, { kind: "artifact", id: "" }]) {
      expect(refusalFrom(parseConsolePaneAddress("artifact", malformed)).code).toBe(
        "pane-entity-malformed",
      );
    }
  });

  it.each([
    ["a space", "artifact 1"],
    ["a tab", "artifact\t1"],
    ["a newline", "artifact\n1"],
    ["a NUL", "artifact 1"],
    ["a path", "../../etc/passwd"],
    ["a bare path separator", "artifacts/artifact-1"],
    ["prose", "the artifact Priya opened this morning"],
    ["a quote", 'artifact-"1"'],
    ["an over-length string", `artifact-${"9".repeat(IDENTIFIER_MAX_LENGTH)}`],
  ])("rejects an id carrying %s", (_class, id) => {
    // Each is a string the previous `id.length > 0` check admitted, and each then
    // produced a valid-looking pane address whose body would query a store key that
    // can never exist. The layout snapshot this parse reads back is written through
    // the persistence value walk, which refuses every one of them — so before this
    // the durable boundary and the route boundary disagreed about the same string.
    const refusal = refusalFrom(parseConsolePaneAddress("artifact", { kind: "artifact", id }));

    expect(refusal.code).toBe("pane-entity-malformed");
    expect(refusal.origin).toBe("pane-address");
    // The refused string is never echoed — a refusal that quoted it would carry it
    // one layer past the boundary that stopped it — but the ceiling is named, so a
    // person reading the sentence knows what would change the answer.
    expect(refusal.detail).not.toContain(id);
    expect(refusal.detail).toContain(String(IDENTIFIER_MAX_LENGTH));
  });

  it("negative control: the ids this build's own fixtures carry are admitted", () => {
    // Without this, the sweep above would hold over a parse that refused every id.
    // Both shapes the corpus actually mints: the scenario's UUID and the seat
    // fixtures' dashed name.
    const scenarioId = "019b79ee-0280-7c11-8110-d1a4c1150092";

    expect(parseConsolePaneAddress("artifact", { kind: "artifact", id: scenarioId })).toStrictEqual(
      { kind: "artifact", entity: { kind: "artifact", id: scenarioId } },
    );
    expect(parseConsolePaneAddress("artifact", ARTIFACT)).toStrictEqual({
      kind: "artifact",
      entity: ARTIFACT,
    });
  });
});

describe("every pane kind against every scoped entity kind", () => {
  it("admits a pairing exactly when the kind's own row names it", () => {
    // The sweep the pre-fold address could not survive: it admitted every pairing,
    // so it fails here on the first row whose scope is narrower than everything.
    for (const paneKind of PANE_KINDS) {
      const scope = paneEntityScopeFor(paneKind);
      for (const entityKind of SCOPED_ENTITY_KINDS) {
        const outcome = parseConsolePaneAddress(paneKind, { kind: entityKind, id: "entity-1" });
        expect(
          isConsoleRefusal(outcome),
          `"${paneKind}" answered the wrong way for a "${entityKind}"`,
        ).toBe(!scope.entityKinds.includes(entityKind));
      }
    }
  });

  it("admits an absent entity exactly where the kind's own row calls it optional", () => {
    for (const paneKind of PANE_KINDS) {
      const outcome = parseConsolePaneAddress(paneKind, undefined);
      expect(isConsoleRefusal(outcome), `"${paneKind}" answered the wrong way for no entity`).toBe(
        paneEntityScopeFor(paneKind).entityRequired,
      );
    }
  });

  it("negative control: the rows are not all the same, so the sweep can fail", () => {
    // Without this the two sweeps above would hold over a table whose every row
    // admitted everything and every row admitted nothing — each is self-consistent
    // and neither is the rule. Both shapes have to be present for the cross-product
    // to be a real test rather than a restatement of the table.
    const scopes = PANE_KINDS.map((kind) => paneEntityScopeFor(kind));

    expect(scopes.some((scope) => scope.entityKinds.length === 0)).toBe(true);
    expect(scopes.some((scope) => scope.entityKinds.length > 0)).toBe(true);
    expect(scopes.some((scope) => scope.entityRequired)).toBe(true);
    expect(scopes.some((scope) => !scope.entityRequired)).toBe(true);
  });
});
