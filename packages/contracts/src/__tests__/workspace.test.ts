// `workspace.ts`: the three workspace pairs — bind, the execution-mode
// capabilities read, and the workspace list.
import { describe, expect, it } from "vitest";

import * as contracts from "../index.js";
import { ExecutionModeSchema, REPO_PATH_MAX_LEN, RepoMountIdSchema } from "../repo.js";
import { SessionIdSchema } from "../session.js";
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

// --------------------------------------------------------------------------
// Wire surfaces — WorkspaceBind / WorkspaceExecutionModeCapabilitiesRead /
// WorkspaceList.
// --------------------------------------------------------------------------
//
// The three request/response pairs for the WORKSPACE half of the six `repo.*`
// methods. Coverage backstops the field requirements the shapes carry, all
// three: `WorkspaceBind` accepts a session, a repo mount and an intended
// execution mode from the canonical set; the capabilities read exposes which modes are
// currently valid for the bound repo mount OR workspace; `WorkspaceList`
// exposes workspace health and current binding state.
//
// Two conditional relationships are deliberately NOT pinned as shape rules,
// because the schemas do not encode them: `restrictions` covering every mode
// absent from `availableModes`, and `lastError` present iff `stale`. The rows
// below pin the REPRESENTABILITY of each case instead; the daemon that emits
// them owns the pairing.

// A daemon-provisioned execution root — deliberately NOT equal to the
// mount's canonical root. A worktree's root lives under the daemon's
// execution-roots directory, not inside the mount, so a fixture that
// reused the mount root could not catch a schema conflating the two.
const WORKSPACE_FS_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/wt-0190f8a0";
// Mount-root-RELATIVE, the whole point of the field: an absolute path here
// would be a caller bug, though the schema still admits one (owns
// containment — see the traversal negative control below).
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

// A restricted answer the schema must carry: the excluded mode names its
// reason, the available one is omitted (the explicit-gap shape).
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

