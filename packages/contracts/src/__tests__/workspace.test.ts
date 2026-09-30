// The three workspace pairs: bind, the execution-mode capabilities read, and the list.
import { describe, expect, it } from "vitest";

import * as contracts from "../index.js";
import { ExecutionModeSchema, RepoMountIdSchema } from "../repo.js";
import { SessionIdSchema, FILE_PATH_MAX_LEN } from "../session.js";
import {
  EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN,
  WORKSPACE_LAST_ERROR_MAX_LEN,
  WorkspaceBindRequestSchema,
  WorkspaceBindResponseSchema,
  WorkspaceExecutionModeCapabilitiesReadRequestSchema,
  WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  type WorkspaceBindRequest,
} from "../workspace.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const LOCAL_PATH = "/Users/dev/projects/ai-sidekicks/packages/contracts";

// Two pairings are not encoded in the schemas, so the rows only pin that each case is
// representable: `restrictions` covering every mode missing from `availableModes`, and
// `lastError` present exactly when `stale`. The daemon that emits them owns the pairing.

// Not the mount's canonical root: a worktree's root lives under the daemon's execution-roots
// directory, so a fixture reusing the mount root could not catch a schema conflating the two.
const WORKSPACE_FS_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/wt-0190f8a0";
// Relative to the mount root. An absolute path is a caller bug the schema still admits; the
// validator owns containment (see the traversal rows below).
const BIND_DIRECTORY = "packages/contracts";
const WORKSPACE_LAST_ERROR = "fatal: could not create work tree dir: Permission denied";

const buildBindRequest = () => ({
  sessionId: SESSION_ID,
  repoMountId: REPO_MOUNT_ID,
  executionMode: "provisioned-worktree" as const,
  directory: BIND_DIRECTORY,
});

// The bind's answer: the new workspace, still `preparing`.
const buildProvisioningBindResponse = () => ({
  workspaceId: WORKSPACE_ID,
  executionMode: "provisioned-worktree" as const,
  state: "preparing" as const,
});

// The git mount's answer: both modes, nothing restricted.
const buildGitCapabilitiesResponse = () => ({
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree" as const,
});

// A restricted answer: the excluded mode names its reason and the available one is omitted.
const buildRestrictedCapabilitiesResponse = () => ({
  availableModes: ["bound-root"],
  defaultMode: "bound-root" as const,
  restrictions: {
    "provisioned-worktree": "worktree provisioning unavailable",
  },
});

const buildWorkspaceListItem = () => ({
  id: WORKSPACE_ID,
  repoMountId: REPO_MOUNT_ID,
  executionMode: "provisioned-worktree" as const,
  state: "ready" as const,
  fsRoot: WORKSPACE_FS_ROOT,
});

const buildWorkspaceListResponse = () => ({
  workspaces: [buildWorkspaceListItem()],
});

const parseBindRequest = (overrides: Record<string, unknown> = {}) =>
  WorkspaceBindRequestSchema.safeParse({ ...buildBindRequest(), ...overrides });
const parseBindResponse = (overrides: Record<string, unknown> = {}) =>
  WorkspaceBindResponseSchema.safeParse({ ...buildProvisioningBindResponse(), ...overrides });
const parseCapabilitiesRequest = (request: Record<string, unknown>) =>
  WorkspaceExecutionModeCapabilitiesReadRequestSchema.safeParse(request);
const parseCapabilitiesResponse = (overrides: Record<string, unknown> = {}) =>
  WorkspaceExecutionModeCapabilitiesReadResponseSchema.safeParse({
    ...buildRestrictedCapabilitiesResponse(),
    ...overrides,
  });
const parseWorkspaceListItem = (overrides: Record<string, unknown> = {}) =>
  WorkspaceListResponseSchema.safeParse({
    workspaces: [{ ...buildWorkspaceListItem(), ...overrides }],
  });

// Typed explicitly: inline, TypeScript would widen the heterogeneous rows and type the
// callback parameters `{}`.
const RESTRICTION_MAP_CASES: ReadonlyArray<
  readonly [label: string, restrictions: Record<string, string>, shouldPass: boolean]
