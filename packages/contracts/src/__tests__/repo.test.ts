// `repo.ts` contract core: branded ids, the four canonical repo/workspace
// enums, the derived `RepoMountHealth` projection, the shared lifecycle
// event payload, and its registration into `SessionEventSchema`.
//
// Backstops and the invariant this contract carries:
//   • `VcsTypeSchema` is the discriminator's contract carrier, so the
//     tests pin it CLOSED at `git`: no second member, no tolerant
//     passthrough arm. Attach refuses a path that is not a git repository.
//
// Coverage shape:
//   • Every member of every enum parses; out-of-set values are rejected (a 3rd
//     mode, a 6th workspace state, a 4th mount state, a 2nd vcs type), so
//     each pin is a real accept/reject boundary rather than a one-sided
//     smoke test.
//   • Branded ids reject a non-UUID, and the brand is nominal at compile
//     time (a raw string is not a `RepoMountId`).
//   • `RepoMountHealth` accepts all three ratified verdicts, rejects a
//     `status` outside them, and rejects a missing `checkedAt`, a non-ISO
//     `checkedAt`, and an unknown key.
//   • The lifecycle payload matches field-for-field: `sessionId` required,
//     the three subject ids optional and independently omittable, `state`
//     drawn from BOTH vocabularies, `actor` bounded by the envelope's own cap
//     and its three `wireFreeFormString` guards.
//   • The six types parse end-to-end through `SessionEventSchema` with a
//     category/type mismatch and a payload smuggle rejected. The
//     `worktree.*` half of the family registered through the same seam is
//     covered by worktree.test.ts, which owns that contract.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  EVENT_FIELD_MAX_LEN,
  RepoAttachedEventSchema,
  RepoDetachedEventSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  WorkspaceArchivedEventSchema,
  WorkspacePreparingEventSchema,
  WorkspaceReadyEventSchema,
  WorkspaceStaleEventSchema,
  type SessionEvent,
} from "../event.js";
import * as contracts from "../index.js";
import { NODE_ID_MAX_LEN, NodeIdSchema } from "../node-id.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  ExecutionModeSchema,
  RepoAttachRequestSchema,
  RepoAttachResponseSchema,
  RepoDetachRequestSchema,
  RepoDetachResponseSchema,
  RepoMountHealthSchema,
  RepoMountIdSchema,
  RepoMountReadRequestSchema,
  RepoMountReadResponseSchema,
  RepoMountStateSchema,
  RepoWorkspaceLifecyclePayloadSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoAttachResponse,
  type RepoMountHealth,
  type RepoMountId,
  type RepoMountState,
  type RepoWorkspaceLifecyclePayload,
  type VcsType,
  type WorkspaceId,
  type WorkspaceState,
} from "../repo.js";
import { FILE_PATH_MAX_LEN } from "../session.js";

// Real RFC 9562 UUIDs (mix of v4 and v7). `RFC_9562_TEXT_FORM` validates the version
// nibble + variant bits in canonical positions; mismatch is rejected at the
// branded-id schema layer.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const CHECKED_AT = "2026-07-24T19:14:35.000Z";
const VERSION = "1.0";

// --------------------------------------------------------------------------
// Canonical enums.
// --------------------------------------------------------------------------

