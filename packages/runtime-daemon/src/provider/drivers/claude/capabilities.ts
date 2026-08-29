/**
 * Claude driver capability declaration (Plan-005 T3.8).
 *
 * Owns the Claude driver's `getCapabilities()` answer — the V1
 * `GetCapabilitiesResult` wrapper (flags + contract version, tool metadata,
 * CLI version report) — and the refresh trigger that hands a fresh reading to
 * the capability-declaration sink, which is what emits
 * `runtime_node.capability_declared` / `runtime_node.capability_updated`
 * (CP-005-5).
 *
 * ## I-005-2 — declaration is TOTAL, and absence never means "supported"
 *
 * `Spec-005 §Required Behavior`: a driver declares its capabilities
 * explicitly; a flag the driver does not declare is unsupported, and no caller
 * may infer support from a method existing on the provider's wire. Two things
 * realize that here:
 *
 *   1. {@link CLAUDE_CAPABILITY_FLAGS} is annotated
 *      `Record<DriverCapabilityFlag, boolean>` and written as an explicit
 *      literal — every canonical flag present, each with a decided boolean.
 *      A flag added to `DRIVER_CAPABILITY_FLAGS` in `@ai-sidekicks/contracts`
 *      therefore breaks THIS file's compilation until someone decides its
 *      value for Claude. That is the point: the failure mode I-005-2 forbids
 *      is a new flag silently reading as absent, and a missing-property error
 *      is the cheapest place to catch it.
 *   2. Nothing here is derived, inferred, or defaulted. There is no
 *      `?? false`, no partial record spread over a base, and no "unknown
 *      flags are false" fallback — a fallback would make the absence of a
 *      decision indistinguishable from a decision, which is exactly the
 *      inference the invariant prohibits.
 *
 * The values mirror `Spec-005 §Per-Driver Capability Matrix`; each flag below
 * carries the mechanism that makes its value true (or the absence that makes
 * it false), so a reviewer can check the declaration against the wire
 * reference rather than against this file's own say-so.
 *
 * ## Deliberately NOT here (scope boundaries, not omissions)
 *
 * * **`transcript_replay`'s PROBED value** — the spec matrix records this cell
 *   as `probe`, not as a constant, because no stable seeding contract is
 *   published for this provider. The flag is answered `false` below, which is
 *   the honest reading of a probe that has not run: an undeclared capability is
 *   unsupported, and a `false` here routes a switch to the memo floor, which is
 *   a supported outcome rather than a failure. Replacing the constant with the
 *   probe's own reading is Plan-005 T3.20's, and the row backfilled at
 *   migration 0012 matches this declaration until it lands.
 * * **Probe-based declaration + `detectionSource`** — `Spec-005 §Capability
 *   discovery` (2026-08-26) binds every flag carrying an *admissible* probe
 *   to be read from the installed build and to carry its detection source on
 *   the report. `DriverCapabilities` carries no `detectionSource` member
 *   today, so a probed reading is not yet representable at the contract; the
 *   probe table and that member are Plan-005 T3.24. This module's static
 *   declaration is that sequencing, not a rejection of the rule.
 * * **The refresh cadence** — the 15-minute poll and its pairing with the
 *   zero-turn auth probe are the `CapabilityRefreshScheduler`'s
 *   (`../../capability-refresh.ts`, T3.12 P2-9).
 *   {@link ClaudeCapabilityReporter.refreshDeclaration} is the emission seam
 *   that scheduler drives, not the scheduler. The CLI-version FLOOR, by
 *   contrast, is enforced HERE since T3.12: {@link
 *   ClaudeCapabilityReporter.getCapabilities} refuses a below-floor reading
 *   fail-closed (`driver.cli_version_below_floor`) through the shared
 *   `assertCliVersionMeetsFloor` seam, so attach and refresh both hit the
 *   gate; the unparseable refusal (`driver.cli_version_unparseable`) fires at
 *   report construction (`parseCliVersionReport`), inside the T3.23 reading of
 *   the spawned process.
 * * **Resolution, the spawn, and the in-band read** — `../../version-gate.ts`
 *   (T3.23) owns them. Since that task the reporter's injected dependency is a
 *   `SpawnedProviderVersionReading` reader rather than a bare report reader, so
 *   a declaration composed from a version that did not come from the spawned
 *   build is unrepresentable rather than merely discouraged
 *   (`Spec-005 §Required Behavior`: "the version a driver reports is the
 *   version that spawned"). The reader is called on EVERY declaration, so a
 *   refresh takes a new reading rather than replaying the attach-time one.
 * * **Validation of the reported wrapper** — the write seam owns it
 *   (`assertValidGetCapabilitiesResultShape`, `assertValidCapabilityFlags`,
 *   `assertValidContractVersion`, `assertValidCliVersionReport` in
 *   `../../provider-output-validation.ts`), and re-validating here would fork
 *   the leak-safe rejection surface into two places that could disagree.
 *
 * @see Spec-005 §Required Behavior, §Per-Driver Capability Matrix
 * @see Plan-005 T3.8 (I-005-2, CP-005-5)
 * @see `docs/reference/provider-wire/claude.md`
 */

