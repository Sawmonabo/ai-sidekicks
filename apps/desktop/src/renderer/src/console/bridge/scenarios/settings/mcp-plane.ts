// The MCP governance plane the settings scenario answers: the unified inventory and
// the two mutations the operator page sends.
//
// Split out of `settings.ts` beside `account-plane.ts`, for that module's
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
//
// BOTH MUTATIONS ANSWER THE BINDING THE REQUEST NAMED, WHICH IS WHY THEY ARE COMPUTED.
// `replyFor` matches on the method NAME, so a constant answer reaches every press
// whatever binding it addressed: an enablement press on the issue tracker or the
// scratchpad came back carrying the filesystem row, and a trust press on anything but
// the issue tracker came back carrying that one. The operator page renders the outcome
// under the row whose control was pressed while the fixture's inventory ledger
// substitutes the row the ANSWER names — so one press appeared to move two different
// servers, and neither surface was wrong about the value it had been handed.
//
// AND THE ARM A PRESS REACHES IS THE DAEMON'S OWN SCOPE RULE RATHER THAN A FIXTURE
// INVENTION. Enablement is a provider-config write, so it answers for the user-scope
// binding alone and refuses the project- and local-scoped ones; a trust grant binds at
// the daemon, so it answers for both bindings that are effective in runs and refuses
// the one that is not; and a binding this scenario declares nowhere is refused as
// absent rather than answered with a neighbour. The rule is `Spec-028 §Configuration
// Mutation`'s scope applicability, which this module stands in for the daemon to apply
// — the same posture `repos-mutation-replies.ts` takes when it compares a path.
//
// A THROWN ENVELOPE IS WHAT LETS ONE ENTRY HOLD BOTH ANSWERS. The reply table is keyed
// by method, so a second entry for one call is unreachable and a `refusal` entry would
// refuse every press of it; a `resultFor` that throws a `WireErrorEnvelope` refuses
// exactly the requests the daemon would and serves the rest. Those refusals are also
// the only way this deck reaches the page's own refused-outcome rendering at all.

import type { ScenarioReply } from "../../scenario-runtime/index.js";
import { isWireRecord } from "../../../core/index.js";
import type { WireErrorEnvelope } from "../../../core/index.js";
import type {
  GrowthMcpBindingRef,
  GrowthMcpInventoryEntry,
  GrowthMcpLiveApplicationResult,
  GrowthMcpMutationResult,
} from "../../growth-values/index.js";

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
 * What applying an enablement change did on each of the filesystem binding's live legs.
 *
 * One leg applied and one failed, which is the partial outcome this reply shape exists
 * to carry. A page that rendered one aggregate verdict would report this as a success
 * and leave a session running against a binding the operator believes is off.
 *
 * A CONSTANT WHILE THE ROW IS COMPUTED, because which sessions hold this binding open
 * is a fact about the scenario rather than about the direction a person toggled it in.
 */
const FILESYSTEM_ENABLEMENT_LIVE_RESULTS: readonly GrowthMcpLiveApplicationResult[] = [
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
];

/**
 * Why a governance mutation on a binding that never reaches a run is refused.
 *
 * One sentence for both mutations rather than two spellings of it: the fact is about
 * the binding and not about which control was pressed. Accepting such a press would
 * record governance state nothing could ever enforce.
 */
const UNREACHABLE_BINDING_REFUSAL_MESSAGE =
  "This binding is never materialized into a run, so governance state recorded for it could never be enforced.";

/**
 * Refuse as the daemon would, in the shape the wire refuses in.
 *
 * A thrown `WireErrorEnvelope` reaches the caller exactly as a `refusal` entry's does,
 * so one computed reply can hold a refusal and a success without the scenario needing
 * two entries for one call — which it could not have, since a second entry for one call
 * is unreachable. Written the way `repos-mutation-replies.ts` writes it, and separately
 * from it: that module's refusals are its own scenario's, and a shared thrower would
 * publish a scenario-authoring seam neither family reads from the other.
 */
function refuseAs(code: string, message: string): never {
  const envelope: WireErrorEnvelope = { code, message };
  throw envelope;
}

/**
 * Whether a request addresses one scripted binding, member for member.
 *
 * COMPARED MEMBER-WISE RATHER THAN THROUGH `mcpBindingKeyOf`, because the request is
 * `unknown`: building a key from it would first mean narrowing four members back into
 * the scope-discriminated union, which is that union's own rule written a second time.
 * The comparison is injective for the reason the key is — no member is joined into
 * another, so no separator a checkout path or a typed server name may contain decides
 * anything — and the fixture ledger keys the ANSWER by `mcpBindingKeyOf`, so a row
 * matched here substitutes under its own identity.
 *
 * A `scopeRef` on a user-scoped request matches nothing, which is the registered shape:
 * the member is required for `project` and `local` and forbidden for `user`, so a
 * request carrying one there addresses no binding rather than the one it half-resembles.
 */