describe("ExecutionModeSchema (two-mode taxonomy)", () => {
  it.each([
    ["bound-root", true],
    ["provisioned-worktree", true],
    ["submodule", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(ExecutionModeSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("enumerates exactly the two canonical modes (no more, no less)", () => {
    // Exact-set pin, read through the same `.options` internals cast the
    // EventCategorySchema pin in session-event.test.ts uses: the schema is
    // annotated `z.ZodType<ExecutionMode>` for `isolatedDeclarations`, which
    // erases the enum construct.
    const schemaInternals = ExecutionModeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options].sort()).toEqual(["bound-root", "provisioned-worktree"]);
  });
});

describe("WorkspaceStateSchema (the 5-value workspace lifecycle)", () => {
  it.each([
    ["preparing", true],
    ["ready", true],
    ["busy", true],
    ["stale", true],
    ["archived", true],
    // A sixth state. `detached` belongs to the MOUNT vocabulary and must not
    // leak across; `unreachable` belongs to RepoMountHealth.
    ["detached", false],
    ["unreachable", false],
    ["failed", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(WorkspaceStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("RepoMountStateSchema (the 3-value mount lifecycle)", () => {
  it.each([
    ["attached", true],
    ["detached", true],
    ["archived", true],
    // A fourth state. `preparing` / `stale` are WORKSPACE states and a
    // mount never occupies them.
    ["preparing", false],
    ["stale", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(RepoMountStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("VcsTypeSchema (git only)", () => {
  it.each([
    ["git", true],
    // The whole content is that the discriminator stays CLOSED at `git`.
    // Each rejection below is a shape a widened union would admit: an
    // "unknown"/"pending" state (which would let a resolver defer the
    // verdict), a sibling VCS (which would be presented as git-adjacent
    // without git capabilities), and the empty string.
    ["unknown", false],
    ["pending", false],
    ["hg", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(VcsTypeSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("admits exactly one member — no second value, no passthrough", () => {
    const schemaInternals = VcsTypeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options]).toEqual(["git"]);
    // Negative control on the pin above: a tolerant arm would make an
    // arbitrary string parse. It must not.
    expect(VcsTypeSchema.safeParse("anything-else").success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Branded ids.
// --------------------------------------------------------------------------

describe("RepoMountIdSchema / WorkspaceIdSchema (branded UUID scalars)", () => {
  it.each([
    ["RepoMountIdSchema", RepoMountIdSchema],
    ["WorkspaceIdSchema", WorkspaceIdSchema],
  ] as const)("%s accepts a canonical UUID and rejects a non-UUID", (_label, schema) => {
    expect(schema.safeParse(REPO_MOUNT_ID).success).toBe(true);
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
    // A UUID-shaped string with a zero version nibble. The branded factory's
    // `RFC_9562_TEXT_FORM` validates the version + variant nibbles, so this is
    // not merely a length-and-hyphens check — and the 2026-09-08 case widening
    // did not touch either nibble.
    expect(schema.safeParse("0190f8a0-7e2d-0c4a-9b1c-1b7c5b3e8f10").success).toBe(false);
  });
});

// COMPILE-TIME pin on the brand's nominality, validated by the
// `tsconfig.test.json` typecheck leg. Held in a never-invoked function so the
// pin does its whole job at compile time. The directive self-verifies: if the
// brand is ever weakened to a bare `string`, TS reports the directive unused
// (TS2578) and the leg goes red rather than silently losing the pin.
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a RepoMountId without a parse.
  const unbranded: RepoMountId = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
  void unbranded;
};
void brandNominalityPin;

// --------------------------------------------------------------------------
// RepoMountHealth — the derived projection.
// --------------------------------------------------------------------------

const buildValidHealth = () => ({
  status: "healthy" as const,
  checkedAt: CHECKED_AT,
});

describe("RepoMountHealthSchema (derived projection, never persisted)", () => {
  it.each([
    ["healthy", true],
    ["unreachable", true],
    // The third ratified verdict: a reachable root whose re-derived common
    // directory no longer equals the attach-persisted anchor. Its accept case is
    // pinned here rather than left implied, because the whole point of the
    // member is that a mount whose binds are already refusing must not still
    // project `healthy`.
    ["identity_mismatch", true],
    // Outside the three-value union. `unknown` is the shape explicitly rejects
    // (the on-read probe floor means every read carries a fresh verdict), and
    // `stale` is the WORKSPACE-state overload chose `unreachable` to avoid.
    ["unknown", false],
    ["stale", false],
    ["degraded", false],
    // Near-misses on the third member's own spelling. A wire value that differs
    // only in separator is the failure a `z.enum` exists to catch.
    ["identity-mismatch", false],
    ["identityMismatch", false],
  ])("status %s -> %s", (status, shouldPass) => {
    expect(RepoMountHealthSchema.safeParse({ ...buildValidHealth(), status }).success).toBe(
      shouldPass,
    );
  });

  it("requires `checkedAt` — a verdict with no probe provenance is unauditable", () => {
    const broken = { ...buildValidHealth() } as Record<string, unknown>;
    delete broken["checkedAt"];
    expect(RepoMountHealthSchema.safeParse(broken).success).toBe(false);
  });

  it("requires `checkedAt` to be an ISO-8601 instant, and admits a numeric offset", () => {
    expect(
      RepoMountHealthSchema.safeParse({ ...buildValidHealth(), checkedAt: "yesterday" }).success,
    ).toBe(false);
    // `{ offset: true }` — the package-wide datetime convention (RFC 3339
    // not just Z-suffixed UTC).
    expect(
      RepoMountHealthSchema.safeParse({
        ...buildValidHealth(),
        checkedAt: "2026-07-24T14:14:35.000-05:00",
      }).success,
    ).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(RepoMountHealthSchema.safeParse({ ...buildValidHealth(), extra: "leak" }).success).toBe(
      false,
    );
  });
});

// --------------------------------------------------------------------------
// RepoWorkspaceLifecyclePayload — the family-shared payload.
// --------------------------------------------------------------------------

const buildMountPayload = () => ({
  sessionId: SESSION_ID,
  repoMountId: REPO_MOUNT_ID,
  state: "attached" as const,
  actor: USER_ID,
});

const buildWorkspacePayload = () => ({
  sessionId: SESSION_ID,
  repoMountId: REPO_MOUNT_ID,
  workspaceId: WORKSPACE_ID,
  state: "ready" as const,
  actor: null,
});

describe("RepoWorkspaceLifecyclePayloadSchema (Workspace, and Worktree Lifecycle)", () => {
  it("accepts the minimum shape — sessionId + state only", () => {
    // Every subject id is optional family shape, so the two required members
    // are the whole floor.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        state: "attached",
      }).success,
    ).toBe(true);
  });

  it("accepts every subject id together — the detach cascade names more than one", () => {
    // No "exactly one id" refinement exists, deliberately: a
    // `workspace.archived` emitted by the detach cascade names both the
    // mount that caused it and the workspace it archived.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        state: "archived",
        actor: USER_ID,
      }).success,
    ).toBe(true);
  });

  it("requires `sessionId` — spells the family base without a `?`", () => {
    const broken = { ...buildMountPayload() } as Record<string, unknown>;
    delete broken["sessionId"];
    expect(RepoWorkspaceLifecyclePayloadSchema.safeParse(broken).success).toBe(false);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), sessionId: "nope" })
        .success,
    ).toBe(false);
  });

  it("requires `state`", () => {
    const broken = { ...buildMountPayload() } as Record<string, unknown>;
    delete broken["state"];
    expect(RepoWorkspaceLifecyclePayloadSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    // BOTH vocabularies are in the union: mount states for `repo.*` rows,
    // workspace states for `workspace.*` rows.
    ["attached (mount)", "attached", true],
    ["detached (mount)", "detached", true],
    ["archived (shared by both vocabularies)", "archived", true],
    ["preparing (workspace)", "preparing", true],
    ["ready (workspace)", "ready", true],
    ["busy (workspace)", "busy", true],
    ["stale (workspace)", "stale", true],
    ["an invented state", "exploded", false],
  ])("state: %s", (_label, state, shouldPass) => {
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success,
    ).toBe(shouldPass);
  });

  it.each([["creating"], ["dirty"], ["merged"], ["retired"]])(
    "rejects -owned worktree state %s (per-family boundary, permanent)",
    (worktreeState) => {
      // This block's original comment predicted would widen the shipped
      // schema with a third `WorktreeStateSchema` union arm; the ratified
      // design PARAMETERIZED the family instead — the
      // registration instantiates the factory in worktree.ts and never
      // touches this schema — so the shipped two-vocabulary accept set never
      // admits a worktree state. These rows stay red for good; the worktree
      // vocabulary's accept half lives in worktree.test.ts against
      // `WorktreeLifecyclePayloadSchema`.
      expect(
        RepoWorkspaceLifecyclePayloadSchema.safeParse({
          sessionId: SESSION_ID,
          worktreeId: WORKTREE_ID,
          state: worktreeState,
        }).success,
      ).toBe(false);
    },
  );

  it("types `worktreeId` as a canonical UUID string (unbranded narrows it later)", () => {
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        state: "ready",
      }).success,
    ).toBe(true);
    // Unbranded does NOT mean unvalidated — the runtime accept-set is the
    // same RFC 9562 text form the branded ids compose.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: "worktree-1",
        state: "ready",
      }).success,
    ).toBe(false);
    // ...and IDENTICAL, not merely similar. This member composes the very
    // predicate `brandedUuidIdSchema` composes (`uuidTextFormSchema`, the
    // unbranded export beside it), so a value's parse result cannot move when
    // narrows this to `WorktreeId`. The case-variant sentinel is the
    // discriminating input: Zod's own `z.uuid()` refuses it while every branded id
    // accepts it, so this pair fails if the member ever composed Zod's format instead
    // of the shared predicate, and on nothing else.
    const upperCaseSentinel = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
    expect(contracts.SessionIdSchema.safeParse(upperCaseSentinel).success).toBe(true);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: upperCaseSentinel,
        state: "ready",
      }).success,
    ).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), extra: "leak" })
        .success,
    ).toBe(false);
  });

  it("accepts `actor: null` and an omitted `actor`, but not an empty or blank one", () => {
    // Same trust-boundary stance as `EventEnvelope.actor`: a system-emitted
    // event uses `null` or omits the key; a present-but-empty actor is a
    // producer bug.
    expect(RepoWorkspaceLifecyclePayloadSchema.safeParse(buildWorkspacePayload()).success).toBe(
      true,
    );
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state: "ready" })
        .success,
    ).toBe(true);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: "" }).success,
    ).toBe(false);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: "\t \n" })
        .success,
    ).toBe(false);
    // Interior whitespace is FINE — `wireFreeFormString` rejects
    // whitespace-ONLY, not any whitespace. Without this control the two
    // rejections above would read as an over-broad guard.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        ...buildMountPayload(),
        actor: "agent alpha",
      }).success,
    ).toBe(true);
  });

  it("rejects a NUL byte in `actor` — the third wireFreeFormString guard", () => {
    // Every other helper-composed field in the package carries this pin
    // explicitly (session-event.test.ts pins the envelope's own `actor` the
    // same way): an embedded NUL is a truncation vector at the wire/replay
    // trust boundary, so it must not survive into the log.
    //
    // The byte is BUILT at runtime rather than written as a unicode escape,
    // which is the one deviation from the sibling suites' spelling. A raw NUL
    // in the source makes ripgrep classify the file as binary and skip its
    // content matches, which silently breaks the repo's grep tooling; constructing it here keeps the assertion identical and the
    // file text-clean.
    const actorWithNulByte = `agent${String.fromCharCode(0)}injected`;
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        ...buildMountPayload(),
        actor: actorWithNulByte,
      }).success,
    ).toBe(false);
  });

  it("bounds `actor` at the envelope's own cap (EVENT_FIELD_MAX_LEN)", () => {
    // repo.ts restates the cap locally rather than importing it, because
    // importing from event.ts would close a module cycle (event.ts imports
    // the payload schema from repo.ts). A comment alone would be an
    // unenforced pin, so the equality is asserted HERE against the real
    // constant: at the cap it parses, one character over it does not. If the
    // envelope cap ever moves, this fails until repo.ts follows.
    const atCap = "a".repeat(EVENT_FIELD_MAX_LEN);
    const overCap = "a".repeat(EVENT_FIELD_MAX_LEN + 1);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: atCap })
        .success,
    ).toBe(true);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: overCap })
        .success,
    ).toBe(false);
  });

  it("round-trips through JSON without loss", () => {
    const firstPass = RepoWorkspaceLifecyclePayloadSchema.parse(buildWorkspacePayload());
    const secondPass = RepoWorkspaceLifecyclePayloadSchema.parse(
      JSON.parse(JSON.stringify(firstPass)) as unknown,
    );
    expect(secondPass).toStrictEqual(firstPass);
  });
});

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// The factory exists so can register five `worktree.*` types against this
// payload family WITHOUT editing repo.ts. What these tests pin is the
// property that makes that safe: each instantiation's accept set is exactly
// its own vocabulary, so the two never merge into one widened union.

