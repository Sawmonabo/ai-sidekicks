// The MCP governance plane the settings scenario answers: the unified inventory and
// the two mutations the operator page sends.
//
// Split out of `settings.ts` beside `settings-account-plane.ts`, for that module's
// reason and one more: these two planes share a settings surface and share nothing
// else, so one file holding both would be two data tables that never reference each
// other.
//
// THESE REPLIES ARE TYPED AGAINST THE CONSOLE'S OWN TRANSCRIPTION, because no code
// package publishes this namespace at all — `growth-values/mcp.ts` is the corpus's
// shapes written down once, and scripting against it is what keeps this deck and the
// operator page from disagreeing about a row.
//
// WHAT THIS TABLE DELIBERATELY PUTS IN THE INTERESTING ARM. A trust store that is
// unreachable, a binding that needs authorization while one of its legs is fine, and a
// mutation that committed durably and failed on one live leg. The calm arms are what
// the unscripted empty inventory already answers.

import type { ScenarioReply } from "../scenario-runtime/index.js";
import type { GrowthMcpInventoryEntry, GrowthMcpMutationResult } from "../growth-values/index.js";

/**
 * The instant every live leg below was last observed.
 *
 * One stamp for the whole inventory: what this deck exercises is the aggregate over
 * legs that DISAGREE about status, not legs that disagree about when they were read.
 */
const OBSERVED_RECENTLY = "2026-01-01T07:58:00.000Z";

/**
 * The two sessions whose live legs the inventory reports on.
 *
 * Named because they appear on a leg AND on a live-application outcome, and a leg
 * reported under one id whose failure was reported under another would make the two
 * tables unjoinable — which is the one property the per-leg grain exists for.
 */
const SESSION_WITH_LEGS = "019b7892-1a00-7c31-8110-cca0117a0500";
const SECOND_SESSION_WITH_LEGS = "019b7892-1a00-7c31-8110-cca0117a0501";

/**
 * The keyed digest of the project root the two non-user bindings share.
 *
 * One value for one path, because that is what the daemon serves: the digest is stable
 * for a binding's life and joinable across entries, so two rows keyed to one project
 * carrying different digests would be a shape no daemon can produce.
 */
const PROJECT_SCOPE_REF_DIGEST = "b3:71aa03c5ef1289";

/**
 * The three inventory rows, one per arm the page has to draw.
 *
 * The first is the ordinary trusted binding with live legs and two tool overrides. The
 * second is a project-scoped binding that needs authorization, carries a required flag,
 * and has one leg failing — so `status` is the daemon's severity aggregate rather than
 * any single leg's. The third is the degraded arm: the trust store is unreachable, so
 * `trusted`, `configHash`, and `toolOverrides` are STRUCTURALLY ABSENT and `enabled` is
 * absent too, because this is a Claude binding whose enabled overlay lives in the store
 * that cannot be read. A fabricated value on any of them would be the invented verdict
 * that arm exists to prevent.
 *
 * Each is declared `satisfies` rather than annotated, and that is load-bearing rather
 * than stylistic: an annotation would widen `scope` and `transport` back to their
 * unions, and the mutation replies below rebuild a row from one of these. A widened row
 * cannot be rebuilt without a cast, and a cast here would switch off exactly the
 * checking that keeps this deck and the page agreeing about a shape.
 */
const MCP_FILESYSTEM = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
  effectiveInRuns: true,
  config: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    envVarNames: ["FS_ROOT"],
    enabled: true,
  },
  status: "connected",
  legs: [
    {
      sessionId: SESSION_WITH_LEGS,
      bindingId: "leg-filesystem-a",
      status: "connected",
      observedAt: OBSERVED_RECENTLY,
    },
  ],
  observedAt: OBSERVED_RECENTLY,
  enabled: true,
  trusted: true,
  configHash: "b3:2f9c41d8ae07b5",
  toolOverrides: [
    { toolName: "write_file", enabled: false },
    { toolName: "read_file", approvalMode: "auto", idempotencyClass: "idempotent" },
  ],
} satisfies GrowthMcpInventoryEntry;

