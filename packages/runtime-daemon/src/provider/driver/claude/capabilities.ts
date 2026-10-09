/**
 * Claude driver capability declaration: the `getCapabilities()` answer (flags, contract version,
 * tools, CLI version report) and the refresh trigger that hands a fresh reading to the sink.
 *
 * - {@link CLAUDE_CAPABILITY_FLAGS} is total over `DriverCapabilityFlag`; an undeclared flag is
 *   unsupported, and support is never inferred from a method existing on the provider's wire.
 * - Order is version read, then probe, then compose, so the flags describe the build whose version
 *   is reported. A probe may withdraw a declared flag but never grant one. `detectionSource` is set
 *   only on this live read.
 */

import type {
  DriverCapabilities,
  DriverCapabilityFlag,
  ProviderModel,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";

import {
  applyCapabilityDetection,
  readCapabilityDetection,
  type CapabilityDetectionReading,
  type CapabilityProbeExchange,
} from "../../capability/probe.js";
import { emitCapabilityDetectionDiagnostics } from "../../capability/refresh.js";
import type {
  DeclareDriverCapabilitiesResult,
  DriverCapabilityDeclarationSink,
} from "../capabilities-writer.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import type { SpawnedProviderVersionReading } from "../../spawned-version.js";
import type { SpawnEnvPair } from "../../spawn-env.js";

import { composeStaticOutputSpeedLevels } from "../descriptor.js";
import { getClaudeToolMetadata } from "./tools.js";
import {
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  ModelCatalogUnreadableError,
} from "../contract.js";
import { readNonEmptyString } from "../../record-readers.js";
import type { ClaudeModelFigures } from "./session/model-figures.js";
import type { ClaudeModelCatalogReading } from "./session/transport.js";

/** The registry and capability-table key: daemon-controlled identity, never provider output. */
export const CLAUDE_DRIVER_NAME = "claude" as const;

/** The semver the writer compares to detect change; bump it when the declared shape changes. */
const CLAUDE_CAPABILITY_CONTRACT_VERSION: string = "4.0.0";

/**
 * Claude's capability declaration, total over `DRIVER_CAPABILITY_FLAGS` so a new flag breaks
 * compilation until decided. Frozen; `getCapabilities()` hands out a fresh spread.
 */
const CLAUDE_CAPABILITY_FLAGS: Readonly<Record<DriverCapabilityFlag, boolean>> = Object.freeze({
  // `--resume` / `--resume-session-at`.
  resume: true,
  // A steer is a user message written into the running turn, which Claude Code reads at its next
  // step; one it has not read yet is taken back with `cancel_async_message`.
  steer: true,
  // Control-request registry: tool-permission and clarification requests.
  interactive_requests: true,
  // `--mcp-config`. The provider can invoke MCP tools, but the daemon has no census of them: an
  // MCP-discovered tool still floors to `manual_reconcile_only` (`./tools.ts`).
  mcp: true,
  tool_calls: true,
  reasoning_stream: true,
  model_mutation: true,
  // `--json-schema` constrains the final output to a supplied schema.
  structured_output: true,
  // Composed from resume-at plus `--fork-session`.
  rollback: true,
  // `moveSessionToFork`: the session moves onto a conversation forked from its own.
  session_fork: true,
  // Claude Code's own `/goal <condition>` and `/goal clear`, sent as command messages.
  session_goals: true,
  callback_tools: true,
  // Claude Code's own helpers through its helper tool, the session's helper definitions declared
  // as `initialize.agents`, held to `Helpers at once` by a hook.
  subagents: true,
  // Emulated: dispatches the provider's own compaction command as a `driver_command` frame,
  // checked against the command enumeration before and typed evidence after.
  context_compaction: true,
  provider_commands: true,
  // The `initialize` reply declares an accelerated-output state; the flag does not promise the
  // mode is available (the binding holds what the provider declared).
  output_speed: true,
});

/** Constructor dependencies of {@link ClaudeCapabilityReporter}. */
export interface ClaudeCapabilityReporterDependencies {
  /**
   * One in-band reading of the spawned build (normally `readSpawnedProviderVersion`); its resolved
   * executable ties the declaration to the build the session will run.
   */
  readonly readSpawnedVersion: () => Promise<SpawnedProviderVersionReading>;
  /** The zero-turn probe transport; a seam, since a reading captured once could go stale. */
  readonly probe: CapabilityProbeExchange;
  /** Reports flag withdrawals; required so they cannot go uncounted. */
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/** Reports and re-declares the Claude driver's capabilities. */
export class ClaudeCapabilityReporter {
  readonly #readSpawnedVersion: () => Promise<SpawnedProviderVersionReading>;
  readonly #probe: CapabilityProbeExchange;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeCapabilityReporterDependencies) {
    this.#readSpawnedVersion = dependencies.readSpawnedVersion;
    this.#probe = dependencies.probe;
    this.#diagnostics = dependencies.diagnostics;
  }

  /** The driver's `getCapabilities()` answer; every member is a fresh object. */
  async getCapabilities(): Promise<GetCapabilitiesResult> {
    const reading = await this.#readSpawnedVersion();
    // A reading from another driver's build is a daemon wiring fault, not provider misbehavior.
    if (reading.driverName !== CLAUDE_DRIVER_NAME) {
      throw new Error(
        `ClaudeCapabilityReporter: refusing a spawned-version reading taken from driver '` +
          `${reading.driverName}'`,
      );
    }
    const cliVersion: DriverCliVersionReport = reading.report;
    const detection: CapabilityDetectionReading = await readCapabilityDetection({
      driverName: CLAUDE_DRIVER_NAME,
      // The executable the version handshake resolved, not resolved again, so the version and the
      // flags describe one build even if a `PATH` change lands between the reads.
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
      cliVersion: { ...cliVersion },
      detectionSource: { ...detection.detectionSource },
      // Keyed on the resolved flag: a probe that withdrew `output_speed` takes its levels with it.
      ...composeStaticOutputSpeedLevels(CLAUDE_DRIVER_NAME, capabilities.flags),
    };
  }

  /** Re-reads the declaration and hands it to `sink`, which decides whether it changed. */
  async refreshDeclaration(
    sink: DriverCapabilityDeclarationSink,
  ): Promise<DeclareDriverCapabilitiesResult> {
    const result = await this.getCapabilities();
    return sink.declare({ driverName: CLAUDE_DRIVER_NAME, result });
  }
}

/**
 * One read of the catalog from a short control-only process: its `initialize` reply and its
 * `get_context_usage` reply. The replies are untrusted provider output that this module validates.
 */
type ClaudeModelCatalogExchange = () => Promise<ClaudeModelCatalogReading>;

function claudeCatalogUnreadable(detail: string): ModelCatalogUnreadableError {
  return new ModelCatalogUnreadableError("Claude initialize", detail);
}

/** The reserved `value` that points at whichever model is currently default. */
const CLAUDE_DEFAULT_MODEL_POINTER = "default";

/** The suffix Claude Code puts on a model id for that model's 1M-token window. */
const CLAUDE_LARGER_WINDOW_MARK = "[1m]";

// Whether the model id carries Claude Code's documented `[1m]` mark for the model's 1M window.
function hasClaudeLargerWindowMark(modelId: string): boolean {
  return modelId.endsWith(CLAUDE_LARGER_WINDOW_MARK);
}

/**
 * Normalizes the `models` of one `initialize` reply into the contract's model shape. Strict:
 * anything but the pinned `{ models: [...] }` shape throws {@link ModelCatalogUnreadableError}, so
 * a dropped model stays distinguishable from a parser failure.
 */
export function normalizeClaudeModelCatalog(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) {
    throw claudeCatalogUnreadable("reply is not an object");
  }
  const rawModels = (payload as Record<string, unknown>)["models"];
  if (!Array.isArray(rawModels)) {
    throw claudeCatalogUnreadable("reply has no `models` array");
  }

  // Insertion-ordered, so the catalog keeps the provider's ordering (its recommended model first).
  const byResolvedModel = new Map<string, { model: ProviderModel; fromPointer: boolean }>();
  for (const rawEntry of rawModels) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw claudeCatalogUnreadable("a `models` entry is not an object");
    }
    const entry = rawEntry as Record<string, unknown>;
    const resolvedModel = readNonEmptyString(entry, "resolvedModel");
    if (resolvedModel === undefined) {
      throw claudeCatalogUnreadable("a `models` entry has no `resolvedModel`");
    }
    const displayName = readNonEmptyString(entry, "displayName");
    if (displayName === undefined) {
      throw claudeCatalogUnreadable(`model '${resolvedModel}' has no \`displayName\``);
    }
    const fromPointer = entry["value"] === CLAUDE_DEFAULT_MODEL_POINTER;
    const existing = byResolvedModel.get(resolvedModel);
    // Keyed by `resolvedModel`, not `value`: `value` is often a short alias, and a provider switch
    // validates against this list. A row that names the model beats the reserved `default` pointer.
    if (existing !== undefined && (fromPointer || !existing.fromPointer)) {
      continue;
    }
    const supportsFastMode = entry["supportsFastMode"];
    if (supportsFastMode !== undefined && typeof supportsFastMode !== "boolean") {
      throw claudeCatalogUnreadable(
        `model '${resolvedModel}' has an unreadable \`supportsFastMode\``,
      );
    }
    const model: ProviderModel = {
      id: resolvedModel,
      name: displayName,
      capabilities: [],
      fast: supportsFastMode === true,
      // Read from the id alone, never the label, which is display text.
      largerWindow: hasClaudeLargerWindowMark(resolvedModel),
    };
    // Effort levels are copied, never defaulted; absent means the model has no effort selection.
    const effortLevels = entry["supportedEffortLevels"];
    if (
      entry["supportsEffort"] !== false &&
      Array.isArray(effortLevels) &&
      effortLevels.length > 0
    ) {
      if (!effortLevels.every((level): level is string => typeof level === "string")) {
        throw claudeCatalogUnreadable(`model '${resolvedModel}' has a non-string effort level`);
      }
      model.effortLevels = [...effortLevels];
    }
    byResolvedModel.set(resolvedModel, { model, fromPointer });
  }

  return [...byResolvedModel.values()].map((held) => held.model);
}

/**
 * Answers `listModels()` from one live read in `spawnEnvironment`: the catalog, each row with the
 * context window held for its model id at that environment's endpoint, the one this read's
 * `get_context_usage` reported among them; a row whose model no read has reached carries none. A
 * failed read propagates: no stored list stands in for the provider's.
 */
export async function resolveClaudeModelCatalog(
  exchange: ClaudeModelCatalogExchange,
  figures: Pick<ClaudeModelFigures, "recordContextReads" | "contextWindowOf">,
  spawnEnvironment: readonly SpawnEnvPair[],
): Promise<ProviderModel[]> {
  const reading = await exchange();
  const models = normalizeClaudeModelCatalog(reading.initialize);
  figures.recordContextReads(spawnEnvironment, [
    { requestedModel: undefined, usage: reading.contextUsage },
  ]);
  return models.map((model) => {
    const contextWindow = figures.contextWindowOf(spawnEnvironment, model.id);
    return contextWindow === undefined ? model : { ...model, contextWindow };
  });
}