// Stands in for the `WorktreeStateSchema` — the four worktree transitions
// plus `ready`, the only literal shared with either vocabulary.
const worktreeLikeStateSchema = z.enum(["creating", "ready", "dirty", "merged", "retired"]);
const worktreeLikePayloadSchema = buildRepoWorkspaceLifecyclePayloadSchema(worktreeLikeStateSchema);

describe("buildRepoWorkspaceLifecyclePayloadSchema (a parameter, not a third union arm)", () => {
  it.each(["creating", "ready", "dirty", "merged", "retired"])(
    "an instantiation accepts its own vocabulary: %s",
    (state) => {
      expect(worktreeLikePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success).toBe(
        true,
      );
    },
  );

  it.each(["attached", "detached", "preparing", "busy", "stale"])(
    "an instantiation REJECTS state a shared union would have admitted: %s",
    (state) => {
      // This is the finding. Adding `WorktreeStateSchema` as a third arm on
      // the shipped schema would have widened ALL eleven types at once, so a
      // `worktree.retired` payload could claim `state: "preparing"`.
      // Parameterizing keeps each plan's accept set exactly its own.
      expect(worktreeLikePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success).toBe(
        false,
      );
    },
  );

  it.each(["creating", "dirty", "merged", "retired"])(
    "the shipped instantiation stays disjoint the other way and rejects: %s",
    (state) => {
      // The reciprocal half — proven separately because a third arm would
      // have broken THIS direction, silently, and no existing test asserts a
      // worktree literal against the shipped schema.
      expect(
        RepoWorkspaceLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success,
      ).toBe(false);
    },
  );

  it("carries `.strict()` through the factory — unknown keys are still drift", () => {
    expect(
      worktreeLikePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        state: "merged",
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it("carries the family's non-state field contract through unchanged", () => {
    // Only `state` is parameterized; every other field must behave exactly as
    // it does on the shipped instantiation, or the factory has quietly forked
    // the family shape it exists to share.
    expect(
      worktreeLikePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        state: "merged",
        actor: USER_ID,
      }).success,
    ).toBe(true);
    // `sessionId` still required, still a UUID; `actor` still capped.
    expect(worktreeLikePayloadSchema.safeParse({ state: "merged" }).success).toBe(false);
    expect(
      worktreeLikePayloadSchema.safeParse({ sessionId: "nope", state: "merged" }).success,
    ).toBe(false);
    expect(
      worktreeLikePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        state: "merged",
        actor: "a".repeat(EVENT_FIELD_MAX_LEN + 1),
      }).success,
    ).toBe(false);
  });

  it("the shipped schema is itself an instantiation — same accept set as a hand-built twin", () => {
    // Pins the refactor's own claim: `RepoWorkspaceLifecyclePayloadSchema` is
    // now the factory applied to the two vocabularies, and nothing about its
    // accept set moved when it stopped being a literal `z.object`.
    const rebuilt = buildRepoWorkspaceLifecyclePayloadSchema(
      z.union([RepoMountStateSchema, WorkspaceStateSchema]),
    );
    for (const state of [
      "attached",
      "detached",
      "preparing",
      "ready",
      "busy",
      "stale",
      "archived",
    ]) {
      const candidate = { sessionId: SESSION_ID, state };
      expect(rebuilt.safeParse(candidate).success).toBe(
        RepoWorkspaceLifecyclePayloadSchema.safeParse(candidate).success,
      );
    }
    expect(rebuilt.safeParse({ sessionId: SESSION_ID, state: "merged" }).success).toBe(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state: "merged" })
        .success,
    );
  });
});

