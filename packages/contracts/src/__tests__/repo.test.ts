// `repo.ts` contract core: branded ids, the canonical repo and workspace enums, the derived
// `RepoMountHealth` projection, the shared lifecycle event payload, and its registration into
// `SessionEventSchema`. The `worktree.*` half of the family is covered by worktree.test.ts.
// `VcsTypeSchema` is pinned closed at `git`: attach refuses a path that is not a git repository.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EVENT_FIELD_MAX_LEN } from "../event-envelope.js";
import {
  RepoAttachedEventSchema,
  RepoDetachedEventSchema,
  WorkspaceArchivedEventSchema,
  WorkspacePreparingEventSchema,
  WorkspaceReadyEventSchema,
  WorkspaceStaleEventSchema,
} from "../event-declared-variants.js";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "../event.js";
import { SessionEventSchema } from "../event.js";
import type { SessionEvent } from "../event-variant-types.js";
import * as contracts from "../index.js";
import { NODE_ID_MAX_LEN, NodeIdSchema } from "../node-id.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  ExecutionModeSchema,
  RepoMountHealthSchema,
  RepoMountIdSchema,
  RepoMountStateSchema,
  RepoWorkspaceLifecyclePayloadSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoMountHealth,
  type RepoMountId,
  type RepoMountState,
  type RepoWorkspaceLifecyclePayload,
  type VcsType,
  type WorkspaceId,
  type WorkspaceState,
} from "../repo.js";

// Real RFC 9562 UUIDs (v4 and v7); the branded-id schema checks the version and variant bits.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const CHECKED_AT = "2026-07-24T19:14:35.000Z";
const VERSION = "1.0";