> = [
  ["an empty map", {}, true],
  [
    "a single-mode strict subset",
    { "provisioned-worktree": "worktree provisioning unavailable" },
    true,
  ],
  [
    "an exhaustive map",
    {
      "bound-root": "mount root unreachable",
      "provisioned-worktree": "mount root unreachable",
    },
    true,
  ],
  // Keys are the canonical modes only: an unkeyed `z.record(z.string(), z.string())` would
  // admit the foreign-key rows below, and a reader could not match them to `availableModes`.
  ["an out-of-taxonomy key", { submodule: "not a mode" }, false],
  [
    "a mixed map with one foreign key",
    { "provisioned-worktree": "ok", submodule: "not a mode" },
    false,
  ],
];

describe("WorkspaceBindRequestSchema (session + mount + explicit mode)", () => {
  it("accepts a valid bind request", () => {
    expect(parseBindRequest().success).toBe(true);
  });

  it("accepts a bind with no `directory` — binding the mount root itself", () => {
    const rootBind = {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      executionMode: "bound-root",
    };
    expect(WorkspaceBindRequestSchema.safeParse(rootBind).success).toBe(true);
  });

  it.each(["sessionId", "repoMountId", "executionMode"])(
    "rejects a bind request missing the required field %s",
    (field) => {
      const broken = { ...buildBindRequest() } as Record<string, unknown>;
      delete broken[field];
      expect(WorkspaceBindRequestSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each([
    ["bound-root", true],
    ["provisioned-worktree", true],
    // Outside the modes: a `.default()` or a bare `z.string()` would admit these.
    ["submodule", false],
    ["", false],
  ])("executionMode %s -> %s, driven through the composed request", (executionMode, shouldPass) => {
    expect(parseBindRequest({ executionMode }).success).toBe(shouldPass);
  });

  it("has NO wire-level default for `executionMode` — omission is a rejection", () => {
    // A `.default()` would make an omitted mode indistinguishable from a chosen one.
    const omitted = { sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID };
    expect(WorkspaceBindRequestSchema.safeParse(omitted).success).toBe(false);
  });

  it.each([
    ["a parent-traversal subpath", "../../etc"],
    ["an interior traversal that names a legitimate subtree", "docs/../packages"],
    ["an absolute path", "/etc/passwd"],
  ])("admits %s — the validator owns containment, not the schema", (_label, candidate) => {
    // A `..`-rejecting regex would be bypassable (a symlink inside the mount escapes without
    // any `..`) and over-broad (row two names a real subtree).
    expect(parseBindRequest({ directory: candidate }).success).toBe(true);
  });

  it("bounds `directory` at FILE_PATH_MAX_LEN and refuses blank / NUL-byte forms", () => {
    // The cap is the only path bound: the filesystem bounds the joined `canonicalRoot +
    // directory`, which the schema cannot see at parse time.
    const atCap = "a".repeat(FILE_PATH_MAX_LEN);
    const overCap = "a".repeat(FILE_PATH_MAX_LEN + 1);
    expect(parseBindRequest({ directory: atCap }).success).toBe(true);
    expect(parseBindRequest({ directory: overCap }).success).toBe(false);
    expect(parseBindRequest({ directory: "" }).success).toBe(false);
    expect(parseBindRequest({ directory: "   " }).success).toBe(false);
    // Built at runtime so ripgrep keeps treating this file as text.
    const directoryWithNulByte = `packages${String.fromCharCode(0)}/contracts`;
    expect(parseBindRequest({ directory: directoryWithNulByte }).success).toBe(false);
  });

  it("rejects a `localPath` arm — bind is mount-first, with no second identifier", () => {
    // `.strict()` keeps the mount-less bind path unrepresentable, not merely unused.
    expect(parseBindRequest({ localPath: LOCAL_PATH }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseBindRequest({ extra: "leak" }).success).toBe(false);
  });
});

describe("WorkspaceBindResponseSchema", () => {
  it.each(["workspaceId", "executionMode", "state"])(
    "requires %s on the bind response",
    (field) => {
      const broken = { ...buildProvisioningBindResponse() } as Record<string, unknown>;
      delete broken[field];
      expect(WorkspaceBindResponseSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(["preparing", "ready", "busy", "stale", "archived"])(
    "carries the full WorkspaceState vocabulary, not a preparing/ready literal — %s",
    (state) => {
      // A two-literal union would pass the other rows and silently reject three lawful states.
      expect(parseBindResponse({ state }).success).toBe(true);
    },
  );

  it("still rejects a state outside the 5-value workspace vocabulary", () => {
    // `detached` is a mount state and must not leak into the workspace vocabulary.
    expect(parseBindResponse({ state: "detached" }).success).toBe(false);
    expect(parseBindResponse({ state: "exploded" }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseBindResponse({ extra: "leak" }).success).toBe(false);
  });
});

describe("WorkspaceExecutionModeCapabilitiesReadRequestSchema (exactly-one scope refinement)", () => {
  it("accepts a MOUNT-scoped read — what could a workspace on this mount do", () => {
    expect(parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID }).success).toBe(true);
  });

  it("accepts a WORKSPACE-scoped read — what may THIS workspace do now", () => {
    expect(parseCapabilitiesRequest({ workspaceId: WORKSPACE_ID }).success).toBe(true);
  });

  it("REJECTS a request supplying both `repoMountId` and `workspaceId`", () => {
    // A handler silently picking `workspaceId` when the caller meant the mount would answer a
    // post-bind question to a pre-bind read.
    const result = parseCapabilitiesRequest({
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The message names both scopes and the question each asks, which a two-arm union's
      // "no branch matched" error would not. Both ids are well formed because Zod skips
      // refinements on an aborted payload: a malformed id would fail on its own error first.
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.join("\n")).toContain("MUST carry exactly one of");
    }
  });

  it("REJECTS a request supplying neither id", () => {
    // No subject at all.
    expect(parseCapabilitiesRequest({}).success).toBe(false);
  });

  it("treats an explicit `undefined` as absence, not as presence", () => {
    // The predicate counts defined values, so an explicit `undefined` reads as absence (JSON
    // cannot carry `undefined` at all). A key-presence test would invert both rows.
    expect(
      parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID, workspaceId: undefined }).success,
    ).toBe(true);
    expect(
      parseCapabilitiesRequest({ repoMountId: undefined, workspaceId: undefined }).success,
    ).toBe(false);
  });

  it("is a STRICT refinement, not a tolerant union — a wrong-shaped id still rejects", () => {
    // Exactly-one is not the only guard: each id keeps its branded UUID parser.
    expect(parseCapabilitiesRequest({ repoMountId: "not-a-uuid" }).success).toBe(false);
    expect(parseCapabilitiesRequest({ workspaceId: "" }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID, extra: "leak" }).success).toBe(
      false,
    );
  });
});

describe("WorkspaceExecutionModeCapabilitiesReadResponseSchema (static matrix)", () => {
  it("accepts the `git` matrix row — both modes, no restrictions", () => {
    const parsed = WorkspaceExecutionModeCapabilitiesReadResponseSchema.safeParse(
      buildGitCapabilitiesResponse(),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts a restricted answer — one mode plus its excluded sibling's reason", () => {
    const parsed = WorkspaceExecutionModeCapabilitiesReadResponseSchema.safeParse(
      buildRestrictedCapabilitiesResponse(),
    );
    expect(parsed.success).toBe(true);
  });

  it.each(["availableModes", "defaultMode"])("requires %s", (field) => {
    const broken = { ...buildRestrictedCapabilitiesResponse() } as Record<string, unknown>;
    delete broken[field];
    expect(WorkspaceExecutionModeCapabilitiesReadResponseSchema.safeParse(broken).success).toBe(
      false,
    );
  });

  it("accepts either mode as `defaultMode` and nothing outside the taxonomy", () => {
    expect(parseCapabilitiesResponse({ defaultMode: "bound-root" }).success).toBe(true);
    expect(parseCapabilitiesResponse({ defaultMode: "provisioned-worktree" }).success).toBe(true);
    expect(parseCapabilitiesResponse({ defaultMode: "submodule" }).success).toBe(false);
  });

  it("accepts an EMPTY `availableModes` and rejects an out-of-taxonomy member", () => {
    // No `.min(1)`: with a reason per mode in `restrictions`, an empty list is a fully
    // restricted answer, well formed rather than a shape error.
    expect(parseCapabilitiesResponse({ availableModes: [] }).success).toBe(true);
    expect(parseCapabilitiesResponse({ availableModes: ["submodule"] }).success).toBe(false);
  });

  it("omits `restrictions` entirely when nothing is restricted", () => {
    // The whole field is absent, not an empty object.
    const withoutRestrictions = { ...buildRestrictedCapabilitiesResponse() } as Record<
      string,
      unknown
    >;
    delete withoutRestrictions["restrictions"];
    expect(
      WorkspaceExecutionModeCapabilitiesReadResponseSchema.safeParse(withoutRestrictions).success,
    ).toBe(true);
  });

  it.each(RESTRICTION_MAP_CASES)("restrictions: %s", (_label, restrictions, shouldPass) => {
    // The map must be sparse: an enum-keyed `z.record(ExecutionModeSchema, …)` is exhaustive
    // in Zod 4 and would fail the first two rows, yet a git mount restricts nothing. The
    // exhaustive row shows partial does not mean "at most one".
    expect(parseCapabilitiesResponse({ restrictions }).success).toBe(shouldPass);
  });

  it("REJECTS an explicit `undefined` as a restriction VALUE", () => {
    // Absence is key omission, unlike the request side's leniency for an explicit
    // `undefined`: a present key with no reason is a gap. It cannot join
    // RESTRICTION_MAP_CASES, typed `Record<string, string>`. The response schema is annotated
    // with the declared interface, so a builder spreading `maybeReason` (`string | undefined`)
    // gets no compile-time protection and this runtime check is the only guard.
    expect(
      parseCapabilitiesResponse({ restrictions: { "provisioned-worktree": undefined } }).success,
    ).toBe(false);
  });

  it("applies the wireFreeFormString guard to restriction reason values", () => {
    // The key rows above all carry well-formed reasons, so a bare `z.string()` value would
    // pass them. A restriction with no explanation is a silent gap in an explicit gap's shape.
    expect(
      parseCapabilitiesResponse({ restrictions: { "provisioned-worktree": "" } }).success,
    ).toBe(false);
    expect(
      parseCapabilitiesResponse({ restrictions: { "provisioned-worktree": "   " } }).success,
    ).toBe(false);
    const atCap = "r".repeat(EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN);
    const overCap = "r".repeat(EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN + 1);
    expect(
      parseCapabilitiesResponse({ restrictions: { "provisioned-worktree": atCap } }).success,
    ).toBe(true);
    expect(
      parseCapabilitiesResponse({ restrictions: { "provisioned-worktree": overCap } }).success,
    ).toBe(false);
  });

  it("leaves the shared canonical ExecutionModeSchema unmutated by partialRecord", () => {
    // `z.partialRecord` drops the key schema's value set on a clone. Were it to mutate the
    // instance, the shared `ExecutionModeSchema` would lose its values for every consumer.
    expect(ExecutionModeSchema.safeParse("provisioned-worktree").success).toBe(true);
    expect(ExecutionModeSchema.safeParse("submodule").success).toBe(false);
    const schemaInternals = ExecutionModeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options].sort()).toEqual(["bound-root", "provisioned-worktree"]);
  });

  it("round-trips the sparse map through JSON without loss", () => {
    const firstPass = WorkspaceExecutionModeCapabilitiesReadResponseSchema.parse(
      buildRestrictedCapabilitiesResponse(),
    );
    const secondPass = WorkspaceExecutionModeCapabilitiesReadResponseSchema.parse(
      JSON.parse(JSON.stringify(firstPass)) as unknown,
    );
    expect(secondPass).toStrictEqual(firstPass);
    // The exact key set shows `bound-root` stays absent rather than becoming an explicit
    // `undefined` key; an absent-key check alone would pass on an empty or missing map.
    expect(Object.keys(firstPass.restrictions ?? {})).toStrictEqual(["provisioned-worktree"]);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseCapabilitiesResponse({ extra: "leak" }).success).toBe(false);
  });
});

describe("WorkspaceList request/response (health + binding state)", () => {
  it("accepts a session-scoped list request and its optional mount filter", () => {
    expect(WorkspaceListRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(true);
    expect(
      WorkspaceListRequestSchema.safeParse({ sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID })
        .success,
    ).toBe(true);
  });

  it("requires `sessionId` — the filter alone does not identify the query", () => {
    // `repoMountId` is an optional filter, not a second scope, so unlike the capabilities read
    // there is no exactly-one refinement.
    expect(WorkspaceListRequestSchema.safeParse({ repoMountId: REPO_MOUNT_ID }).success).toBe(
      false,
    );
    expect(WorkspaceListRequestSchema.safeParse({ sessionId: "nope" }).success).toBe(false);
  });

  it("rejects extraneous keys on the list request (.strict() guard)", () => {
    expect(
      WorkspaceListRequestSchema.safeParse({ sessionId: SESSION_ID, extra: "leak" }).success,
    ).toBe(false);
  });

  it("accepts a populated roster and an EMPTY one", () => {
    expect(WorkspaceListResponseSchema.safeParse(buildWorkspaceListResponse()).success).toBe(true);
    // A session with no workspaces is lawful.
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [] }).success).toBe(true);
  });

  it("requires `workspaces` — an absent roster is not an empty one", () => {
    expect(WorkspaceListResponseSchema.safeParse({}).success).toBe(false);
  });

  it.each(["id", "repoMountId", "executionMode", "state"])(
    "requires %s on every list item",
    (field) => {
      // The required item fields; `fsRoot` and `lastError` are optional and have their own rows.
      const broken = { ...buildWorkspaceListItem() } as Record<string, unknown>;
      delete broken[field];
      expect(WorkspaceListResponseSchema.safeParse({ workspaces: [broken] }).success).toBe(false);
    },
  );

  it("names the item key `id`, not `workspaceId` — the read-projection convention", () => {
    // One fixture pins both directions: the renamed item loses its required `id` and trips
    // `.strict()` on the unknown `workspaceId`.
    const renamed = { ...buildWorkspaceListItem() } as Record<string, unknown>;
    delete renamed["id"];
    renamed["workspaceId"] = WORKSPACE_ID;
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [renamed] }).success).toBe(false);
  });

  it.each(["preparing", "ready", "busy", "stale", "archived"])(
    "exposes workspace health as the full `state` vocabulary — %s",
    (state) => {
      // `state` is the health surface here, not `RepoMountHealth`, which is the mount's
      // reachability verdict and belongs to `repo.mountRead`.
      expect(parseWorkspaceListItem({ state }).success).toBe(true);
    },
  );

  it("rejects a MOUNT state leaking onto a list item", () => {
    // `detached` belongs to the mount vocabulary; both carry `archived`, so they must not blur.
    expect(parseWorkspaceListItem({ state: "detached" }).success).toBe(false);
  });

  it("exposes binding state — `executionMode` from the canonical set plus optional `fsRoot`", () => {
    expect(parseWorkspaceListItem({ executionMode: "bound-root" }).success).toBe(true);
    expect(parseWorkspaceListItem({ executionMode: "submodule" }).success).toBe(false);
    // `fsRoot` is optional because a `preparing` workspace has no execution root yet.
    const preparing = { ...buildWorkspaceListItem() } as Record<string, unknown>;
    delete preparing["fsRoot"];
    preparing["state"] = "preparing";
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [preparing] }).success).toBe(true);
    // A blank path is refused even on the optional field.
    expect(parseWorkspaceListItem({ fsRoot: "" }).success).toBe(false);
  });

  it("exposes an optional `lastError`, present or absent independently of `state`", () => {
    // A stale workspace may carry a failure detail or, when its path simply vanished, none;
    // "present iff stale" would reject the second.
    expect(
      parseWorkspaceListItem({ state: "stale", lastError: WORKSPACE_LAST_ERROR }).success,
    ).toBe(true);
    expect(parseWorkspaceListItem({ state: "stale" }).success).toBe(true);
  });

  it("bounds `lastError` at WORKSPACE_LAST_ERROR_MAX_LEN and applies the blank/NUL guards", () => {
    // Larger than the restriction reason cap: this is captured provisioning output that
    // nothing truncates before the wire, and responses are validated too, so an under-sized
    // cap would make a lawful list response unrepresentable.
    const atCap = "e".repeat(WORKSPACE_LAST_ERROR_MAX_LEN);
    const overCap = "e".repeat(WORKSPACE_LAST_ERROR_MAX_LEN + 1);
    expect(parseWorkspaceListItem({ lastError: atCap }).success).toBe(true);
    expect(parseWorkspaceListItem({ lastError: overCap }).success).toBe(false);
    expect(parseWorkspaceListItem({ lastError: "" }).success).toBe(false);
    const lastErrorWithNulByte = `fatal${String.fromCharCode(0)}injected`;
    expect(parseWorkspaceListItem({ lastError: lastErrorWithNulByte }).success).toBe(false);
  });

  it("rejects extraneous keys INSIDE a list item (.strict() reaches the nested object)", () => {
    // The item has its own `.strict()`; a top-level-only guard would let item drift through.
    expect(parseWorkspaceListItem({ extra: "leak" }).success).toBe(false);
  });

  it("round-trips through JSON without loss", () => {
    const firstPass = WorkspaceListResponseSchema.parse(buildWorkspaceListResponse());
    const secondPass = WorkspaceListResponseSchema.parse(
      JSON.parse(JSON.stringify(firstPass)) as unknown,
    );
    expect(secondPass).toStrictEqual(firstPass);
  });
});

