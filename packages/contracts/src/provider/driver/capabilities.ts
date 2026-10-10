// What a driver offers a client (its models and modes, its capability flags and contract version)
// and the execution posture a driver spawns and runs a turn under. The schemas that parse the
// first three on the `driver.list*` replies are in `./methods.ts`, beside those replies; the driver
// interface and the shapes only the daemon reads are in the daemon.
import type { PermissionLevel } from "../../session/controls/methods.js";

/** One selectable model of one provider, normalized at the driver's boundary (`listModels`). */
export interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
  // The model's reasoning-effort vocabulary, carried per model because levels differ between
  // providers and between models of one provider. A `string[]`, not a closed union, so a level the
  // installed build offers is never refused. Absent means the model has no effort axis.
  effortLevels?: string[] | undefined;
  // The model's output-speed vocabulary where its provider publishes one per model (Codex's
  // service-tier ids), carried verbatim. Absent means the model exposes no speed selection; a
  // provider that publishes no per-model set has its set on the capability report instead.
  outputSpeedLevels?: string[] | undefined;
  // Whether the model has a fast output mode, as its provider reports it (Claude Code's
  // `supportsFastMode`, the Codex tier its catalog names `Fast`). Required so a missing reading
  // never looks like "no fast mode".
  fast: boolean;
  // Whether this row is the model's larger window, offered beside its default row; the driver fills
  // it from the provider (Codex's catalog `max_context_window`, Claude Code's `[1m]` mark on the
  // model id). On Codex the row's `contextWindow` is the figure a pick of it records; a Claude
  // larger row is picked by its own id.
  largerWindow: boolean;
  // The window in tokens as the provider reports it. Absent until a reading arrives; nothing fills
  // it from a table or a default.
  contextWindow?: number | undefined;
}

/**
 * The catalog row a choice names. A model's default row and its larger-window row share the
 * model's id, so a row is found by its id and its `largerWindow` together, never by the id alone.
 */
export function findProviderModelRow<Row extends Pick<ProviderModel, "id" | "largerWindow">>(
  rows: readonly Row[],
  modelId: string,
  largerWindow: boolean,
): Row | undefined {
  return rows.find((row) => row.id === modelId && row.largerWindow === largerWindow);
}

/** One selectable mode of one provider, normalized at the driver's boundary (`listModes`). */
export interface ProviderMode {
  id: string;
  name: string;
}

/**
 * Driver capability flags in canonical order; the database CHECK list and every total
 * `Record<DriverCapabilityFlag, boolean>` follow it, and the daemon stores one row per flag.
 */
export const DRIVER_CAPABILITY_FLAGS = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "structured_output",
  "rollback",
  // Moves the session onto a new provider conversation forked from the bound one at a message,
  // through `moveSessionToFork`; never an undo.
  "session_fork",
  "session_goals",
  "callback_tools",
  "subagents",
  // User-triggered compaction of the bound session's provider-side context via `compactContext`.
  // Native on Codex; on Claude Code the driver sends `/compact` as a driver command.
  "context_compaction",
  // A live read of the provider's slash-command and skill enumeration via `listProviderCommands`,
  // held as driver-session state, so the flag adds no table or column.
  "provider_commands",
  // A faster-output mode the person can set and the provider declares a state for; `false` on a
  // provider that takes speed per turn and declares no state.
  "output_speed",
] as const;

/** The name of one driver capability flag. */
export type DriverCapabilityFlag = (typeof DRIVER_CAPABILITY_FLAGS)[number];

/**
 * A driver's capability flag matrix and contract semver, parsed on its reply by
 * `DriverCapabilitiesSchema`. `contractVersion` is bounded (semver, length) where it is persisted.
 */
export interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
}

/**
 * The sandbox and permissions a spawn or turn runs under, stamped on `run.running`. `mode` is the
 * session's permission level, which each driver resolves into its own provider's modes.
 * `credentialPolicyRef` names the credential deny list handed to the provider on every level; it
 * is a reference, so the list itself is never embedded.
 */
export type ExecutionPosture = {
  mode: PermissionLevel;
  writableRoots: string[];
  credentialPolicyRef: string;
};