// Canonical enums.
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
    // Read `.options` through a cast (as session-event.test.ts does for `EventCategorySchema`):
    // the `z.ZodType<ExecutionMode>` annotation erases the enum type.
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
    // `detached` is a mount state and `unreachable` a mount-health status; neither may leak in.
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
    // `preparing` and `stale` are workspace states; a mount is never in them.
    ["preparing", false],
    ["stale", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(RepoMountStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("VcsTypeSchema (git only)", () => {
  it.each([
    ["git", true],
    // The discriminator stays closed at `git`: an "unknown" or "pending" value would let a
    // resolver defer the verdict, and a sibling VCS would appear without git capabilities.
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
    // A tolerant arm would let an arbitrary string parse.
    expect(VcsTypeSchema.safeParse("anything-else").success).toBe(false);
  });
});

// Branded ids.
describe("RepoMountIdSchema / WorkspaceIdSchema (branded UUID scalars)", () => {
  it.each([
    ["RepoMountIdSchema", RepoMountIdSchema],
    ["WorkspaceIdSchema", WorkspaceIdSchema],
  ] as const)("%s accepts a canonical UUID and rejects a non-UUID", (_label, schema) => {
    expect(schema.safeParse(REPO_MOUNT_ID).success).toBe(true);
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
    // A UUID-shaped string with a zero version nibble: the check covers version and variant
    // bits, not only length and hyphens.
    expect(schema.safeParse("0190f8a0-7e2d-0c4a-9b1c-1b7c5b3e8f10").success).toBe(false);
  });
});

// Compile-time pin on the brand, checked by the `tsconfig.test.json` typecheck. If the brand
// weakens to a bare `string`, TS reports the directive unused (TS2578).
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a RepoMountId without a parse.
  const unbranded: RepoMountId = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
  void unbranded;
};
void brandNominalityPin;

// RepoMountHealth, the derived projection.
const buildValidHealth = () => ({
  status: "healthy" as const,
  checkedAt: CHECKED_AT,
});

describe("RepoMountHealthSchema (derived projection, never persisted)", () => {
  it.each([
    ["healthy", true],
    ["unreachable", true],
    // A reachable root whose re-derived common directory no longer equals the attach-time
    // anchor; a mount whose binds already refuse must not still project `healthy`.
    ["identity_mismatch", true],
    // Outside the three-value union: every read carries a fresh verdict, so there is no
    // `unknown`, and `stale` is a workspace state.
    ["unknown", false],
    ["stale", false],
    ["degraded", false],
    // Near-miss spellings of `identity_mismatch`.
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
    // The package-wide datetime convention: RFC 3339 with an offset, not only Z-suffixed UTC.
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

// RepoWorkspaceLifecyclePayload, the family-shared payload.
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
    // Every subject id is optional, so these two members are the whole floor.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        state: "attached",
      }).success,
    ).toBe(true);
  });

  it("accepts every subject id together — the detach cascade names more than one", () => {
    // No "exactly one id" rule, deliberately: a `workspace.archived` from the detach cascade
    // names both the mount that caused it and the workspace it archived.
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
    // Both vocabularies are in the union: mount states for `repo.*` rows, workspace states for
    // `workspace.*` rows.
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
      // The worktree family instantiates the payload factory in worktree.ts instead of widening
      // this schema, so a worktree state is never admitted here. The accept half lives in
      // worktree.test.ts against `WorktreeLifecyclePayloadSchema`.
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
    // Unbranded is still validated: the same RFC 9562 text form the branded ids use.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: "worktree-1",
        state: "ready",
      }).success,
    ).toBe(false);
    // The member must use the same predicate as the branded ids (`uuidTextFormSchema`). The
    // upper-case sentinel tells them apart: Zod's own `z.uuid()` refuses it, the shared
    // predicate accepts it.
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
    // As with `EventEnvelope.actor`: a system event uses `null` or omits the key; an empty
    // actor is a producer bug.
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
    // Interior whitespace is fine; `wireFreeFormString` rejects only whitespace-only values.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        ...buildMountPayload(),
        actor: "agent alpha",
      }).success,
    ).toBe(true);
  });

  it("rejects a NUL byte in `actor` — the third wireFreeFormString guard", () => {
    // An embedded NUL is a truncation vector at the wire and replay boundary, so it must not
    // reach the log. The byte is built at runtime because a raw NUL in the source makes
    // ripgrep treat the file as binary.
    const actorWithNulByte = `agent${String.fromCharCode(0)}injected`;
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        ...buildMountPayload(),
        actor: actorWithNulByte,
      }).success,
    ).toBe(false);
  });

  it("bounds `actor` at the envelope's own cap (EVENT_FIELD_MAX_LEN)", () => {
    // repo.ts restates the cap because importing it from event.ts would close a module cycle.
    // This test holds the two equal: if the envelope cap moves, it fails until repo.ts follows.
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

// The payload factory lets the `worktree.*` types reuse this family without editing repo.ts.
// Each instantiation accepts exactly its own vocabulary; the vocabularies never merge.

// Stands in for the worktree states: four transitions plus `ready`, the only literal shared
// with either vocabulary.
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
      // A shared third union arm would widen every type at once, so a `worktree.retired`
      // payload could claim `state: "preparing"`.
      expect(worktreeLikePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success).toBe(
        false,
      );
    },
  );

  it.each(["creating", "dirty", "merged", "retired"])(
    "the shipped instantiation stays disjoint the other way and rejects: %s",
    (state) => {
      // The reverse direction: a shared third arm would break this one too.
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
    // Only `state` is parameterized; every other field behaves as on the shipped schema.
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
    // `RepoWorkspaceLifecyclePayloadSchema` is the factory applied to the two vocabularies.
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

// Union registration into SessionEventSchema.
// Each registered type paired with the state its emitter writes. `SessionEvent["type"]` is the
// registered union's discriminant, so dropping one of these arms from `SessionEventSchema`
// breaks compilation under `tsc -p tsconfig.test.json` instead of silently shrinking the table.
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

// `workspaces.repo_mount_id` is NOT NULL, so workspace fixtures carry both ids and mount
// fixtures only `repoMountId`.
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
      // The line above reads the arm's own literal, so it cannot catch a disagreement with the
      // registry. `category` is part of the canonical bytes behind the hash chain, so a
      // disagreement would diverge at replay.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe("session_lifecycle");
      // The payload passes through the union branch unchanged.
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
      // A mismatched category would hash under the wrong category and diverge at replay.
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
      payload: { sessionId: SESSION_ID, shape: "chat" },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown payload key on a repo variant (.strict() reaches the union branch)", () => {
    const event = buildRepoEvent("repo.attached", "attached");
    const broken = { ...event, payload: { ...event.payload, smuggled: "nope" } };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("still rejects a worktree TYPE carrying this family's payload builder with a repo-only subject", () => {
    // A `worktree.*` row must satisfy `WorktreeLifecyclePayloadSchema`, so a mount-shaped
    // payload (state "attached") is rejected.
    const brokenWorktreeRow = buildRepoEvent("worktree.created", "attached");
    expect(SessionEventSchema.safeParse(brokenWorktreeRow).success).toBe(false);
  });
});

// A daemon-assigned opaque node id, deliberately not a UUID.
const NODE_ID = "node-alpha-01";

// Compile-time pins, checked by the `tsconfig.test.json` typecheck rather than at runtime.

// The payload must stay assignable to `Record<string, unknown>` so event.ts can narrow
// `EventEnvelope.payload`. That holds because it is a type alias, which gets an implicit index
// signature; an interface would not. The right-hand side is a parse result, not a literal: a
// literal would satisfy the annotation whatever the alias is.
const parsedLifecyclePayload: RepoWorkspaceLifecyclePayload =
  RepoWorkspaceLifecyclePayloadSchema.parse({
    sessionId: SESSION_ID,
    state: "attached",
  });
const payloadNarrowsTheEnvelope: Record<string, unknown> = parsedLifecyclePayload;
void payloadNarrowsTheEnvelope;

// One representative field per wire surface (`RepoAttachResponse`, `RepoMountReadResponse`,
// `RepoDetachResponse`, `WorkspaceBindRequest`, the execution-mode capabilities response and
// `WorkspaceListResponse`), typed with this module's exports alone.
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

