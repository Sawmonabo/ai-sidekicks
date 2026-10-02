// `repo.ts`: the repo and workspace enums accept only their own members, the ids are UUIDs, a
// mount's health carries a verdict from its set and when it was checked, the package root exports
// the contract core, a raw string is not a branded mount id, and each instantiation of the
// lifecycle payload factory accepts only its own state vocabulary.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "../index.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  ExecutionModeSchema,
  RepoMountHealthSchema,
  RepoMountIdSchema,
  RepoMountStateSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type RepoMountId,
} from "../repo.js";

// Real RFC 9562 UUIDs; the branded-id schemas check the version and variant bits.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const CHECKED_AT = "2026-07-24T19:14:35.000Z";

describe("ExecutionModeSchema", () => {
  it.each([
    ["bound-root", true],
    ["provisioned-worktree", true],
    ["submodule", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(ExecutionModeSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("WorkspaceStateSchema", () => {
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

describe("RepoMountStateSchema", () => {
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

// Attach refuses a folder that is not a git repository, so no mount can describe one.
describe("VcsTypeSchema (git only)", () => {
  it.each([
    ["git", true],
    // An "unknown" or "pending" value would let a resolver defer the verdict, and a sibling VCS
    // would appear without git capabilities.
    ["unknown", false],
    ["pending", false],
    ["hg", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(VcsTypeSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("admits exactly one member, with no second value and no passthrough", () => {
    const schemaInternals = VcsTypeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options]).toEqual(["git"]);
    expect(VcsTypeSchema.safeParse("anything-else").success).toBe(false);
  });
});

describe("RepoMountIdSchema / WorkspaceIdSchema", () => {
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

describe("RepoMountHealthSchema", () => {
  const health = { status: "healthy", checkedAt: CHECKED_AT };

  it.each([
    ["healthy", true],
    ["unreachable", true],
    // A reachable root whose git common directory no longer equals the attach-time anchor.
    ["identity_mismatch", true],
    // Every read carries a fresh verdict, so there is no `unknown`; `stale` is a workspace state.
    ["unknown", false],
    ["stale", false],
    ["degraded", false],
    ["identity-mismatch", false],
    ["identityMismatch", false],
  ])("status %s -> %s", (status, shouldPass) => {
    expect(RepoMountHealthSchema.safeParse({ ...health, status }).success).toBe(shouldPass);
  });

  it("requires `checkedAt`, since a verdict with no probe time cannot be audited", () => {
    const { checkedAt: _checkedAt, ...withoutCheckedAt } = health;
    expect(RepoMountHealthSchema.safeParse(withoutCheckedAt).success).toBe(false);
  });
});

// A name the package root does not export is invisible to every consumer of the package.
describe("the package root re-exports the contract core", () => {
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
});

// Compile-time pin on the brand, checked by the `tsconfig.test.json` typecheck. If the brand
// weakens to a bare `string`, TS reports the directive unused (TS2578).
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a RepoMountId without a parse.
  const unbranded: RepoMountId = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
  void unbranded;
};
void brandNominalityPin;

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
});
