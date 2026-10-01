/**
 * Claude driver capability declaration: the `getCapabilities()` answer (flags, contract version,
 * tools, CLI version report) and the refresh trigger that hands a fresh reading to the sink.
 *
 * - {@link CLAUDE_CAPABILITY_FLAGS} is total over `DriverCapabilityFlag`; an undeclared flag is
 *   unsupported, and support is never inferred from a method existing on the provider's wire.
 * - Order is version floor, then probe, then compose, so a refused build is never probed. A probe
 *   may withdraw a declared flag but never grant one. `detectionSource` is set only on this live
 *   read.
 */

import {
  type DriverCapabilities,
  type DriverCapabilityFlag,
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
  DriverCapabilityDeclarationSink,
} from "../../driver-capabilities-writer.js";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import type { SpawnedProviderVersionReading } from "../../version-gate.js";

import { CLAUDE_DRIVER_DESCRIPTOR } from "./claude-driver-descriptor.js";
import { getClaudeToolMetadata } from "./tools.js";
import type { DriverCliVersionReport, GetCapabilitiesResult } from "../../provider-driver.js";

/** The registry and capability-table key: daemon-controlled identity, never provider output. */
export const CLAUDE_DRIVER_NAME = "claude" as const;

/** The semver the writer compares to detect change; bump it when the declared shape changes. */
export const CLAUDE_CAPABILITY_CONTRACT_VERSION: string = "3.0.0";

/**
 * Claude's capability declaration, total over `DRIVER_CAPABILITY_FLAGS` so a new flag breaks
 * compilation until decided. Frozen; `getCapabilities()` hands out a fresh spread.
 */
export const CLAUDE_CAPABILITY_FLAGS: Readonly<Record<DriverCapabilityFlag, boolean>> =
  Object.freeze({
    // `--resume` / `--resume-session-at`.
    resume: true,
    // No mid-turn content injection exists on the programmatic surface. Steer degrades to queue
    // plus interrupt, a reported degradation; declaring `true` would turn it into a lost directive.
    steer: false,
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
    session_goals: false,
    callback_tools: true,
    // `--agents` AgentDefinitions (provider-native in-session subagents).
    subagents: true,
    // Emulated: dispatches the provider's own compaction command as a `driver_command` frame,
    // checked against the command enumeration before and typed evidence after.
    context_compaction: true,
    provider_commands: true,
    // The handshake declares an accelerated-output state; the flag does not promise the mode is
    // available (the binding holds what the provider declared).
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

  /**
   * The driver's `getCapabilities()` answer; every member is a fresh object. Throws
   * `driver.cli_version_below_floor` before any report exists, gating attach and refresh alike.
   */
  async getCapabilities(): Promise<GetCapabilitiesResult> {
    const reading = await this.#readSpawnedVersion();
    // A reading from another driver's build is a daemon wiring fault, not provider misbehavior.
    if (reading.driverName !== CLAUDE_DRIVER_NAME) {
      throw new Error(
        `ClaudeCapabilityReporter: refusing a spawned-version reading taken from driver '${reading.driverName}'`,
      );
    }
    const cliVersion: DriverCliVersionReport = reading.report;
    assertCliVersionMeetsFloor(CLAUDE_DRIVER_NAME, cliVersion);
    // Strictly after the floor gate, so a build the daemon has already refused is never probed.
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
      cliVersion: { raw: cliVersion.raw, semver: cliVersion.semver },
      detectionSource: { ...detection.detectionSource },
      // A fresh array per reply: the freeze blocks in-place edits of the constant, the copy stays
      // mutable for the consumer.
      ...(CLAUDE_CAPABILITY_FLAGS.output_speed
        ? { outputSpeedLevels: [...CLAUDE_DRIVER_DESCRIPTOR.outputSpeedLevels] }
        : {}),
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
 * One `list_models` control request against the spawned build. Returns `unknown`: the reply is
 * untrusted provider output that this module validates.
 */
export type ClaudeModelCatalogExchange = () => Promise<unknown>;

/** A `list_models` reply that could not be read as a catalog (a provider fault). */
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
 * Normalizes one `list_models` reply into the contract's model shape. Strict: anything but the
 * pinned `{ models: [...] }` shape throws {@link ClaudeModelCatalogUnreadableError}, so a dropped
 * model stays distinguishable from a parser failure.
 */
export function normalizeClaudeModelCatalog(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) {
    throw new ClaudeModelCatalogUnreadableError("reply is not an object");
  }
  const rawModels = (payload as Record<string, unknown>)["models"];
  if (!Array.isArray(rawModels)) {
    throw new ClaudeModelCatalogUnreadableError("reply has no `models` array");
  }

  // Insertion-ordered, so the catalog keeps the provider's ordering (its recommended model first).
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
    // Keyed by `resolvedModel`, not `value`: `value` is often a short alias, and a provider switch
    // validates against this list. A row that names the model beats the reserved `default` pointer.
    if (existing !== undefined && (fromPointer || !existing.fromPointer)) {
      continue;
    }
    const supportsFastMode = entry["supportsFastMode"];
    if (supportsFastMode !== undefined && typeof supportsFastMode !== "boolean") {
      throw new ClaudeModelCatalogUnreadableError(
        `model '${resolvedModel}' has an unreadable \`supportsFastMode\``,
      );
    }
    const model: ProviderModel = {
      id: resolvedModel,
      name: displayName,
      capabilities: [],
      fast: supportsFastMode === true,
    };
    // Effort levels are copied, never defaulted; absent means the model has no effort selection.
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
 * Answers `listModels()` from the live `list_models` read. A failed read propagates: no stored list
 * stands in for the provider's.
 */
export async function resolveClaudeModelCatalog(
  exchange: ClaudeModelCatalogExchange,
): Promise<ProviderModel[]> {
  return normalizeClaudeModelCatalog(await exchange());
}