const MCP_ISSUE_TRACKER = {
  provider: "codex",
  scope: "project",
  scopeRef: "/Users/example/work/atlas",
  serverName: "issue-tracker",
  effectiveInRuns: true,
  config: {
    transport: "http",
    url: "https://issues.example.test/mcp",
    urlQueryParamNames: ["workspace"],
    headerNames: ["X-Tenant"],
    bearerTokenEnvVar: "ISSUE_TRACKER_TOKEN",
    oauthScopes: ["issues.read", "issues.write"],
    enabled: true,
    required: true,
  },
  status: "needs-auth",
  legs: [
    {
      sessionId: SESSION_WITH_LEGS,
      bindingId: "leg-issues-a",
      status: "needs-auth",
      observedAt: OBSERVED_RECENTLY,
    },
    {
      sessionId: SECOND_SESSION_WITH_LEGS,
      bindingId: "leg-issues-b",
      status: "connected",
      observedAt: OBSERVED_RECENTLY,
    },
  ],
  observedAt: OBSERVED_RECENTLY,
  requiredServer: true,
  scopeRefDigest: PROJECT_SCOPE_REF_DIGEST,
  enabled: true,
  trusted: false,
  configHash: "b3:5d10bb37c4e0aa",
  toolOverrides: [],
} satisfies GrowthMcpInventoryEntry;

const MCP_SCRATCHPAD = {
  provider: "claude",
  scope: "local",
  scopeRef: "/Users/example/work/atlas",
  serverName: "scratchpad",
  effectiveInRuns: false,
  config: { transport: "stdio", command: "./scripts/scratchpad-mcp" },
  status: "unknown",
  scopeRefDigest: PROJECT_SCOPE_REF_DIGEST,
  trustUnavailable: true,
} satisfies GrowthMcpInventoryEntry;

/** The inventory, in the order the grid shows it. */
export const SETTINGS_MCP_INVENTORY: readonly GrowthMcpInventoryEntry[] = [
  MCP_FILESYSTEM,
  MCP_ISSUE_TRACKER,
  MCP_SCRATCHPAD,
];

/**
 * What disabling the first binding answers: the row as it now stands, where the change
 * took effect, and what happened on each live leg.
 *
 * One leg applied and one failed, which is the partial outcome this reply shape exists
 * to carry. A page that rendered one aggregate verdict would report this as a success
 * and leave a session running against a binding the operator believes is off.
 */
export const SETTINGS_MCP_SET_ENABLED: GrowthMcpMutationResult = {
  server: { ...MCP_FILESYSTEM, enabled: false },
  applied: "live_reconcile",
  liveResults: [
    {
      sessionId: SESSION_WITH_LEGS,
      bindingId: "leg-filesystem-a",
      outcome: "applied",
    },
    {
      sessionId: SECOND_SESSION_WITH_LEGS,
      bindingId: "leg-filesystem-b",
      outcome: "failed",
      errorCode: "mcp.config_write_conflict",
      detail: "another writer changed this binding while the change was being applied",
    },
  ],
};

/**
 * What granting trust answers.
 *
 * `daemon_enforced` and no live results: a trust grant binds at the daemon against the
 * binding's current base-config hash and reaches no provider configuration, so there is
 * no live leg for it to have been applied to.
 */
export const SETTINGS_MCP_SET_TRUST: GrowthMcpMutationResult = {
  server: { ...MCP_ISSUE_TRACKER, trusted: true },
  applied: "daemon_enforced",
};

/**
 * The governance plane's scripted replies.
 *
 * The read carries a small latency because its skeleton is a real frame; the two
 * mutations answer a little more slowly still, because each is a press and the
 * in-flight state of a control is the state a person actually watches.
 */
export const SETTINGS_MCP_PLANE_REPLIES: readonly ScenarioReply[] = [
  { call: "mcp.list", afterMs: 40, result: { servers: SETTINGS_MCP_INVENTORY } },
  { call: "mcp.setEnabled", afterMs: 80, result: SETTINGS_MCP_SET_ENABLED },
  { call: "mcp.setTrust", afterMs: 80, result: SETTINGS_MCP_SET_TRUST },
];