import {
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import { assertCliVersionMeetsFloor } from "../../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesResult,
  DriverCapabilitiesWriter,
} from "../../driver-capabilities-writer.js";
import type { SpawnedProviderVersionReading } from "../../version-gate.js";

import { getClaudeToolMetadata } from "./tools.js";

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

/**
 * The registry key for this driver. The capability writer keys
 * `driver_capabilities` / `driver_tools` / `driver_contract_meta` on it and
 * derives the evented capability key `provider-driver-claude` from it
 * (CP-005-5), so it is daemon-controlled identity — never provider output.
 */
export const CLAUDE_DRIVER_NAME = "claude" as const;

/**
 * The Claude driver's capability-contract version — a change-detection signal
 * for the capability writer, NOT a negotiation surface (`Spec-005 §Capability
 * discovery`). It must be a canonical identifying semver
 * (`assertValidContractVersion`), and it is bumped when the DECLARED SHAPE
 * changes (a flag's value, a tool's class, the tool census) so a node that
 * already has a row re-reads rather than trusting its cache.
 */
export const CLAUDE_CAPABILITY_CONTRACT_VERSION: string = "1.0.0";

// --------------------------------------------------------------------------
// The declaration (I-005-2)
// --------------------------------------------------------------------------

/**
 * Claude's V1 capability declaration. TOTAL over `DRIVER_CAPABILITY_FLAGS` by
 * type annotation — see this module's header for why that is the invariant's
 * enforcement rather than its documentation.
 *
 * Frozen, and `Readonly` at the type level, so a consumer that reads the
 * constant rather than copying it cannot corrupt every later declaration
 * process-wide. `getCapabilities()` still hands out a fresh spread: the freeze
 * hardens the module's own state, the copy protects the contract's mutable
 * `flags` field.
 */
export const CLAUDE_CAPABILITY_FLAGS: Readonly<Record<DriverCapabilityFlag, boolean>> =
  Object.freeze({
    // `--resume` / `--resume-session-at` on the pinned CLI surface.
    resume: true,
    // FALSE: no mid-turn content injection exists on the programmatic surface.
    // The steer intervention degrades to queue + interrupt, which is a REPORTED
    // degradation (Spec-004 §Driver-Level Steer Mechanics) — declaring `true`
    // here would silently convert that into a lost directive.
    steer: false,
    // Control-request registry: tool-permission and clarification requests.
    interactive_requests: true,
    // `--mcp-config`. Support is not visibility: this says the provider can
    // invoke MCP tools, NOT that the daemon knows their census — an
    // MCP-discovered tool still floors to `manual_reconcile_only` (`./tools.ts`).
    mcp: true,
    // Structured tool/function calling is the provider's native execution mode.
    tool_calls: true,
    // TRUE for Claude (and false for Codex): thinking/reasoning blocks are
    // exposed on the streamed output surface.
    reasoning_stream: true,
    // Model selection is mutable across turns on the pinned surface.
    model_mutation: true,
    // `--json-schema` constrains the final output to a supplied schema.
    structured_output: true,
    // Composed natively from resume-at + `--fork-session`. Conversation
    // rollback only; file-state restore is the daemon's turn-snapshot leg.
    rollback: true,
    // Driver-EMULATED (Spec-005 §Parity Capability Mechanism Grades): the goal
    // is daemon-stored and composed into the system prompt at the next turn or
    // resume boundary. The flag answers "does the driver deliver it", and it
    // does — the grade records that the delivery is not live mid-turn.
    session_goals: true,
    // Daemon-hosted ephemeral MCP server surfaces callback tools into the run.
    callback_tools: true,
    // `--agents` AgentDefinitions (provider-native in-session subagents).
    subagents: true,
    // FALSE pending the probe (Claude cell: `probe` — see the header note): no
    // stable prior-turn seeding contract is published for this provider, so the
    // declaration cannot be a constant `true` and an unprobed `true` would route
    // a switch into a replay the target may silently discard.
    transcript_replay: false,
    // TRUE for Claude (and false for Codex): `--max-budget-usd` realizes a hard
    // cost cap at spawn. Spec-016's native-cap unpriced-family escape reserves
    // only against legs whose driver declares this flag, so a wrong `true` here
    // admits unpriced work with no cap behind it.
    cost_cap: true,
  });

// --------------------------------------------------------------------------
// Seams
// --------------------------------------------------------------------------

/**
 * Takes one in-band reading of the Claude build this node spawns — resolve,
 * spawn, `get_binary_version`, floor-compare — normally
 * `readSpawnedProviderVersion` bound to this node's configured command
 * (`../../version-gate.ts`, T3.23). Injected because `getCapabilities()` takes
 * no arguments on the `ProviderDriver` interface, so the dependency is
 * constructor-bound.
 *
 * It reads a READING and not a bare report deliberately: the reading names the
 * resolved executable that answered, which is what ties this declaration to the
 * build the session will actually run and to the version the run's
 * `runtime_bindings` row records.
 *
 * A malformed report is NOT rejected here — it is rejected at the write seam
 * with the leak-safe typed error (`assertValidCliVersionReport`), which is
 * the one place provider-shaped input is adjudicated.
 */
