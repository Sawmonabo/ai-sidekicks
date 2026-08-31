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
 * * **Probe-based declaration + `detectionSource`** — LANDED (T3.24).
 *   `Spec-005 §Capability discovery` binds every flag carrying an *admissible*
 *   probe to be read from the installed build and to carry its detection source
 *   on the report. `../../capability-probe.ts` owns the mechanism table, the
 *   probes, their negative control, and the withdraw-only resolution; what this
 *   module owns is the ORDERING — floor first, probe second, compose third — so
 *   no probe is ever issued against a build the daemon has already refused.
 *   {@link CLAUDE_CAPABILITY_FLAGS} remains the declaration a probe INTERSECTS
 *   with: a probe may withdraw a flag from a build that turns out not to carry
 *   the surface, and may never grant one this driver does not implement.
 *   `detectionSource` is composed only on this live read; the writer's
 *   `hydrate()` reconstruction leaves it absent, which is specified to read as
 *   cache reconstruction rather than as unknown provenance.
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
  type ProviderModel,
} from "@ai-sidekicks/contracts";

import {
  applyCapabilityDetection,
  readCapabilityDetection,
  type CapabilityDetectionReading,
  type CapabilityProbeExchange,
} from "../../capability-probe.js";
import {
  assertCliVersionMeetsFloor,
  emitCapabilityDetectionDiagnostics,
} from "../../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesResult,
  DriverCapabilitiesWriter,
} from "../../driver-capabilities-writer.js";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
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
    // TRUE, and EMULATED: the provider publishes no compaction method, so this
    // driver dispatches the provider's OWN compaction command as a
    // `driver_command` frame — the one tripwire-exempt origin, admitted only
    // against the two guards `Spec-005 §Required Behavior` requires of it
    // (pre-dispatch presence in the provider's own enumeration, post-dispatch
    // typed evidence). The flag answers "does the driver deliver it", and it
    // does; the grade records that the delivery is not a native method.
    context_compaction: true,
    // TRUE: the session handshake enumerates the provider's own command and
    // skill sets, so the enumeration is a read of what the provider published
    // rather than anything this driver composes.
    provider_commands: true,
    // TRUE for Claude (and false for Codex): the handshake declares an
    // accelerated-output state, and — when that state is not the requested one —
    // a machine-readable reason. Declaring the flag does NOT promise the mode is
    // available: what the provider actually declared is a separate binding-held
    // observation, and the two are never rewritten into each other.
    output_speed: true,
  });

/**
 * Claude's output-speed value vocabulary — the SETTABLE levels.
 *
 * `Spec-005 §Provider Parameter Vocabularies` requires a driver declaring
 * `output_speed` to publish this set, and `Spec-005 §The output-speed axis`
 * requires it to come from this table rather than from the provider: obtaining
 * the provider's declared state costs a turn-bearing request, which is the very
 * conjunct that makes the flag `static`, so a vocabulary sourced by reading
 * would contradict its own detection source.
 *
 * SETTABLE is the operative word, and it is why this set is narrower than the
 * states the provider can REPORT. The pinned build declares its state from a
 * three-value vocabulary, but the third is a provider-entered condition after a
 * rate limit rather than something a participant may ask for. A caller can
 * therefore request only the two ends of the toggle, while
 * `ProviderOutputSpeedState.declared` carries whatever the provider reported —
 * VERBATIM, including a value absent from this list, because that is a real
 * state under version skew and coercing it would fabricate a reading.
 */