// Barrel re-export guard.
// What the rows below need of a schema; structural because the six exports have distinct
// output types.
interface StandaloneEventSchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

// The six standalone event-variant exports read through the barrel, paired with the state
// their emitter writes.
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

// A valid event of a different registered variant. `archived` is the one state both
// vocabularies carry, so the substitute parses under the union for every row.
const buildSiblingRepoEvent = (eventType: SessionEvent["type"]) =>
  buildRepoEvent(eventType === "repo.attached" ? "workspace.ready" : "repo.attached", "archived");

describe("index.ts re-exports contract core", () => {
  // A module is invisible to consumers if the barrel's `export * from "./repo.js"` line is
  // missing; importing through `../index.js` exercises that layer.
  it.each([
    ["RepoMountIdSchema", contracts.RepoMountIdSchema],
    ["WorkspaceIdSchema", contracts.WorkspaceIdSchema],
    ["ExecutionModeSchema", contracts.ExecutionModeSchema],
    ["WorkspaceStateSchema", contracts.WorkspaceStateSchema],
    ["RepoMountStateSchema", contracts.RepoMountStateSchema],
    ["VcsTypeSchema", contracts.VcsTypeSchema],
    ["RepoMountHealthSchema", contracts.RepoMountHealthSchema],
    ["RepoWorkspaceLifecyclePayloadSchema", contracts.RepoWorkspaceLifecyclePayloadSchema],
  ] as const)("re-exports %s with a callable .parse", (_name, schema) => {
    expect(schema).toBeDefined();
    expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
  });

  it("resolves the NodeId symbols through the barrel to node-id.ts's instances", () => {
    // The barrel must resolve to the same instances as the dependency-free leaf node-id.ts
    // that repo-folders.ts and event-declared-variants.ts import.
    expect(contracts.NodeIdSchema).toBe(NodeIdSchema);
    expect(contracts.NODE_ID_MAX_LEN).toBe(NODE_ID_MAX_LEN);
    expect(contracts.NodeIdSchema.safeParse(NODE_ID).success).toBe(true);
  });

  it("resolves the same schema through the barrel and the module (no shadow copy)", () => {
    // Identity, not presence: a different instance would mean two schemas under one name.
    expect(contracts.ExecutionModeSchema).toBe(ExecutionModeSchema);
    expect(contracts.RepoWorkspaceLifecyclePayloadSchema).toBe(RepoWorkspaceLifecyclePayloadSchema);
  });

  // The event-variant exports are declared twice in event.ts (each `*EventSchema` const, then
  // rebuilt inline for `z.discriminatedUnion`), so these rows check behavior; a shape check
  // would pass despite drift between the two.
  it.each(STANDALONE_REPO_EVENT_SCHEMAS)(
    "%s parses its own valid event through the standalone export, matching the union",
    (eventType, state, schema) => {
      const event = buildRepoEvent(eventType, state);
      // Checks agreement both ways, and any difference in what each surface keeps.
      expect(schema.parse(event)).toStrictEqual(SessionEventSchema.parse(event));
    },
  );

  it.each(STANDALONE_REPO_EVENT_SCHEMAS)(
    "%s refuses a sibling variant's event — the const's own `type` literal is load-bearing",
    (eventType, _state, schema) => {
      // Only this const's own `type` literal can refuse a valid event of another variant; the
      // union parse below shows the fixture itself is valid.
      const siblingEvent = buildSiblingRepoEvent(eventType);
      expect(SessionEventSchema.safeParse(siblingEvent).success).toBe(true);
      expect(schema.safeParse(siblingEvent).success).toBe(false);
    },
  );

  it.each(STANDALONE_REPO_EVENT_SCHEMAS)(
    "%s refuses a category mismatch and an unknown payload key on its own event",
    (eventType, state, schema) => {
      const event = buildRepoEvent(eventType, state);
      // A mismatched category would hash under the wrong category at replay; the standalone
      // surface is what emitters validate against.
      expect(schema.safeParse({ ...event, category: "usage_telemetry" }).success).toBe(false);
      // `.strict()` reaches the shared payload schema through this surface too.
      expect(
        schema.safeParse({ ...event, payload: { ...event.payload, smuggled: "nope" } }).success,
      ).toBe(false);
    },
  );

  it("re-exports the very same event-variant instances as event.ts (no shadow copy)", () => {
    // The rows above drive the barrel values; identity ties them to the declarations in event.ts.
    expect(contracts.RepoAttachedEventSchema).toBe(RepoAttachedEventSchema);
    expect(contracts.RepoDetachedEventSchema).toBe(RepoDetachedEventSchema);
    expect(contracts.WorkspacePreparingEventSchema).toBe(WorkspacePreparingEventSchema);
    expect(contracts.WorkspaceReadyEventSchema).toBe(WorkspaceReadyEventSchema);
    expect(contracts.WorkspaceStaleEventSchema).toBe(WorkspaceStaleEventSchema);
    expect(contracts.WorkspaceArchivedEventSchema).toBe(WorkspaceArchivedEventSchema);
  });
});