// The `restrictions` accept/reject table, hoisted and EXPLICITLY typed — the
// same stance as `REGISTERED_REPO_EVENTS` above. Inline, TypeScript would
// widen the heterogeneous rows (an empty object absorbs the sibling `string`
// and `boolean` members in a union), leaving the callback parameters typed
// `{}`; the annotation keeps each column honest.
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
  // Keys are constrained to the canonical taxonomy: an unkeyed
  // `z.record(z.string(), z.string())` would admit all three rows below, and a
  // reader would then have no way to match the entry against `availableModes`.
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
    // Out-of-taxonomy: a `.default()` or a bare `z.string()` here would admit
    // these silently.
    ["submodule", false],
    ["", false],
  ])("executionMode %s -> %s, driven through the composed request", (executionMode, shouldPass) => {
    expect(parseBindRequest({ executionMode }).success).toBe(shouldPass);
  });

  it("has NO wire-level default for `executionMode` — omission is a rejection", () => {
    // Acceptance criterion, and the row that would flip if someone added a
    // `.default()`: the omission row above would then parse and "caller
    // omitted" would become indistinguishable from "caller chose that mode".
    const omitted = { sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID };
    expect(WorkspaceBindRequestSchema.safeParse(omitted).success).toBe(false);
  });

  it.each([
    ["a parent-traversal subpath", "../../etc"],
    ["an interior traversal that names a legitimate subtree", "docs/../packages"],
    ["an absolute path", "/etc/passwd"],
  ])("admits %s — the validator owns containment, not the schema", (_label, candidate) => {
    // NEGATIVE CONTROL on the guards below. A `..`-rejecting regex here would
    // be both bypassable (a symlink inside the mount escapes without a single
    // `..`) and over-broad (row two names a real subtree). Without these rows
    // the guards below would read as "the schema validates subpaths", which
    // is the wrong impression entirely.
    expect(parseBindRequest({ directory: candidate }).success).toBe(true);
  });

  it("bounds `directory` at REPO_PATH_MAX_LEN and refuses blank / NUL-byte forms", () => {
    // The cap REUSES `REPO_PATH_MAX_LEN` rather than minting a second 4096:
    // what the filesystem bounds is the joined `canonicalRoot + directory`,
    // which the schema cannot see at parse time.
    const atCap = "a".repeat(REPO_PATH_MAX_LEN);
    const overCap = "a".repeat(REPO_PATH_MAX_LEN + 1);
    expect(parseBindRequest({ directory: atCap }).success).toBe(true);
    expect(parseBindRequest({ directory: overCap }).success).toBe(false);
    expect(parseBindRequest({ directory: "" }).success).toBe(false);
    expect(parseBindRequest({ directory: "   " }).success).toBe(false);
    // Built at runtime rather than as an escape so ripgrep keeps treating this
    // file as text — the same reason the `actor` and `localPath` pins above do.
    const directoryWithNulByte = `packages${String.fromCharCode(0)}/contracts`;
    expect(parseBindRequest({ directory: directoryWithNulByte }).success).toBe(false);
  });

  it("rejects a `localPath` arm — bind is mount-first, with no second identifier", () => {
    // `.strict()` doing load-bearing work: the mount-less bind path closed
    // must stay unrepresentable, not merely unused.
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
      // The wire doc types this field `WorkspaceState` with no narrowing. A
      // two-literal union would pass every other row in this block while
      // silently rejecting three lawful states.
      expect(parseBindResponse({ state }).success).toBe(true);
    },
  );

  it("still rejects a state outside the 5-value workspace vocabulary", () => {
    // Negative control on the row above: non-narrowed is not unvalidated.
    // `detached` is a MOUNT state and must not leak across the vocabularies.
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
    // Ambiguity that would resolve SILENTLY: a handler picking `workspaceId`
    // when the caller meant the mount answers the post-bind question to a
    // pre-bind read. The refinement is what makes that unrepresentable rather
    // than merely undefined behavior.
    const result = parseCapabilitiesRequest({
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The curated message is a designed contract surface, not incidental
      // copy — naming both scopes and the question each one asks is the reason
      // a refinement was chosen over a two-arm union, whose "no branch
      // matched" error names neither rule. A bare `.refine(predicate)` would
      // leave every other row in this block green while destroying exactly the
      // property the design paid for. Both ids are well formed here BECAUSE
      // Zod skips checks on an aborted payload: a malformed id would never
      // reach the refinement, leaving the rejection above satisfied by the
      // id's own error and this message assertion failing outright.
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.join("\n")).toContain("MUST carry exactly one of");
    }
  });

  it("REJECTS a request supplying neither id", () => {
    // No subject at all — answerable only by inventing one.
    expect(parseCapabilitiesRequest({}).success).toBe(false);
  });

  it("treats an explicit `undefined` as absence, not as presence", () => {
    // The predicate counts DEFINED values rather than testing key presence, so
    // a TypeScript caller spelling the unused scope as `undefined` reads the
    // same as omitting it. Correct leniency: the wire signal is absence, and
    // JSON cannot carry `undefined` at all. A presence-based (`in`) predicate
    // would reject the first row and accept the second, inverting both.
    expect(
      parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID, workspaceId: undefined }).success,
    ).toBe(true);
    expect(
      parseCapabilitiesRequest({ repoMountId: undefined, workspaceId: undefined }).success,
    ).toBe(false);
  });

  it("is a STRICT refinement, not a tolerant union — a wrong-shaped id still rejects", () => {
    // A tolerant union with a permissive arm would accept this on the
    // permissive side and never be canonically typed. Exactly-one is not the
    // only guard: each id keeps its branded UUID parser.
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
    // No `.min(1)` — and no V1 case that produces an empty list: a git mount
    // offers both modes. Leaving the constraint off is headroom for a later probe-derived matrix,
    // plus pairing of `availableModes` with `restrictions`, which makes a
    // fully restricted answer well formed rather than a shape error. `repo.ts`
    // carries the authoritative account.
    expect(parseCapabilitiesResponse({ availableModes: [] }).success).toBe(true);
    expect(parseCapabilitiesResponse({ availableModes: ["submodule"] }).success).toBe(false);
  });

  it("omits `restrictions` entirely when nothing is restricted", () => {
    // The `git` row's shape — the whole field absent, not an empty object.
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
    // SPARSENESS is the load-bearing property, and the first two rows are what
    // a non-partial `z.record(ExecutionModeSchema, …)` would fail: Zod 4 makes
    // an enum-keyed `z.record` EXHAUSTIVE (the `CapabilityDetails.flags` stance
    // in event.ts), which is exactly wrong here — a `git` mount restricts
    // nothing. The exhaustive row is the control that partial does not mean
    // "at most one".
    expect(parseCapabilitiesResponse({ restrictions }).success).toBe(shouldPass);
  });

  it("REJECTS an explicit `undefined` as a restriction VALUE", () => {
    // The map's absence signal is KEY-OMISSION, deliberately unlike the
    // request side's explicit-undefined leniency a few blocks up: the value
    // schema is a bare non-optional string, so a present key carrying no
    // reason is precisely gap. Cannot join RESTRICTION_MAP_CASES, which is
    // typed `Record<string, string>`. Load-bearing for Phase 2 — the response
    // schema is single-T, so a projection builder spreading `"provisioned-worktree":
    // maybeReason` (`string | undefined`) gets NO compile-time protection and
    // would throw validation seam instead.
    expect(
      parseCapabilitiesResponse({ restrictions: { "provisioned-worktree": undefined } }).success,
    ).toBe(false);
  });

  it("applies the wireFreeFormString guard to restriction reason values", () => {
    // GUARD-DOWNGRADE VISIBILITY on the map's VALUE side — the key rows above
    // all carry well-formed reasons, so a bare `z.string()` value would pass
    // every one of them. An empty reason is failure mode that matters: a
    // restriction with no explanation is a silent gap wearing an explicit
    // gap's shape.
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
    // `z.partialRecord` clears the key schema's enumerated-value set to drop
    // exhaustiveness — on a CLONE. If it ever mutated the instance instead,
    // this module's canonical `ExecutionModeSchema` (imported) would quietly
    // lose its value set for every other consumer. Cheap to assert,
    // catastrophic to miss.
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
    // Sparseness pinned POSITIVELY, by exact key set: the restricted row names
    // `provisioned-worktree` and says nothing about `bound-root`, which must stay ABSENT rather
    // than materializing as an explicit `undefined` key on the way through. An
    // absent-key check alone would pass on an empty or missing map — the
    // failure this round-trip exists to catch.
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
    // `repoMountId` is an optional FILTER, not a second scope: unlike the
    // capabilities read above, there is no exactly-one refinement here,
    // because `sessionId` always identifies the query on its own.
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
    // A session with no workspaces is lawful — no `.min(1)`.
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [] }).success).toBe(true);
  });

  it("requires `workspaces` — an absent roster is not an empty one", () => {
    expect(WorkspaceListResponseSchema.safeParse({}).success).toBe(false);
  });

  it.each(["id", "repoMountId", "executionMode", "state"])(
    "requires %s on every list item",
    (field) => {
      // The four REQUIRED item fields, enumerated exhaustively: a field
      // quietly turned optional in a later phase would pass a partial list.
      // `fsRoot` and `lastError` are deliberately absent from this table and
      // have their own optionality rows below.
      const broken = { ...buildWorkspaceListItem() } as Record<string, unknown>;
      delete broken[field];
      expect(WorkspaceListResponseSchema.safeParse({ workspaces: [broken] }).success).toBe(false);
    },
  );

  it("names the item key `id`, not `workspaceId` — the read-projection convention", () => {
    // Pinned in BOTH directions by one fixture, as with the mount-read
    // projection above: a renamed item loses its required `id` AND trips
    // `.strict()` on the unknown `workspaceId`.
    const renamed = { ...buildWorkspaceListItem() } as Record<string, unknown>;
    delete renamed["id"];
    renamed["workspaceId"] = WORKSPACE_ID;
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [renamed] }).success).toBe(false);
  });

  it.each(["preparing", "ready", "busy", "stale", "archived"])(
    "exposes workspace health as the full `state` vocabulary — %s",
    (state) => {
      // `state` IS the health surface on this projection — not
      // `RepoMountHealth`, which is the MOUNT's reachability verdict and
      // belongs to `repo.mountRead`. `stale` is the availability-loss position
      // requires every daemon read surface to expose.
      expect(parseWorkspaceListItem({ state }).success).toBe(true);
    },
  );

  it("rejects a MOUNT state leaking onto a list item", () => {
    // Negative control: `detached` belongs to the mount vocabulary. Both
    // enums carry `archived`, which is exactly why they must not be conflated.
    expect(parseWorkspaceListItem({ state: "detached" }).success).toBe(false);
  });

  it("exposes binding state — `executionMode` from the canonical set plus optional `fsRoot`", () => {
    expect(parseWorkspaceListItem({ executionMode: "bound-root" }).success).toBe(true);
    expect(parseWorkspaceListItem({ executionMode: "submodule" }).success).toBe(false);
    // `fsRoot` is optional because a `preparing` workspace has no
    // execution root yet.
    const preparing = { ...buildWorkspaceListItem() } as Record<string, unknown>;
    delete preparing["fsRoot"];
    preparing["state"] = "preparing";
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [preparing] }).success).toBe(true);
    // GUARD-DOWNGRADE VISIBILITY on the optional path field.
    expect(parseWorkspaceListItem({ fsRoot: "" }).success).toBe(false);
  });

  it("exposes an optional `lastError`, present or absent independently of `state`", () => {
    // Both directions are lawful and the schema refines NEITHER: a `stale`
    // workspace WITH a recorded failure detail carries it, and a `stale`
    // workspace whose path simply vanished with no captured detail carries
    // none. Pinning "present iff stale" here would reject the second and
    // duplicate the emitter obligation.
    expect(
      parseWorkspaceListItem({ state: "stale", lastError: WORKSPACE_LAST_ERROR }).success,
    ).toBe(true);
    expect(parseWorkspaceListItem({ state: "stale" }).success).toBe(true);
  });

  it("bounds `lastError` at WORKSPACE_LAST_ERROR_MAX_LEN and applies the blank/NUL guards", () => {
    // Deliberately the generous 8192 class, not the 512 reason class: this is
    // captured provisioning output, nothing truncates it before the wire, and
    // because validates responses too an under-sized cap would make a LAWFUL
    // daemon list response unrepresentable.
    const atCap = "e".repeat(WORKSPACE_LAST_ERROR_MAX_LEN);
    const overCap = "e".repeat(WORKSPACE_LAST_ERROR_MAX_LEN + 1);
    expect(parseWorkspaceListItem({ lastError: atCap }).success).toBe(true);
    expect(parseWorkspaceListItem({ lastError: overCap }).success).toBe(false);
    expect(parseWorkspaceListItem({ lastError: "" }).success).toBe(false);
    const lastErrorWithNulByte = `fatal${String.fromCharCode(0)}injected`;
    expect(parseWorkspaceListItem({ lastError: lastErrorWithNulByte }).success).toBe(false);
  });

  it("rejects extraneous keys INSIDE a list item (.strict() reaches the nested object)", () => {
    // The nested item carries its own `.strict()`, so the wire shape is closed
    // at both levels — a top-level-only guard would let item drift through.
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

// COMPILE-TIME leg of optionality decisions, validated by the
// `tsconfig.test.json` typecheck leg rather than at runtime. Held in
// never-invoked functions so each pin does its whole job at compile time.
const workspaceBindTypePins = (): void => {
  // @ts-expect-error — a bind with no explicit execution mode. The acceptance
  // criterion is that this is UNCONSTRUCTABLE, not defaulted; adding a
  // `.default()` and relaxing the interface would report this directive unused
  // (TS2578) and turn the leg red.
  const missingExecutionMode: WorkspaceBindRequest = {
    sessionId: SessionIdSchema.parse(SESSION_ID),
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
  };
  void missingExecutionMode;

  // NO directive here, deliberately: this assignment MUST compile. It is the
  // compile-time twin of the "binds the mount root itself" runtime row — if a
  // later edit made `directory` required, a mount-root bind would become
  // unconstructable and the leg would go red HERE, at the decision. The
  // `as unknown as` bridge on the schema absorbs interface-side drift, so this
  // is the only thing standing behind that optionality.
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
  // Every canonical mode is a legal index — the `Partial<Record<ExecutionMode,
  // string>>` half that must keep compiling.
  void restrictions?.["provisioned-worktree"];
  // @ts-expect-error — `submodule` is not an `ExecutionMode`, so it is not a
  // legal index.
  //
  // SCOPE OF THIS PIN, stated precisely because it is narrower than it looks:
  // the schema is annotated `z.ZodType<…Response>`, so `.parse()` returns the
  // DECLARED interface whatever the schema underneath does. These two lines
  // therefore pin the exported TYPE's key set — they go red if
  // `WorkspaceExecutionModeCapabilitiesReadResponse.restrictions` is ever
  // widened to `Record<string, string>`. They do NOT catch a schema-side
  // downgrade to `z.record(z.string(), …)` behind an unchanged interface,
  // because `Record<string, string>` stays assignable to the declared
  // `Partial<Record<ExecutionMode, string>>` and the annotation absorbs it.
  // The runtime `restrictions` table above is what covers that direction: its
  // out-of-taxonomy rows flip from reject to accept the moment the key schema
  // stops being the canonical enum.
  void restrictions?.["submodule"];
};
void capabilitiesRestrictionsKeyPin;

describe("index.ts re-exports the workspace pairs", () => {
  // Importing through `../index.js` is what exercises the re-export layer: the
  // daemon and the desktop consume these through the package barrel.
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