function addressesBinding(request: unknown, binding: GrowthMcpBindingRef): boolean {
  if (!isWireRecord(request)) {
    return false;
  }
  return (
    request["provider"] === binding.provider &&
    request["scope"] === binding.scope &&
    request["serverName"] === binding.serverName &&
    request["scopeRef"] === (binding.scope === "user" ? undefined : binding.scopeRef)
  );
}

/** The boolean facet a governance press carries, or `undefined` where it carries none. */
function requestedFacet(request: unknown, member: string): boolean | undefined {
  const value = isWireRecord(request) ? request[member] : undefined;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * What an enablement press answers, per binding.
 *
 * ONE SERVED ARM AND TWO REFUSING ONES, because enablement is a provider-config write
 * and the only provider-config-writable scope is `user`. The user-scoped Claude binding
 * answers with its own row at the pressed value plus the per-leg outcomes above; the
 * Codex project binding refuses with the file to edit named in the message and nowhere
 * else; and the Claude local binding refuses because it is never composed into a run at
 * all, which is the more fundamental of the two reasons it could not be written.
 *
 * A PRESS CARRYING NO FACET IS UNSCRIPTED RATHER THAN REFUSED. Returning `undefined`
 * says the scenario answers no such request and settles exactly as an unscripted call
 * does; refusing it would blame a binding for a request that never said what to do to
 * it. Read first, so that reading holds whichever binding the request named.
 */
function setEnabledResultFor(request: unknown): GrowthMcpMutationResult | undefined {
  const enabled = requestedFacet(request, "enabled");
  if (enabled === undefined) {
    return undefined;
  }
  if (addressesBinding(request, MCP_FILESYSTEM)) {
    return {
      server: { ...MCP_FILESYSTEM, enabled },
      applied: "live_reconcile",
      liveResults: FILESYSTEM_ENABLEMENT_LIVE_RESULTS,
    };
  }
  if (addressesBinding(request, MCP_ISSUE_TRACKER)) {
    refuseAs(
      "mcp.config_scope_unsupported",
      "Enablement is a provider-config write and only user-scope configuration is writable. Edit the project's own .codex/config.toml to change this binding.",
    );
  }
  if (addressesBinding(request, MCP_SCRATCHPAD)) {
    refuseAs("mcp.config_scope_unsupported", UNREACHABLE_BINDING_REFUSAL_MESSAGE);
  }
  refuseAs(
    "mcp.server_not_found",
    "No server with that provider, scope, scope reference, and name is bound on this node.",
  );
}

/**
 * What a trust press answers, per binding.
 *
 * TWO SERVED ARMS AND ONE REFUSING ONE, and the split is not the enablement split: a
 * trust grant binds at the daemon against the binding's current base-config hash and
 * reaches no provider configuration, so it applies to any binding that is effective in
 * runs — the Codex project binding included — and refuses only the one V1 never
 * materializes into a run.
 *
 * `daemon_enforced` AND NO LIVE RESULTS ON BOTH SERVED ARMS, because there is no live
 * leg for a daemon-side grant to have been applied to. The overrides on the row travel
 * unchanged even where trust is withdrawn: a Claude binding's weakening facets are
 * conditioned on current trust at resolution time and lapse rather than being rewritten,
 * and the Codex row carries none, so a fixture that edited them here would be inventing
 * a reversion neither provider performs.
 */
function setTrustResultFor(request: unknown): GrowthMcpMutationResult | undefined {
  const trusted = requestedFacet(request, "trusted");
  if (trusted === undefined) {
    return undefined;
  }
  if (addressesBinding(request, MCP_FILESYSTEM)) {
    return { server: { ...MCP_FILESYSTEM, trusted }, applied: "daemon_enforced" };
  }
  if (addressesBinding(request, MCP_ISSUE_TRACKER)) {
    return { server: { ...MCP_ISSUE_TRACKER, trusted }, applied: "daemon_enforced" };
  }
  if (addressesBinding(request, MCP_SCRATCHPAD)) {
    refuseAs("mcp.config_scope_unsupported", UNREACHABLE_BINDING_REFUSAL_MESSAGE);
  }
  refuseAs(
    "mcp.server_not_found",
    "No server with that provider, scope, scope reference, and name is bound on this node.",
  );
}

/**
 * The governance plane's scripted replies.
 *
 * The read carries a small latency because its skeleton is a real frame; the two
 * mutations answer a little more slowly still, because each is a press and the
 * in-flight state of a control is the state a person actually watches.
 *
 * The read stays a constant and the two mutations do not: `mcp.list` carries no
 * subject — its request is an optional refresh flag — while a mutation names the one
 * binding it is about.
 */
export const SETTINGS_MCP_PLANE_REPLIES: readonly ScenarioReply[] = [
  { call: "mcp.list", afterMs: 40, result: { servers: SETTINGS_MCP_INVENTORY } },
  { call: "mcp.setEnabled", afterMs: 80, resultFor: setEnabledResultFor },
  { call: "mcp.setTrust", afterMs: 80, resultFor: setTrustResultFor },
];