export const CLAUDE_OUTPUT_SPEED_LEVELS: readonly string[] = Object.freeze(["off", "on"]);

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
  /**
   * The zero-turn probe transport (T3.24) — a control-request exchange against
   * the same resolved build `readSpawnedVersion` read. Injected as the SEAM and
   * not as a reading, because every declaration re-probes: the refresh cadence
   * drives {@link ClaudeCapabilityReporter.refreshDeclaration}, and a detection
   * reading captured once would report attach-time provenance for a build that
   * may since have been replaced.
   *
   * REQUIRED, with no default. A default would let a caller compose a
   * declaration whose provenance claims a probe nobody ran.
   */
  readonly probe: CapabilityProbeExchange;
  /**
   * The daemon diagnostic channel the detection read reports withdrawals on.
   *
   * REQUIRED for the same reason the refresh scheduler's emitter is: a flag a
   * build silently stopped carrying is exactly the class of condition the
   * closed-kind-plus-counter pairing exists to keep metered, and an optional
   * emitter would let a whole node's withdrawals go uncounted. Constructor-bound
   * because `getCapabilities()` takes no arguments, and reported from THERE
   * rather than from the refresh entry point so attach and refresh meter the
   * same fact through the same counter.
   */
  readonly diagnostics: DriverDiagnosticsEmitter;
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
  readonly #probe: CapabilityProbeExchange;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeCapabilityReporterDependencies) {
    this.#readSpawnedVersion = dependencies.readSpawnedVersion;
    this.#probe = dependencies.probe;
    this.#diagnostics = dependencies.diagnostics;
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
    // STRICTLY AFTER the floor gate. `Spec-005` refuses every use of a
    // below-floor build beyond the version handshake itself, and a probe is such
    // a use — so a build this daemon has already refused is never asked what it
    // can do. Sequencing this read rather than racing it with the version read
    // is what makes that ordering structural.
    const detection: CapabilityDetectionReading = await readCapabilityDetection({
      driverName: CLAUDE_DRIVER_NAME,
      // Bound to the executable the version handshake resolved, taken from that
      // same reading rather than resolved again — so the version and the flags
      // are provably about one build even if a `PATH` change or an installer
      // swap lands between the two reads.
      boundExecutablePath: reading.resolvedExecutablePath,
      exchange: this.#probe,
    });
    emitCapabilityDetectionDiagnostics(this.#diagnostics, detection);
    const capabilities: DriverCapabilities = {
      flags: applyCapabilityDetection(CLAUDE_CAPABILITY_FLAGS, detection),
      contractVersion: CLAUDE_CAPABILITY_CONTRACT_VERSION,
    };
    return {
      capabilities,
      tools: getClaudeToolMetadata(),
      cliVersion: { raw: cliVersion.raw, semver: cliVersion.semver },
      detectionSource: { ...detection.detectionSource },
      // Present iff the flag is, and a FRESH array on every reply.
      //
      // The two mechanisms do different jobs and the split is worth stating,
      // because attributing the protection to the copy alone would be wrong.
      // The FREEZE is what makes corruption impossible: the module constant is
      // shared, and a consumer that pushed onto it would rewrite every later
      // reply process-wide — so a reply handing back the constant itself would
      // instead throw a TypeError into a caller composing on a value it believes
      // it owns. The COPY is what keeps the published member an ordinary mutable
      // array, so a consumer may sort, filter, or extend its own copy without a
      // surprising throw and without reaching any other reader.
      ...(CLAUDE_CAPABILITY_FLAGS.output_speed
        ? { outputSpeedLevels: [...CLAUDE_OUTPUT_SPEED_LEVELS] }
        : {}),
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

// --------------------------------------------------------------------------
// The model catalog (T3.12 C-8)
// --------------------------------------------------------------------------

/**
 * GOLDEN VECTOR — the Claude model catalog this driver declares.
 *
 *   Source doc      : `docs/reference/provider-wire/claude.md`
 *   Section         : §Control requests (`list_models` answers
 *                     `{"subtype":"success", …}`)
 *   Pin             : Claude Code 2.1.251
 *   Provenance      : Binary probe. One live `claude -p --input-format
 *                     stream-json` control request `{"subtype":"list_models"}`
 *                     against the on-disk build on 2026-08-30. Zero-turn: no
 *                     user message is sent, `num_turns` stays 0, and nothing is
 *                     billed.
 *   Trust           : Verified at 2.1.251. Every id, name, and effort level
 *                     below is a reading, not an illustration.
 *   Derived by      : Plan-005 T3.12 (currency duty C-8).
 *
 * WHY A DECLARATION EXISTS AT ALL, given the read is admissible.
 *
 * `Spec-005 §Capability discovery` treats a value obtainable by a zero-turn,
 * non-mutating, decisive read as one that must be READ from the installed
 * build. This catalog is exactly that, which is why {@link
 * ClaudeModelCatalogExchange} is the preferred source and why this constant is
 * NOT presented as truth about the running build. It is the answer for a
 * composition that has bound no exchange — a real state while no production
 * composition root exists — and it is stamped above so a reader can tell a
 * reading from a declaration without trusting this file's say-so.
 *
 * WHAT IS DELIBERATELY NOT COPIED FROM THE PROBE.
 *
 * * **Alias rows.** The wire answers five entries for four models: `default`
 *   and `opus[1m]` both resolve to `claude-opus-5[1m]`. The reserved pointer
 *   `default` names whichever model is currently default rather than naming a
 *   model, so it is collapsed — see {@link normalizeClaudeModelCatalog}.
 * * **The per-model auxiliary axes** (`supportsAdaptiveThinking`,
 *   `supportsFastMode`, `supportsAutoMode`). They are recorded here rather than
 *   flattened into `capabilities`, which carries no registered vocabulary
 *   anywhere in the corpus and is read by nothing: populating it would mint a
 *   tag set ahead of its reader, and one shared string list cannot mean both
 *   "this model has a fast mode" and whatever the sibling provider's per-model
 *   axes mean. At the pin, both `claude-opus-5[1m]` rows carry all three;
 *   `claude-fable-5` and `claude-sonnet-5` carry adaptive-thinking and
 *   auto-mode but not fast-mode; `claude-haiku-4-5-20251001` carries none.
 * * **A provider-wide effort vocabulary.** There is none to copy: the levels
 *   are a per-model list, and `claude-haiku-4-5-20251001` publishes no effort
 *   surface at all — the live instance of the registered "absent = the model
 *   exposes no effort selection" reading.
 */
/**
 * One declared catalog entry, frozen at construction.
 *
 * `capabilities` is `[]` by CONSTRUCTION rather than by omission — the helper
 * takes no argument for it, so no declaration can populate a member the corpus
 * registers no vocabulary for and nothing reads.
 */
function declaredClaudeModel(
  id: string,
  name: string,
  effortLevels?: readonly string[],
): ProviderModel {
  return Object.freeze({
    id,
    name,
    capabilities: freezeDeclaredModelArray([]),
    ...(effortLevels === undefined
      ? {}
      : { effortLevels: freezeDeclaredModelArray([...effortLevels]) }),
  });
}

/**
 * Freeze one nested catalog array WITHOUT widening its declared type.
 *
 * `Object.freeze` on the entry alone is shallow: it stops `entry.effortLevels =
 * […]` and does nothing about `entry.effortLevels.push(…)`, so a process-wide
 * constant re-exported from this driver's barrel was one `push` away from being
 * rewritten for every later caller. `ProviderModel` declares these members as
 * MUTABLE `string[]`, and this returns the same declared type rather than
 * `readonly string[]` on purpose: making the contract type deep-readonly would
 * ripple through every driver-constructed catalog and every normalizer that
 * builds one, to fix a hazard that only exists for the two shared constants.
 * The freeze is therefore a runtime property of these declarations, enforced by
 * a mutation-attempt test rather than by the type.
 */
function freezeDeclaredModelArray(values: string[]): string[] {
  Object.freeze(values);
  return values;
}

/** The effort vocabulary every effort-bearing Claude model publishes at the pin. */
const CLAUDE_PINNED_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const CLAUDE_DECLARED_MODEL_CATALOG: readonly ProviderModel[] = Object.freeze([
  declaredClaudeModel("claude-opus-5[1m]", "Opus (1M context)", CLAUDE_PINNED_EFFORT_LEVELS),
  declaredClaudeModel("claude-fable-5", "Fable", CLAUDE_PINNED_EFFORT_LEVELS),
  declaredClaudeModel("claude-sonnet-5", "Sonnet", CLAUDE_PINNED_EFFORT_LEVELS),
  // No `effortLevels`, and that is the reading rather than an omission: this
  // row answers with no `supportsEffort` and no `supportedEffortLevels`.
  declaredClaudeModel("claude-haiku-4-5-20251001", "Haiku"),
]);

/**
 * The live model-catalog read seam — one `list_models` control request against
 * the build this driver spawns.
 *
 * Returns `unknown` for the same reason {@link CapabilityProbeExchange} does:
 * everything it yields is UNTRUSTED provider output. The implementer dispatches
 * against the connection it already holds and owns the deadline; THIS module
 * composes and adjudicates, so the normalization is testable without a process
 * and a wire-shape change surfaces here rather than in a transport.
 *
 * Deliberately payload-free and turn-free: like the capability probe, a billed
 * turn is not merely forbidden, it is unrepresentable.
 */
export type ClaudeModelCatalogExchange = () => Promise<unknown>;

/**
 * A `list_models` reply that could not be read as a catalog.
 *
 * Carries no `code`, on the capability-probe module's reasoning: this is a
 * provider-surface fault with no registered wire code, and inventing one would
 * mint an error contract this task may not mint.
 */
export class ClaudeModelCatalogUnreadableError extends Error {
  constructor(detail: string) {
    super(`Claude list_models reply is not a readable model catalog: ${detail}`);
    this.name = "ClaudeModelCatalogUnreadableError";
  }
}

/** The reserved `value` that points at whichever model is currently default. */
const CLAUDE_DEFAULT_MODEL_POINTER = "default";

function readNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize one `list_models` reply into the contract's model shape.
 *
 * STRICT, not tolerant. The accepted shape is the one the pinned build answers
 * — `{ models: [...] }` — and nothing else; a reply that merely resembles it is
 * refused rather than partially read, because a tolerant reader would answer a
 * short catalog for a shape change and nothing downstream could tell a provider
 * that dropped a model from a parser that failed to see it.
 *
 * Two rules the wire forces, each the reason the corresponding branch exists:
 *
 *   1. **Alias collapse.** Entries are keyed by `resolvedModel`, not by
 *      `value`: at the pin, four of five `value`s are short aliases
 *      (`sonnet` → `claude-sonnet-5`), so keying on `value` would publish
 *      selector strings as model ids — and `Spec-016 §Same-Agent Provider
 *      Switch` validates a switch's model against this list, so an alias
 *      admitted here is a switch whose target can move under the participant.
 *      Where several entries resolve to one model, the reserved
 *      `default` pointer loses to a row that names the model, and it is kept
 *      only when it is that model's only row.
 *   2. **Effort presence is copied, never defaulted.** `effortLevels` is
 *      emitted only where the row publishes a non-empty level list AND does not
 *      explicitly say `supportsEffort: false`. An absent list stays absent: the
 *      contract reads that as "no effort selection", which is precisely what
 *      the Haiku row means.
 */
export function normalizeClaudeModelCatalog(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) {
    throw new ClaudeModelCatalogUnreadableError("reply is not an object");
  }
  const rawModels = (payload as Record<string, unknown>)["models"];
  if (!Array.isArray(rawModels)) {
    throw new ClaudeModelCatalogUnreadableError("reply has no `models` array");
  }

  // Insertion-ordered, so the catalog keeps the provider's own ordering — the
  // provider lists its recommended model first and a reordering here would
  // silently re-rank what a client renders.
  const byResolvedModel = new Map<string, { model: ProviderModel; fromPointer: boolean }>();
  for (const rawEntry of rawModels) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw new ClaudeModelCatalogUnreadableError("a `models` entry is not an object");
    }
    const entry = rawEntry as Record<string, unknown>;
    const resolvedModel = readNonEmptyString(entry, "resolvedModel");
    if (resolvedModel === undefined) {
      throw new ClaudeModelCatalogUnreadableError("a `models` entry has no `resolvedModel`");
    }
    const displayName = readNonEmptyString(entry, "displayName");
    if (displayName === undefined) {
      throw new ClaudeModelCatalogUnreadableError(
        `model '${resolvedModel}' has no \`displayName\``,
      );
    }
    const fromPointer = entry["value"] === CLAUDE_DEFAULT_MODEL_POINTER;
    const existing = byResolvedModel.get(resolvedModel);
    // A row that names the model beats the reserved pointer, in either arrival
    // order — the pointer arrives first at the pin, and relying on that would
    // make the rule an accident of the vendor's ordering.
    if (existing !== undefined && (fromPointer || !existing.fromPointer)) {
      continue;
    }
    const model: ProviderModel = { id: resolvedModel, name: displayName, capabilities: [] };
    const effortLevels = entry["supportedEffortLevels"];
    if (
      entry["supportsEffort"] !== false &&
      Array.isArray(effortLevels) &&
      effortLevels.length > 0
    ) {
      if (!effortLevels.every((level): level is string => typeof level === "string")) {
        throw new ClaudeModelCatalogUnreadableError(
          `model '${resolvedModel}' has a non-string effort level`,
        );
      }
      model.effortLevels = [...effortLevels];
    }
    byResolvedModel.set(resolvedModel, { model, fromPointer });
  }

  return [...byResolvedModel.values()].map((held) => held.model);
}

/**
 * Answer the Claude driver's `listModels()`.
 *
 * @param exchange The live read, or an EXPLICIT `null` for a composition that
 *   binds none. Null rather than optional so a construction site cannot arrive
 *   at the declaration by never having decided — the reasoning that makes the
 *   capability probe and the credential-env policy required options rather than
 *   defaulted ones.
 *
 * A bound exchange that FAILS is never quietly answered from the declaration.
 * Serving a stale catalog under the appearance of a live read is the one
 * confusion the detection-source doctrine exists to prevent, so a read failure
 * propagates and only an unbound exchange reaches the declaration.
 */
export async function resolveClaudeModelCatalog(
  exchange: ClaudeModelCatalogExchange | null,
): Promise<ProviderModel[]> {
  if (exchange === null) {
    // Fresh copies: the constant is frozen and shared process-wide, and
    // `ProviderModel` carries mutable arrays a caller could otherwise rewrite
    // for every later caller.
    return CLAUDE_DECLARED_MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      capabilities: [...model.capabilities],
      ...(model.effortLevels === undefined ? {} : { effortLevels: [...model.effortLevels] }),
    }));
  }
  return normalizeClaudeModelCatalog(await exchange());
}
