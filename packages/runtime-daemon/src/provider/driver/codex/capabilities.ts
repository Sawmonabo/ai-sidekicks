// Codex capability declaration and refresh: composes the driver's flags with the tool census into
// the `GetCapabilitiesResult` the registry caches and the writer persists.
//
// - `CODEX_CAPABILITY_FLAGS` is a total record, so a flag added to or missing from the contract's
//   flag tuple is a compile error; the registry gate fails closed on `!== true`.
// - `cliVersion` is passed through verbatim from the spawned-build reading, taken before the probe
//   so the flags describe the build whose version is reported.
// - Each flag is the matrix intersected with a zero-turn probe (`../../../capability/probe.ts`);
//   `detectionSource` records which decided it and is composed only from a live read.

import type {
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

import { getCodexToolMetadata } from "./tools.js";
import {
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  ModelCatalogUnreadableError,
} from "../contract.js";
import { isPlainObject, readNonEmptyString } from "../../record-readers.js";

/** Canonical driver id for Codex: the `driver_*` table key and the registry id. */
export const CODEX_DRIVER_NAME = "codex" as const;

/**
 * Capability-contract semver the writer compares to detect change; it moves whenever the shape of
 * what this driver advertises changes.
 */
const CODEX_CAPABILITY_CONTRACT_VERSION: string = "3.1.0";

/** A flag is `true` only where the driver delivers the capability at its own boundary. */
export const CODEX_CAPABILITY_FLAGS: Readonly<Record<DriverCapabilityFlag, boolean>> =
  Object.freeze({
    // Thread resumption is a first-class protocol operation.
    resume: true,
    // Native mid-turn steering exists on the wire (`turn/steer`).
    steer: true,
    // The provider raises typed requests the daemon answers mid-turn (approval and user input).
    interactive_requests: true,
    // The provider can invoke MCP server tools; not every server's tools are enumerable.
    mcp: true,
    // Tool invocations are surfaced as discrete, correlatable wire items.
    tool_calls: true,
    // The provider does not expose reasoning tokens on this transport.
    reasoning_stream: false,
    // Model and effort are accepted as per-turn overrides on turn start.
    model_mutation: true,
    // The turn accepts a caller-supplied output schema.
    structured_output: true,
    // Fork at an inclusive turn boundary; not probeable at the parameter level, so it resolves from
    // the matrix (a build that refuses the boundary field fails at fork dispatch).
    rollback: true,
    // `forkConversation`: a new provider conversation, the source untouched.
    session_fork: true,
    // Durable per-thread goal set/clear operations exist on the wire.
    session_goals: true,
    // The daemon's tools reach the model through its per-session MCP `url` entry.
    callback_tools: true,
    // Peer agents can be spawned, messaged, and closed from within a turn.
    subagents: true,
    // User-triggered compaction (`thread/compact/start`) announces itself like an unsolicited one.
    context_compaction: true,
    // The provider publishes an enumerable skill surface (`skills/list`) and signals invalidation.
    provider_commands: true,
    // The service tier rides thread establishment, resume and each turn, the thread declares its
    // tier back, and each model's levels are read from the catalog (`normalizeCodexModelCatalog`).
    output_speed: true,
  });

/**
 * Composes the `getCapabilities()` report from the build `reading` and probe `detection`; the
 * result is fresh, so a caller's mutation cannot corrupt a later declaration. Throws a plain
 * `Error` for a foreign or mismatched reading.
 */
export function getCodexCapabilities(
  reading: SpawnedProviderVersionReading,
  detection: CapabilityDetectionReading,
): GetCapabilitiesResult {
  // A foreign driver's reading is a daemon wiring fault, so it is a plain `Error`.
  if (reading.driverName !== CODEX_DRIVER_NAME) {
    throw new Error(
      `getCodexCapabilities: refusing a spawned-version reading taken from driver '` +
        `${reading.driverName}'`,
    );
  }
  if (detection.driverName !== CODEX_DRIVER_NAME) {
    throw new Error(
      `getCodexCapabilities: refusing a detection reading taken from driver '` +
        `${detection.driverName}'`,
    );
  }
  // Comparing recorded paths catches a `PATH` change or installer swap between the two reads.
  if (detection.boundExecutablePath !== reading.resolvedExecutablePath) {
    throw new Error(
      "getCodexCapabilities: refusing a detection reading bound to a different executable " +
        "than the version reading",
    );
  }
  const cliVersion: DriverCliVersionReport = reading.report;
  return {
    capabilities: {
      flags: applyCapabilityDetection(CODEX_CAPABILITY_FLAGS, detection),
      contractVersion: CODEX_CAPABILITY_CONTRACT_VERSION,
    },
    tools: getCodexToolMetadata(),
    cliVersion: { ...cliVersion },
    // Fresh: the reading's record is frozen and shared.
    detectionSource: { ...detection.detectionSource },
  };
}

/**
 * Takes one detection reading for the build `reading` describes. Withdrawals are reported here so
 * attach and refresh meter them through one counter.
 */
export async function readCodexCapabilityDetection(
  reading: SpawnedProviderVersionReading,
  exchange: CapabilityProbeExchange,
  diagnostics: DriverDiagnosticsEmitter,
): Promise<CapabilityDetectionReading> {
  if (reading.driverName !== CODEX_DRIVER_NAME) {
    throw new Error(
      `readCodexCapabilityDetection: refusing a spawned-version reading taken from driver '` +
        `${reading.driverName}'`,
    );
  }
  const detection = await readCapabilityDetection({
    driverName: CODEX_DRIVER_NAME,
    boundExecutablePath: reading.resolvedExecutablePath,
    exchange,
  });
  emitCapabilityDetectionDiagnostics(diagnostics, detection);
  return detection;
}

/** Caller-supplied context for one capability declaration/refresh. */
export interface CodexCapabilityRefreshInput {
  /** A fresh reading per refresh, so a mid-lifetime replacement is detectable. */
  readonly reading: SpawnedProviderVersionReading;
  /** The probe transport, held as an exchange because each refresh must probe again. */
  readonly probe: CapabilityProbeExchange;
  /** Where withdrawals are reported, so a flag a build silently stopped carrying is counted. */
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/**
 * Declares or re-declares Codex capabilities and returns the writer's verdict unchanged
 * (`"created"`, `"changed"`, `"unchanged"`), which is what makes a periodic refresh safe.
 */
export async function refreshCodexCapabilities(
  sink: DriverCapabilityDeclarationSink,
  input: CodexCapabilityRefreshInput,
): Promise<DeclareDriverCapabilitiesResult> {
  const detection = await readCodexCapabilityDetection(
    input.reading,
    input.probe,
    input.diagnostics,
  );
  return sink.declare({
    driverName: CODEX_DRIVER_NAME,
    result: getCodexCapabilities(input.reading, detection),
  });
}

/**
 * The provider's own word for standard speed: listed first on every model that publishes a tier,
 * and requested by clearing the thread's tier.
 */
export const CODEX_STANDARD_OUTPUT_SPEED = "default";

// The name the catalog gives the tier that speeds output up; its id is free-form.
const CODEX_FAST_TIER_NAME = "Fast";

/**
 * One `model/list` request on the driver's existing connection, returning `unknown` because the
 * reply is untrusted. It starts no turn, so a billed turn is unrepresentable.
 */
export type CodexModelCatalogExchange = () => Promise<unknown>;

function codexCatalogUnreadable(detail: string): ModelCatalogUnreadableError {
  return new ModelCatalogUnreadableError("Codex model/list", detail);
}

/**
 * Strictly normalizes one `model/list` reply, throwing {@link ModelCatalogUnreadableError}
 * for the whole reply on any fault. Refuses a paginated reply, a duplicate id, a present
 * non-array effort or service-tier list and a tier with no id; drops hidden rows.
 */
export function normalizeCodexModelCatalog(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) {
    throw codexCatalogUnreadable("reply is not an object");
  }
  const reply = payload as Record<string, unknown>;
  const rawModels = reply["data"];
  if (!Array.isArray(rawModels)) {
    throw codexCatalogUnreadable("reply has no `data` array");
  }
  // Answering the first page alone would publish a silently short model list.
  const nextCursor = reply["nextCursor"];
  if (nextCursor !== null && nextCursor !== undefined) {
    throw codexCatalogUnreadable("reply is paginated and this driver reads a single page");
  }

  const models: ProviderModel[] = [];
  const seenIds = new Set<string>();
  for (const rawEntry of rawModels) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw codexCatalogUnreadable("a `data` entry is not an object");
    }
    const entry = rawEntry as Record<string, unknown>;
    const id = readNonEmptyString(entry, "id");
    if (id === undefined) {
      throw codexCatalogUnreadable("a `data` entry has no `id`");
    }
    // This surface has no alias mechanism, so a duplicate id is a malformed reply.
    if (seenIds.has(id)) {
      throw codexCatalogUnreadable(`model '${id}' appears twice`);
    }
    seenIds.add(id);
    if (entry["hidden"] === true) {
      continue;
    }
    const displayName = readNonEmptyString(entry, "displayName");
    if (displayName === undefined) {
      throw codexCatalogUnreadable(`model '${id}' has no \`displayName\``);
    }
    const rawServiceTiers = entry["serviceTiers"];
    if (
      rawServiceTiers !== undefined &&
      rawServiceTiers !== null &&
      !Array.isArray(rawServiceTiers)
    ) {
      throw codexCatalogUnreadable(`model '${id}' has an unreadable \`serviceTiers\``);
    }
    const tierIds: string[] = [];
    let hasFastTier = false;
    for (const rawServiceTier of Array.isArray(rawServiceTiers) ? rawServiceTiers : []) {
      // A tier is `{ id, name, description }`; the id is what a turn request carries.
      const tier = isPlainObject(rawServiceTier) ? rawServiceTier : undefined;
      const tierId = tier === undefined ? undefined : readNonEmptyString(tier, "id");
      if (tier === undefined || tierId === undefined) {
        throw codexCatalogUnreadable(`model '${id}' has an unreadable service-tier entry`);
      }
      tierIds.push(tierId);
      hasFastTier ||= tier["name"] === CODEX_FAST_TIER_NAME;
    }
    const model: ProviderModel = {
      id,
      name: displayName,
      capabilities: [],
      // A tier list alone is not fast output: a model could list only a slower tier.
      fast: hasFastTier,
    };
    // Absent, not empty, when the model publishes no tier: it has no speed selection. Standard
    // leads, so a person can ask for it back; a tier the provider itself names so is not doubled.
    if (tierIds.length > 0) {
      model.outputSpeedLevels = [
        CODEX_STANDARD_OUTPUT_SPEED,
        ...tierIds.filter((tierId) => tierId !== CODEX_STANDARD_OUTPUT_SPEED),
      ];
    }
    // `null` counts as absence: refusing it would cost the whole catalog, as any entry fault does.
    const rawEfforts = entry["supportedReasoningEfforts"];
    if (rawEfforts !== undefined && rawEfforts !== null && !Array.isArray(rawEfforts)) {
      throw codexCatalogUnreadable(`model '${id}' has an unreadable \`supportedReasoningEfforts\``);
    }
    if (Array.isArray(rawEfforts) && rawEfforts.length > 0) {
      const effortLevels: string[] = [];
      for (const rawEffort of rawEfforts) {
        // The level rides a nested object here (`{ reasoningEffort, description }`).
        const level = isPlainObject(rawEffort)
          ? readNonEmptyString(rawEffort, "reasoningEffort")
          : undefined;
        if (level === undefined) {
          throw codexCatalogUnreadable(`model '${id}' has an unreadable reasoning-effort entry`);
        }
        effortLevels.push(level);
      }
      model.effortLevels = effortLevels;
    }
    models.push(model);
  }
  return models;
}

/**
 * Answers `listModels()` from the live `model/list` read. A failed read propagates: no stored list
 * stands in for the provider's.
 */
export async function resolveCodexModelCatalog(
  exchange: CodexModelCatalogExchange,
): Promise<ProviderModel[]> {
  return normalizeCodexModelCatalog(await exchange());
}