// --------------------------------------------------------------------------
// Union registration into SessionEventSchema.
// --------------------------------------------------------------------------

// Each registered type paired with the state its emitter actually writes —
// mount states for the `repo.*` pair, workspace states for the four
// `workspace.*` rows.
//
// The element type is load-bearing, not decoration (same stance as
// session-event.test.ts's `B18_MINTED_TYPES`). `SessionEvent["type"]` is the
// REGISTERED union's discriminant, narrower than the 156-literal census
// `SessionEventType`: if a later edit drops one of these six arms from
// `SessionEventSchema`, this fixture stops compiling under
// `tsc -p tsconfig.test.json` rather than silently thinning to a five-case
// runtime table. The state half binds to the payload union the same way.
const REGISTERED_REPO_EVENTS: ReadonlyArray<
  readonly [SessionEvent["type"], RepoMountState | WorkspaceState]
> = [
  ["repo.attached", "attached"],
  ["repo.detached", "detached"],
  ["workspace.preparing", "preparing"],
  ["workspace.ready", "ready"],
  ["workspace.stale", "stale"],
  ["workspace.archived", "archived"],
];

// `workspaces.repo_mount_id` is NOT NULL (mount-first single funnel), so
// every workspace row names its mount: the workspace fixtures carry BOTH
// ids and the mount fixtures carry only `repoMountId`.
const buildRepoEvent = (eventType: string, state: string) => ({
  id: "evt-repo-0001",
  sessionId: SESSION_ID,
  sequence: 7,
  occurredAt: "2026-07-24T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: eventType,
  actor: USER_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    repoMountId: REPO_MOUNT_ID,
    ...(eventType.startsWith("workspace.") ? { workspaceId: WORKSPACE_ID } : {}),
    state,
  },
});