export interface ClaudeCapabilityReporterDependencies {
  readonly readSpawnedVersion: () => Promise<SpawnedProviderVersionReading>;
}

/**
 * The write seam this module declares through — structurally a
 * `DriverCapabilitiesWriter` (Plan-005 T2.4, which performs the atomic
 * dual-write and emits `runtime_node.capability_declared` /
 * `runtime_node.capability_updated`), narrowed to the one method used.
 *
 * A `Pick` of the real class rather than a hand-written mirror: a mirror keeps
 * compiling against a writer whose `declare` signature has since moved, so the
 * drift surfaces at the call site or not at all. Depending on the SHAPE and
 * not on the construction is what keeps this module testable — a real writer
 * needs a database handle and an event-log service.
 *
 * Deliberately duplicated from the sibling `../codex/capabilities.ts` rather
 * than imported from it: the two driver trees stay import-independent, so
 * neither can break the other by moving a file.
 */
export type DriverCapabilityDeclarationSink = Pick<DriverCapabilitiesWriter, "declare">;

/** Who the declaration is recorded for. */
export interface ClaudeCapabilityDeclarationTarget {
  readonly sessionId: string;
  readonly nodeId: string;
  /** Optional actor attribution for the emitted event. */
  readonly actor?: string | null;
}

/**
 * Reports and re-declares the Claude driver's capabilities.
 *
 * Stateless with respect to the declaration itself (the flags and the tool
 * catalog are module constants); the instance exists to carry the injected
 * CLI-version reader.
 */
export class ClaudeCapabilityReporter {
  readonly #readSpawnedVersion: () => Promise<SpawnedProviderVersionReading>;

  constructor(dependencies: ClaudeCapabilityReporterDependencies) {
    this.#readSpawnedVersion = dependencies.readSpawnedVersion;
  }

  /**
   * The driver's V1 `getCapabilities()` answer.
   *
   * Every member of the returned wrapper is a FRESH object: the module
   * constants are the source of truth for the process, and a caller that
   * mutates a reply (the writer normalizes and sorts `tools` in place-adjacent
   * ways, and callers hold replies across refreshes) must not be able to
   * rewrite the next caller's declaration.
   *
   * The T3.12 floor gate sits between the read and the composition: a reading
   * below the ratified Claude floor refuses fail-closed
   * (`driver.cli_version_below_floor`) before any report exists for the
   * registry or the writer to cache — the attach path and the refresh path
   * both flow through this method, so one gate covers both. The version gate
   * compares at the READ too; the comparison is pure and idempotent, so the
   * second one closes the refresh door rather than restating a decision.
   */
  async getCapabilities(): Promise<GetCapabilitiesResult> {
    const reading = await this.#readSpawnedVersion();
    // A reading taken from another driver's build would compose Claude's flags
    // against a foreign version — a daemon wiring fault, not provider
    // misbehaviour, so it is an internal-invariant `Error`.
    if (reading.driverName !== CLAUDE_DRIVER_NAME) {
      throw new Error(
        `ClaudeCapabilityReporter: refusing a spawned-version reading taken from driver '${reading.driverName}'`,
      );
    }
    const cliVersion: DriverCliVersionReport = reading.report;
    assertCliVersionMeetsFloor(CLAUDE_DRIVER_NAME, cliVersion);
    const capabilities: DriverCapabilities = {
      flags: { ...CLAUDE_CAPABILITY_FLAGS },
      contractVersion: CLAUDE_CAPABILITY_CONTRACT_VERSION,
    };
    return {
      capabilities,
      tools: getClaudeToolMetadata(),
      cliVersion: { raw: cliVersion.raw, semver: cliVersion.semver },
    };
  }

  /**
   * The refresh trigger (CP-005-5): re-read the declaration and hand it to
   * the sink, which decides `declared` / `updated` / `noop` by comparing
   * against the stored row and emits `runtime_node.capability_declared` or
   * `runtime_node.capability_updated` accordingly. This method deliberately
   * does NOT decide which event fires — change detection lives with the
   * stored state, and a second opinion here could disagree with the row.
   *
   * WHEN this runs is not this module's business either: the 15-minute
   * cadence and its pairing with the auth probe are T3.12. This is the seam
   * that cadence drives.
   */
  async refreshDeclaration(
    sink: DriverCapabilityDeclarationSink,
    target: ClaudeCapabilityDeclarationTarget,
  ): Promise<DeclareDriverCapabilitiesResult> {
    const result = await this.getCapabilities();
    return sink.declare({
      sessionId: target.sessionId,
      nodeId: target.nodeId,
      driverName: CLAUDE_DRIVER_NAME,
      result,
      ...(target.actor !== undefined ? { actor: target.actor } : {}),
    });
  }
}