// Compile-time pins, checked by the `tsconfig.test.json` typecheck rather than at runtime.
// They sit in never-invoked functions.
const workspaceBindTypePins = (): void => {
  // @ts-expect-error — a bind with no execution mode must be unconstructable, not defaulted.
  const missingExecutionMode: WorkspaceBindRequest = {
    sessionId: SessionIdSchema.parse(SESSION_ID),
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
  };
  void missingExecutionMode;

  // No directive: this must compile. It is the compile-time twin of the mount-root bind row,
  // and the only guard on `directory` staying optional in the interface.
  const rootBind: WorkspaceBindRequest = {
    sessionId: SessionIdSchema.parse(SESSION_ID),
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
    executionMode: "bound-root",
  };
  void rootBind;
};
void workspaceBindTypePins;

const capabilitiesRestrictionsKeyPin = (): void => {
  const { restrictions } = WorkspaceExecutionModeCapabilitiesReadResponseSchema.parse(
    buildRestrictedCapabilitiesResponse(),
  );
  // Every mode is a legal index.
  void restrictions?.["provisioned-worktree"];
  // @ts-expect-error — `submodule` is not an `ExecutionMode`, so it is not a legal index.
  // This pins the exported type's key set only: `.parse()` returns the declared interface
  // whatever the schema does, so a schema-side downgrade to `z.record(z.string(), …)` is caught
  // by the out-of-taxonomy rows of the restrictions table, not here.
  void restrictions?.["submodule"];
};
void capabilitiesRestrictionsKeyPin;

describe("index.ts re-exports the workspace pairs", () => {
  // Importing through `../index.js` exercises the package barrel the daemon and desktop use.
  it.each([
    ["WorkspaceBindRequestSchema", contracts.WorkspaceBindRequestSchema],
    ["WorkspaceBindResponseSchema", contracts.WorkspaceBindResponseSchema],
    [
      "WorkspaceExecutionModeCapabilitiesReadRequestSchema",
      contracts.WorkspaceExecutionModeCapabilitiesReadRequestSchema,
    ],
    [
      "WorkspaceExecutionModeCapabilitiesReadResponseSchema",
      contracts.WorkspaceExecutionModeCapabilitiesReadResponseSchema,
    ],
    ["WorkspaceListRequestSchema", contracts.WorkspaceListRequestSchema],
    ["WorkspaceListResponseSchema", contracts.WorkspaceListResponseSchema],
  ] as const)("re-exports %s with a callable .parse", (_name, schema) => {
    expect(schema).toBeDefined();
    expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
  });
});