describe("SessionEventSchema registration of the six variants", () => {
  it.each(REGISTERED_REPO_EVENTS)(
    "%s parses end-to-end through the union carrying state %s",
    (eventType, state) => {
      const parsed = SessionEventSchema.parse(buildRepoEvent(eventType, state));
      expect(parsed.type).toBe(eventType);
      expect(parsed.category).toBe("session_lifecycle");
      // The line above is self-referential on its own — the arm's own
      // `category: z.literal(...)` produced the value it checks, so it cannot
      // catch an arm literal that disagrees with the census. Cross-check
      // against the independent registry, which is what
      // `SESSION_EVENT_CATEGORY_BY_TYPE` exists for: `category` sits in the
      // RFC 8785 canonical bytes backing the hash chain, so an arm/census
      // disagreement would diverge at replay. Same leg the sibling suites
      // close for their own variants.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe("session_lifecycle");
      // The payload survives the union branch unchanged — no key added,
      // dropped, or coerced on the way through.
      expect(parsed.payload).toStrictEqual(buildRepoEvent(eventType, state).payload);
    },
  );

  it.each(REGISTERED_REPO_EVENTS)(
    "%s round-trips through JSON without loss",
    (eventType, state) => {
      const firstPass = SessionEventSchema.parse(buildRepoEvent(eventType, state));
      const secondPass = SessionEventSchema.parse(JSON.parse(JSON.stringify(firstPass)) as unknown);
      expect(secondPass).toStrictEqual(firstPass);
    },
  );

  it.each(REGISTERED_REPO_EVENTS)(
    "%s rejects a category/type mismatch (the canonical-bytes guard)",
    (eventType, state) => {
      // The per-variant `category: z.literal(...)` forbids cross-namespace
      // smuggling: `category` sits in the canonical bytes that back the hash
      // chain, so a mismatch hashed under the wrong category would diverge at
      // replay.
      const broken = {
        ...buildRepoEvent(eventType, state),
        category: "usage_telemetry" as const,
      };
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects a foreign payload smuggled onto a repo variant", () => {
    const broken = {
      ...buildRepoEvent("repo.attached", "attached"),
      payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown payload key on a repo variant (.strict() reaches the union branch)", () => {
    const event = buildRepoEvent("repo.attached", "attached");
    const broken = { ...event, payload: { ...event.payload, smuggled: "nope" } };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  // The forward-edge pin that lived here ("does not yet register family
  // member %s") flipped exactly as its comment designed when landed the five
  // `worktree.*` arms. Their registration state mapping, standalone-vs-union
  // agreement, and closed-registry boundary (`worktree.failed` stays
  // rejected) are covered by worktree.test.ts, which owns that contract.
  // One residue stays HERE because it pins THIS family's accept set: a
  // registered worktree arm carries the vocabulary, NOT this shared schema —
  // see the per-family disjointness rows above.
  it("still rejects a worktree TYPE carrying this family's payload builder with a repo-only subject", () => {
    // A `worktree.*` row must satisfy `WorktreeLifecyclePayloadSchema`; the
    // mount-shaped fixture (state: "attached") stays rejected even though
    // the type arm now exists — the union's registration did not loosen
    // vocabularies into the worktree arm.
    const brokenWorktreeRow = buildRepoEvent("worktree.created", "attached");
    expect(SessionEventSchema.safeParse(brokenWorktreeRow).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Wire surfaces — RepoAttach / RepoMountRead / RepoDetach.
// --------------------------------------------------------------------------
//
// The three request/response pairs for the MOUNT half of the six `repo.*`
// methods.

// A daemon-assigned OPAQUE scalar, deliberately NOT a UUID — the fixture uses
// a non-UUID value on purpose, and a dedicated row below pins that.
const NODE_ID = "node-alpha-01";

// The entered path and the resolved root DIFFER on purpose: attaching from a
// nested subdirectory is the canonical case (`local_path` keeps the
// provenance, `canonical_root` carries the resolver output). A fixture that
// made them equal could not catch a schema that conflated the two fields.
const LOCAL_PATH = "/Users/dev/projects/ai-sidekicks/packages/contracts";
const CANONICAL_ROOT = "/Users/dev/projects/ai-sidekicks";
const ATTACHED_AT = "2026-07-24T19:14:35.000Z";

const buildAttachRequest = () => ({
  localPath: LOCAL_PATH,
});

const buildAttachResponse = () => ({
  repoMountId: REPO_MOUNT_ID,
  state: "attached" as const,
  vcsType: "git" as const,
  canonicalRoot: CANONICAL_ROOT,
});

const buildMountReadResponse = () => ({
  id: REPO_MOUNT_ID,
  nodeId: NODE_ID,
  localPath: LOCAL_PATH,
  canonicalRoot: CANONICAL_ROOT,
  vcsType: "git" as const,
  state: "attached" as const,
  health: buildValidHealth(),
  attachedAt: ATTACHED_AT,
});

const buildDetachResponse = () => ({
  repoMountId: REPO_MOUNT_ID,
  state: "detached" as const,
  archivedWorkspaceIds: [WORKSPACE_ID],
});

// Override-parse helpers. The fixtures above stay explicit; these keep the
// assertion lines readable at a glance. The field-omission cases still
// `delete` the key directly, which no override form can express.
const parseAttachRequest = (overrides: Record<string, unknown> = {}) =>
  RepoAttachRequestSchema.safeParse({ ...buildAttachRequest(), ...overrides });
const parseAttachResponse = (overrides: Record<string, unknown> = {}) =>
  RepoAttachResponseSchema.safeParse({ ...buildAttachResponse(), ...overrides });
const parseMountReadResponse = (overrides: Record<string, unknown> = {}) =>
  RepoMountReadResponseSchema.safeParse({ ...buildMountReadResponse(), ...overrides });
const parseDetachResponse = (overrides: Record<string, unknown> = {}) =>
  RepoDetachResponseSchema.safeParse({ ...buildDetachResponse(), ...overrides });

describe("RepoAttachRequestSchema (the entered path)", () => {
  it("accepts a valid attach request", () => {
    expect(parseAttachRequest().success).toBe(true);
  });

  it("rejects an attach request with no `localPath`", () => {
    expect(RepoAttachRequestSchema.safeParse({}).success).toBe(false);
  });

  it("bounds `localPath` at FILE_PATH_MAX_LEN and refuses blank / NUL-byte forms", () => {
    const atCap = "/".repeat(FILE_PATH_MAX_LEN);
    const overCap = "/".repeat(FILE_PATH_MAX_LEN + 1);
    expect(parseAttachRequest({ localPath: atCap }).success).toBe(true);
    expect(parseAttachRequest({ localPath: overCap }).success).toBe(false);
    expect(parseAttachRequest({ localPath: "" }).success).toBe(false);
    expect(parseAttachRequest({ localPath: "   " }).success).toBe(false);
    // NUL is a truncation vector on a filesystem path, on top of the
    // log-injection vector `wireFreeFormString` documents. Built at runtime
    // rather than written as an escape so ripgrep keeps treating this file as
    // text — the same reason the `actor` pin above constructs it.
    const pathWithNulByte = `/safe/dir${String.fromCharCode(0)}/../../etc`;
    expect(parseAttachRequest({ localPath: pathWithNulByte }).success).toBe(false);
  });

  it.each([
    ["a relative path", "repos/ai-sidekicks"],
    ["a parent-traversal path", "../sibling/repo"],
    ["a Windows absolute path", "C:\\repos\\ai-sidekicks"],
    ["a tilde-prefixed path", "~/projects/repo"],
  ])("admits %s — the resolver canonicalizes, not the schema", (_label, candidate) => {
    // NEGATIVE CONTROL on the guards above. assigns resolution to the daemon
    // resolver, so the wire must be able to carry a path it has not seen yet.
    // Every row here would be refused by an absoluteness or traversal check
    // the schema deliberately does not make; without them the guards above
    // would read as "the schema validates paths", which is exactly the wrong
    // impression. The Windows row is V1-tier case that rules out a
    // `startsWith("/")` test outright.
    expect(parseAttachRequest({ localPath: candidate }).success).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseAttachRequest({ extra: "leak" }).success).toBe(false);
  });
});

describe("RepoAttachResponseSchema (resolved root required)", () => {
  it("accepts a valid attach response", () => {
    expect(parseAttachResponse().success).toBe(true);
  });

  it("rejects an attach response missing `canonicalRoot`", () => {
    // Resolution failure ABORTS attach with typed `repo.root_resolution_failed`,
    // so there is no partial success carrying an unresolved root.
    const broken = { ...buildAttachResponse() } as Record<string, unknown>;
    delete broken["canonicalRoot"];
    expect(RepoAttachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it.each(["attached", "detached", "archived"])(
    "carries the full RepoMountState vocabulary, not an `attached` literal — %s",
    (state) => {
      // The wire doc types this field `RepoMountState` with no narrowing and
      // carries NO per-value gloss on the attach response (unlike the detach
      // row, which does gloss `'detached'`). A `z.literal("attached")` would
      // silently reject the other two lawful states while passing every other
      // row in this block.
      expect(parseAttachResponse({ state }).success).toBe(true);
    },
  );

  it("still rejects a state outside the 3-value mount vocabulary", () => {
    // Negative control on the row above: non-narrowed is not unvalidated.
    expect(parseAttachResponse({ state: "exploded" }).success).toBe(false);
    // `stale` and `preparing` are WORKSPACE states and must not leak in.
    expect(parseAttachResponse({ state: "stale" }).success).toBe(false);
    expect(parseAttachResponse({ state: "preparing" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to `canonicalRoot`", () => {
    // GUARD-DOWNGRADE VISIBILITY — the response-side twin of the `localPath`
    // bounds row on the request. Re-spelling the resolver output as a bare
    // `z.string()` passes every other row in this block; these make it fail.
    expect(parseAttachResponse({ canonicalRoot: "" }).success).toBe(false);
    expect(parseAttachResponse({ canonicalRoot: "   " }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseAttachResponse({ extra: "leak" }).success).toBe(false);
  });
});

// COMPILE-TIME leg of the `unrepresentable-absent` row above: `canonicalRoot`
// is required on the TYPE, not merely at parse time. The runtime row proves
// the schema refuses the omission; this proves a consumer cannot construct one
// in the first place. Held in a never-invoked function so the pin does its
// whole job under the `tsconfig.test.json` typecheck leg, and the directive
// self-verifies: weaken the field to optional and TS reports the directive
// unused (TS2578), turning the leg red rather than silently dropping the pin.
// Co-located with its subject, the same placement as `brandNominalityPin`
// above.
const attachResponseRequiredFieldPins = (): void => {
  // @ts-expect-error — an attach response with no resolved canonical root.
  const missingCanonicalRoot: RepoAttachResponse = {
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
    state: "attached",
    vcsType: "git",
  };
  void missingCanonicalRoot;
};
void attachResponseRequiredFieldPins;

describe("RepoMountReadRequestSchema", () => {
  it("accepts a mount-read request and requires a canonical-UUID `repoMountId`", () => {
    const valid = { repoMountId: REPO_MOUNT_ID };
    expect(RepoMountReadRequestSchema.safeParse(valid).success).toBe(true);
    expect(RepoMountReadRequestSchema.safeParse({}).success).toBe(false);
    expect(RepoMountReadRequestSchema.safeParse({ repoMountId: "nope" }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    const broken = { repoMountId: REPO_MOUNT_ID, extra: "leak" };
    expect(RepoMountReadRequestSchema.safeParse(broken).success).toBe(false);
  });
});

describe("RepoMountReadResponseSchema (canonical root + VCS metadata + current health)", () => {
  it("accepts a valid mount-read projection", () => {
    expect(parseMountReadResponse().success).toBe(true);
  });

  it("names the mount key `id`, not `repoMountId` — the read-projection convention", () => {
    // The wire doc uses the bare `id` on read projections and the qualified
    // name on mutation responses. Pinned in BOTH directions by one fixture: a
    // renamed projection loses its required `id` AND trips `.strict()` on the
    // unknown `repoMountId`, so a "helpful" rename cannot pass.
    const renamed = { ...buildMountReadResponse() } as Record<string, unknown>;
    delete renamed["id"];
    renamed["repoMountId"] = REPO_MOUNT_ID;
    expect(RepoMountReadResponseSchema.safeParse(renamed).success).toBe(false);
  });

  // All EIGHT projection fields, enumerated exhaustively rather than by
  // representative: a field quietly turned optional in a later phase would
  // otherwise pass a partial list.
  it.each([
    "id",
    "nodeId",
    "localPath",
    "canonicalRoot",
    "vcsType",
    "state",
    "health",
    "attachedAt",
  ])("requires %s", (field) => {
    const broken = { ...buildMountReadResponse() } as Record<string, unknown>;
    delete broken[field];
    expect(RepoMountReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("types `nodeId` as the daemon-assigned OPAQUE scalar, not a UUID", () => {
    // `NodeIdSchema` (declared in node-id.ts) deliberately departs from the
    // UUID parser the branded repo ids use. Composing a UUID-branded schema
    // here by mistake would satisfy every other row in this block — only this
    // one catches it.
    expect(parseMountReadResponse({ nodeId: "cli-daemon@host.local" }).success).toBe(true);
  });

  it("rejects out-of-vocabulary `vcsType` and `state` through the composition", () => {
    // The composed-enum leg, the same argument as the `health.status` rows
    // below: driven through the RESPONSE, these prove the projection composes
    // the canonical enums instead of re-spelling widened unions of its own.
    // `hg` is the VCS a re-spell would plausibly admit; `preparing` is a
    // WORKSPACE state — the cross-vocabulary trap the attach block pins with
    // `stale`, and the reason `RepoMountState` and `WorkspaceState` must not be
    // conflated even though both carry an `archived` member.
    expect(parseMountReadResponse({ vcsType: "hg" }).success).toBe(false);
    expect(parseMountReadResponse({ state: "preparing" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to both response-side path fields", () => {
    // GUARD-DOWNGRADE VISIBILITY. Re-spelling either field as a bare
    // `z.string()` passes every other row in this block, because nothing else
    // here feeds these fields a blank value — the helper's non-empty,
    // whitespace-only, and NUL guards would silently disappear. These rows are
    // what make that downgrade fail.
    expect(parseMountReadResponse({ localPath: "" }).success).toBe(false);
    expect(parseMountReadResponse({ canonicalRoot: "" }).success).toBe(false);
  });

  it.each([
    ["healthy", true],
    ["unreachable", true],
    // Outside the 2-value union: `unknown` is the member rejects (the on-read
    // probe floor means every read carries a fresh verdict), and `stale` is
    // the workspace-state overload it chose `unreachable` to avoid.
    ["unknown", false],
    ["stale", false],
  ])("health.status %s -> %s, driven through the composed response", (status, shouldPass) => {
    // Driven through the COMPOSITION rather than through `RepoMountHealthSchema`
    // standalone (already covered above): this is what proves the read response
    // composes the canonical projection instead of re-spelling
    // `{status, checkedAt}` with a widened status of its own.
    const health = { ...buildValidHealth(), status };
    expect(parseMountReadResponse({ health }).success).toBe(shouldPass);
  });

  it("keeps `localPath` and `canonicalRoot` independent", () => {
    const parsed = RepoMountReadResponseSchema.parse(buildMountReadResponse());
    expect(parsed.localPath).toBe(LOCAL_PATH);
    expect(parsed.canonicalRoot).toBe(CANONICAL_ROOT);
    // Distinct values in the fixture (subdirectory attach), so a schema that
    // read one field into the other fails here rather than passing silently.
    expect(parsed.localPath).not.toBe(parsed.canonicalRoot);
  });

  it("requires `attachedAt` to be an ISO-8601 instant, and admits a numeric offset", () => {
    expect(parseMountReadResponse({ attachedAt: "yesterday" }).success).toBe(false);
    const withOffset = "2026-07-24T14:14:35.000-05:00";
    expect(parseMountReadResponse({ attachedAt: withOffset }).success).toBe(true);
  });

  it("round-trips through JSON without loss", () => {
    const firstPass = RepoMountReadResponseSchema.parse(buildMountReadResponse());
    const secondPass = RepoMountReadResponseSchema.parse(
      JSON.parse(JSON.stringify(firstPass)) as unknown,
    );
    expect(secondPass).toStrictEqual(firstPass);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseMountReadResponse({ extra: "leak" }).success).toBe(false);
  });
});

describe("RepoDetach request/response", () => {
  it("accepts a detach request and requires `repoMountId`", () => {
    const valid = { repoMountId: REPO_MOUNT_ID };
    expect(RepoDetachRequestSchema.safeParse(valid).success).toBe(true);
    expect(RepoDetachRequestSchema.safeParse({}).success).toBe(false);
    const broken = { ...valid, extra: "leak" };
    expect(RepoDetachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts the cascade response", () => {
    expect(parseDetachResponse().success).toBe(true);
  });

  it("accepts an EMPTY archivedWorkspaceIds array — a no-dependent cascade", () => {
    // Not degenerate: a mount whose dependent workspaces were all already
    // `archived` archives none, which is why the schema carries no `.min(1)`
    // even though guarantees attach created one workspace.
    expect(parseDetachResponse({ archivedWorkspaceIds: [] }).success).toBe(true);
  });

  it("accepts one id per dependent workspace the cascade archived", () => {
    const ids = [WORKSPACE_ID, "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f21"];
    expect(parseDetachResponse({ archivedWorkspaceIds: ids }).success).toBe(true);
  });

  it("rejects a non-UUID member of archivedWorkspaceIds", () => {
    const ids = [WORKSPACE_ID, "workspace-2"];
    expect(parseDetachResponse({ archivedWorkspaceIds: ids }).success).toBe(false);
  });

  it("requires archivedWorkspaceIds — an absent list is not an empty one", () => {
    const broken = { ...buildDetachResponse() } as Record<string, unknown>;
    delete broken["archivedWorkspaceIds"];
    expect(RepoDetachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it.each(["attached", "detached", "archived"])(
    "carries the full RepoMountState vocabulary, not a `detached` literal — %s",
    (state) => {
      // Same stance as the attach response: the wire doc's `// 'detached'` is a
      // gloss on the value the daemon writes, not a contract narrowing.
      expect(parseDetachResponse({ state }).success).toBe(true);
    },
  );

  it("rejects extraneous keys on the response (.strict() guard)", () => {
    expect(parseDetachResponse({ extra: "leak" }).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Compile-time pins.
// --------------------------------------------------------------------------
//
// Annotation-only assignments, validated by the `tsconfig.test.json`
// typecheck leg rather than by a runtime assertion.

// The payload MUST stay assignable to `Record<string, unknown>` — that is
// what lets the six variant interfaces in event.ts narrow
// `EventEnvelope.payload`. It holds because `RepoWorkspaceLifecyclePayload`
// is a TYPE ALIAS: TypeScript grants an object type alias an implicit index
// signature but grants an interface none. Re-declaring it as an interface
// would fail HERE with a clear message, ahead of the more obscure failure at
// the `extends EventEnvelope` site.
//
// The right-hand side is a PARSE RESULT, not an object literal: a literal
// would carry its own implicit index signature and satisfy the annotation
// whatever the alias is declared as, making the pin vacuous. `.parse()`
// returns a value typed exactly `RepoWorkspaceLifecyclePayload`, so the
// assignment tests the DECLARED type.
const parsedLifecyclePayload: RepoWorkspaceLifecyclePayload =
  RepoWorkspaceLifecyclePayloadSchema.parse({
    sessionId: SESSION_ID,
    state: "attached",
  });
const payloadNarrowsTheEnvelope: Record<string, unknown> = parsedLifecyclePayload;
void payloadNarrowsTheEnvelope;

// One representative field per surface, spelled with only this module's
// exported types — `RepoAttachResponse.state` / `.vcsType`,
// `RepoMountReadResponse.health`,
// `RepoDetachResponse.archivedWorkspaceIds`,
// `WorkspaceBindRequest.executionMode`,
// `WorkspaceExecutionModeCapabilitiesReadResponse.availableModes` /
// `.restrictions`, and `WorkspaceListResponse.workspaces[].state`. assemble
// the full request/response shapes; this pin proves the vocabulary is
// complete before they do.
const sixWireSurfacesTypeFromThisModuleAlone: {
  attachState: RepoMountState;
  attachVcsType: VcsType;
  mountReadHealth: RepoMountHealth;
  detachArchivedWorkspaceIds: WorkspaceId[];
  bindExecutionMode: ExecutionMode;
  capabilitiesAvailableModes: ExecutionMode[];
  capabilitiesRestrictions: Partial<Record<ExecutionMode, string>>;
  listWorkspaceState: WorkspaceState;
} = {
  attachState: RepoMountStateSchema.parse("attached"),
  attachVcsType: VcsTypeSchema.parse("git"),
  mountReadHealth: RepoMountHealthSchema.parse(buildValidHealth()),
  detachArchivedWorkspaceIds: [WorkspaceIdSchema.parse(WORKSPACE_ID)],
  bindExecutionMode: ExecutionModeSchema.parse("bound-root"),
  capabilitiesAvailableModes: [ExecutionModeSchema.parse("bound-root")],
  capabilitiesRestrictions: { "provisioned-worktree": "worktree provisioning unavailable" },
  listWorkspaceState: WorkspaceStateSchema.parse("stale"),
};
void sixWireSurfacesTypeFromThisModuleAlone;

// --------------------------------------------------------------------------
// Barrel re-export regression guard.
// --------------------------------------------------------------------------

// What the standalone `*EventSchema` rows below need of a schema. Structural
// because the six exports have six distinct output types and this is the whole
// surface the rows drive; a `z.ZodType<…>` column would need a common type
// argument the variants do not share.
interface StandaloneEventSchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

// The six standalone event-variant exports, paired with the state their
// emitter writes and read THROUGH the barrel — this block's subject. Same
// explicitly-typed shape as `REGISTERED_REPO_EVENTS` above and for the same
// reason: the `SessionEvent["type"]` column stops compiling if an arm ever
// leaves the union.
const STANDALONE_REPO_EVENT_SCHEMAS: ReadonlyArray<
  readonly [SessionEvent["type"], RepoMountState | WorkspaceState, StandaloneEventSchema]
> = [
  ["repo.attached", "attached", contracts.RepoAttachedEventSchema],
  ["repo.detached", "detached", contracts.RepoDetachedEventSchema],
  ["workspace.preparing", "preparing", contracts.WorkspacePreparingEventSchema],
  ["workspace.ready", "ready", contracts.WorkspaceReadyEventSchema],
  ["workspace.stale", "stale", contracts.WorkspaceStaleEventSchema],
  ["workspace.archived", "archived", contracts.WorkspaceArchivedEventSchema],
];

// A LAWFUL event of a DIFFERENT registered variant, for the discriminator pin
// below. `archived` is the one state both vocabularies carry, so the
// substitute parses under the union whichever row asks for it.
const buildSiblingRepoEvent = (eventType: SessionEvent["type"]) =>
  buildRepoEvent(eventType === "repo.attached" ? "workspace.ready" : "repo.attached", "archived");

describe("index.ts re-exports contract core", () => {
  // The barrel-gap regression: a module can be
  // complete and still invisible to consumers if the `export * from
  // "./repo.js"` line is missing or dropped in a later refactor. Importing
  // through `../index.js` (not `../repo.js`) is what makes this exercise the
  // re-export layer — the same reason anti-leakage.test.ts imports through
  // the barrel.
  it.each([
    ["RepoMountIdSchema", contracts.RepoMountIdSchema],
    ["WorkspaceIdSchema", contracts.WorkspaceIdSchema],
    ["ExecutionModeSchema", contracts.ExecutionModeSchema],
    ["WorkspaceStateSchema", contracts.WorkspaceStateSchema],
    ["RepoMountStateSchema", contracts.RepoMountStateSchema],
    ["VcsTypeSchema", contracts.VcsTypeSchema],
    ["RepoMountHealthSchema", contracts.RepoMountHealthSchema],
    ["RepoWorkspaceLifecyclePayloadSchema", contracts.RepoWorkspaceLifecyclePayloadSchema],
    // The six wire surfaces (the MOUNT half).
    ["RepoAttachRequestSchema", contracts.RepoAttachRequestSchema],
    ["RepoAttachResponseSchema", contracts.RepoAttachResponseSchema],
    ["RepoMountReadRequestSchema", contracts.RepoMountReadRequestSchema],
    ["RepoMountReadResponseSchema", contracts.RepoMountReadResponseSchema],
    ["RepoDetachRequestSchema", contracts.RepoDetachRequestSchema],
    ["RepoDetachResponseSchema", contracts.RepoDetachResponseSchema],
  ] as const)("re-exports %s with a callable .parse", (_name, schema) => {
    expect(schema).toBeDefined();
    expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
  });

  it("resolves the NodeId symbols through the barrel to node-id.ts's instances", () => {
    // `NodeIdSchema` and `NODE_ID_MAX_LEN` live in the dependency-free leaf
    // node-id.ts, which repo.ts and event.ts import directly. This asserts the
    // barrel lands on the very same instance, so no consumer can end up
    // holding two schemas under one name.
    expect(contracts.NodeIdSchema).toBe(NodeIdSchema);
    expect(contracts.NODE_ID_MAX_LEN).toBe(NODE_ID_MAX_LEN);
    expect(contracts.NodeIdSchema.safeParse(NODE_ID).success).toBe(true);
  });

  it("resolves the same schema through the barrel and the module (no shadow copy)", () => {
    // Identity, not just presence: a re-export that resolved to a different
    // instance would mean two schemas sharing one name.
    expect(contracts.ExecutionModeSchema).toBe(ExecutionModeSchema);
    expect(contracts.RepoWorkspaceLifecyclePayloadSchema).toBe(RepoWorkspaceLifecyclePayloadSchema);
  });

  // The six event-variant exports get BEHAVIORAL coverage rather than the
  // callable-`.parse` shape check the schema table above uses, because they
  // are the one surface in this package that is spelled TWICE: event.ts
  // declares each `*EventSchema` const, then rebuilds every variant inline for
  // `z.discriminatedUnion` (the literal-typed arm `z.ZodType<T>` erases). A
  // shape check is green under any drift between the two spellings; these rows
  // fail on it.
  it.each(STANDALONE_REPO_EVENT_SCHEMAS)(
    "%s parses its own valid event through the standalone export, matching the union",
    (eventType, state, schema) => {
      const event = buildRepoEvent(eventType, state);
      // Agreement in BOTH directions at once: a const the union arm would
      // refuse fails on the right-hand parse, and an arm the const would refuse
      // fails on the left — and a difference in what either surface keeps shows
      // up as an inequality rather than as two independently green parses.
      expect(schema.parse(event)).toStrictEqual(SessionEventSchema.parse(event));
    },
  );

  it.each(STANDALONE_REPO_EVENT_SCHEMAS)(
    "%s refuses a sibling variant's event — the const's own `type` literal is load-bearing",
    (eventType, _state, schema) => {
      // The sharpest discriminator pin available: a lawful event of another
      // REGISTERED variant, so the only thing that can refuse it is this
      // const's own literal. The union control on the line below is what makes
      // that argument hold — without it the refusal could be a malformed
      // fixture rejecting for an unrelated reason.
      const siblingEvent = buildSiblingRepoEvent(eventType);
      expect(SessionEventSchema.safeParse(siblingEvent).success).toBe(true);
      expect(schema.safeParse(siblingEvent).success).toBe(false);
    },
  );

  it.each(STANDALONE_REPO_EVENT_SCHEMAS)(
    "%s refuses a category mismatch and an unknown payload key on its own event",
    (eventType, state, schema) => {
      const event = buildRepoEvent(eventType, state);
      // `category` sits in the RFC 8785 canonical bytes backing the hash chain,
      // so a variant that accepted a mismatched one would hash under the wrong
      // category at replay. Pinned on the union above; pinned here on the
      // standalone surface, which is what Phase 2 emitters validate against.
      expect(schema.safeParse({ ...event, category: "usage_telemetry" }).success).toBe(false);
      // `.strict()` reaches the shared payload schema through this surface too.
      expect(
        schema.safeParse({ ...event, payload: { ...event.payload, smuggled: "nope" } }).success,
      ).toBe(false);
    },
  );

  it("re-exports the very same event-variant instances as event.ts (no shadow copy)", () => {
    // Identity, the same leg the contract-schema block above closes: the rows
    // above drive the BARREL values, and this is what ties their verdicts to
    // the declarations in event.ts rather than to a second instance.
    expect(contracts.RepoAttachedEventSchema).toBe(RepoAttachedEventSchema);
    expect(contracts.RepoDetachedEventSchema).toBe(RepoDetachedEventSchema);
    expect(contracts.WorkspacePreparingEventSchema).toBe(WorkspacePreparingEventSchema);
    expect(contracts.WorkspaceReadyEventSchema).toBe(WorkspaceReadyEventSchema);
    expect(contracts.WorkspaceStaleEventSchema).toBe(WorkspaceStaleEventSchema);
    expect(contracts.WorkspaceArchivedEventSchema).toBe(WorkspaceArchivedEventSchema);
  });
});
