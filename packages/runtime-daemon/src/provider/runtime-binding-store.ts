// Durable store of run-to-driver bindings over the `runtime_bindings` table in
// `session/daemon-schema.ts`; binding state never touches a remote provider.
//
// - `contract_version`, `resume_handle` and the `cli_version_raw` / `cli_version_semver` pair are
//   provider-declared: the SQL CHECKs bound length and NULs, `output-validation.ts` adds
//   the semantic layer. The pair is spawn-scoped, so it is validated at INSERT only.
// - `spawn_config` is required at create; recovery re-reads it to rebuild `ResumeSessionParams`
//   without the original client request. `cliVersion` is one optional member, so the DDL's rule
//   that a parse never stands without its printed version holds at the type level.
// - `runId`, `id` and the content of `runtime_metadata` are daemon-controlled: no CHECK and no Zod
//   guard. `driverName` is typed at the write and parsed as a provider name on every read.
// - Reads run on the read-only connection; every write goes through the database writer.

import { ProviderNameSchema, type ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { Statement } from "better-sqlite3";

import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { DatabaseWriter } from "../database/writer.js";
import { composeLeftConversationInsert, type LeftConversation } from "./left-conversations.js";
import { assertValidContractVersion, assertValidResumeHandle } from "./output-validation.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { isPlainObject } from "./record-readers.js";
import {
  type CallbackToolInvocation,
  type CallbackToolResult,
  type DriverCliVersionReport,
  type McpServerStatusProducer,
  type ResumeSessionParams,
  type SessionToolServer,
  type SubagentPolicy,
  readCliVersionColumns,
} from "./driver/contract.js";

/**
 * The daemon-owned record of the spawn-bound configuration, persisted at every binding write.
 * Resume is a fresh spawn and recovery has no client request, so each data leg is re-realized
 * from here (a posture-less resume relaunches unsandboxed); function legs are re-injected fresh.
 */
export interface RuntimeBindingSpawnConfig {
  // Members take `?: T | undefined` so a producer can copy legs across without conditional spreads.
  readonly executionPosture?: ExecutionPosture | undefined;
  readonly callbackTools?: SessionCallbackTool[] | undefined;
  readonly subagentPolicy?: SubagentPolicy | undefined;
  // Every tool server the session can reach, each with the person's switch, so a resume starts
  // with exactly the servers that were switched on.
  readonly toolServers?: readonly SessionToolServer[] | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  // Bound for the run's lifetime, so a resume never re-resolves to the current default account;
  // server-resolved, never client-supplied.
  readonly providerAccountId?: string | undefined;
  // The build that ran, as provenance only: every start resolves the provider's command again,
  // because an update deletes older builds.
  readonly resolvedExecutablePath?: string | undefined;
  // The requested level, never the observed `ProviderOutputSpeedState`, which would make a mode
  // that stopped being available read as accepted after a restart.
  readonly outputSpeed?: string | undefined;
}

/** A runtime binding as daemon callers see it: camelCase, JSON columns parsed. */
export interface RuntimeBinding {
  readonly id: string;
  readonly runId: string;
  readonly driverName: ProviderName;
  readonly contractVersion: string;
  // `null` when no version was recorded; `parsedVersion` is absent when the printed version did not
  // parse.
  readonly cliVersion: DriverCliVersionReport | null;
  readonly resumeHandle: string | null;
  readonly spawnConfig: RuntimeBindingSpawnConfig;
  readonly runtimeMetadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `create` input. The store mints `id`, because a run has many bindings. `cliVersion` carries the
 * printed version and its parse together, so a parse without a version cannot be expressed;
 * `spawnConfig` is required.
 */
export interface CreateRuntimeBindingInput {
  readonly runId: string;
  readonly driverName: ProviderName;
  readonly contractVersion: string;
  readonly cliVersion?: DriverCliVersionReport;
  readonly resumeHandle?: string | null;
  readonly spawnConfig: RuntimeBindingSpawnConfig;
  readonly runtimeMetadata?: Record<string, unknown>;
}

/**
 * The `create` members filled from one spawned-build reading of `resolvedExecutablePath`, never a
 * launcher symlink or `--version`, so a row never pairs one install's version with another's path.
 * `spawned-version.ts` produces this through `toBindingVersionCarriers`.
 */
export interface SpawnedVersionBindingCarriers {
  readonly cliVersion: DriverCliVersionReport;
  /** Absolute and symlink-dereferenced — the build that answered the handshake. */
  readonly resolvedExecutablePath: string;
}

/**
 * Composes a `create` input whose version pair and executable path come from one reading; the
 * carriers win. Throws a plain `Error` when `spawnConfig` already names a different path.
 */
export function withSpawnedVersionCarriers(
  input: Omit<CreateRuntimeBindingInput, "cliVersion">,
  carriers: SpawnedVersionBindingCarriers,
): CreateRuntimeBindingInput {
  const declaredExecutablePath = input.spawnConfig.resolvedExecutablePath;
  if (
    declaredExecutablePath !== undefined &&
    declaredExecutablePath !== carriers.resolvedExecutablePath
  ) {
    throw new Error(
      `RuntimeBindingStore: spawn_config.resolvedExecutablePath disagrees with the ` +
        `spawned-version reading for run ${input.runId} (driver ${input.driverName}) — the ` +
        `recorded version and the recorded executable must come from one reading`,
    );
  }
  return {
    ...input,
    cliVersion: carriers.cliVersion,
    spawnConfig: { ...input.spawnConfig, resolvedExecutablePath: carriers.resolvedExecutablePath },
  };
}

/** A binding pointed at the conversation its session moved onto, and the ones the session left. */
export interface RuntimeBindingRebind {
  readonly bindingId: string;
  readonly resumeHandle: string;
  readonly leftConversations: readonly LeftConversation[];
}

/**
 * A resume a driver started on its own, after its process ended or on a new provider build, and the
 * binding it minted for the session's leg.
 */
interface RuntimeBindingRelaunch {
  /** The binding the session ran on before, whose run, driver and spawn record carry over. */
  readonly predecessorId: string;
  /** The id the driver minted for the relaunched leg. */
  readonly bindingId: string;
  /** The conversation the leg runs on now. */
  readonly resumeHandle: string;
  readonly leftConversations: readonly LeftConversation[];
}

/**
 * `update` patch: the mutable columns only. `spawnConfig` and `cliVersion` are absent because a
 * relaunch mints a new row; patching them would rewrite the provenance recovery rebuilds from.
 */
export interface UpdateRuntimeBindingPatch {
  readonly contractVersion?: string;
  readonly resumeHandle?: string | null;
  readonly runtimeMetadata?: Record<string, unknown>;
}

interface RuntimeBindingRow {
  readonly id: string;
  readonly run_id: string;
  readonly driver_name: string;
  readonly contract_version: string;
  readonly cli_version_raw: string | null;
  readonly cli_version_semver: string | null;
  readonly resume_handle: string | null;
  readonly spawn_config: string;
  readonly runtime_metadata: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The stored columns a read parses rather than casts. */
interface ParsedRuntimeBindingColumns {
  readonly driverName: ProviderName;
  readonly spawnConfig: RuntimeBindingSpawnConfig;
}

/**
 * The closed key set of `spawn_config`, each with a one-level check on its stored value (an
 * `executionPosture` of `{}` passes, so recovery must validate inner shapes). `satisfies` makes a
 * member without a check a compile error.
 */
const SPAWN_CONFIG_MEMBER_CHECKS = {
  executionPosture: isPlainObject,
  callbackTools: (value) => Array.isArray(value),
  subagentPolicy: isPlainObject,
  toolServers: (value) => Array.isArray(value),
  outputSchema: isPlainObject,
  providerAccountId: (value) => typeof value === "string",
  resolvedExecutablePath: (value) => typeof value === "string",
  outputSpeed: (value) => typeof value === "string",
} satisfies Readonly<Record<keyof RuntimeBindingSpawnConfig, (value: unknown) => boolean>>;

/**
 * The function legs a resume re-injects fresh, a separate parameter so forgetting to rebind the
 * dispatcher is a decision at the call site.
 */
export interface ResumeFunctionLegInjection {
  readonly onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  readonly onMcpServerStatus?: McpServerStatusProducer | undefined;
}

/**
 * Which `spawn_config` members are resume legs (handed to the driver on `ResumeSessionParams`) and
 * which are `"provenance"`, a record of what ran that no start reads. Unannotated on purpose:
 * `satisfies` keeps the per-key literals `ResumeLegSpawnConfigKey` reads, and an annotation would
 * widen them.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `ResumeLegSpawnConfigKey` reads it
const SPAWN_CONFIG_RESUME_DISPOSITION = {
  executionPosture: "resume-leg",
  callbackTools: "resume-leg",
  subagentPolicy: "resume-leg",
  toolServers: "resume-leg",
  outputSchema: "resume-leg",
  // Handed to the driver, so a resume stays on the account it was admitted against.
  providerAccountId: "resume-leg",
  // What ran; a resume resolves the command where it points now.
  resolvedExecutablePath: "provenance",
  // A parameter the driver itself takes and hands to the provider, unlike the executable path.
  outputSpeed: "resume-leg",
} satisfies Readonly<Record<keyof RuntimeBindingSpawnConfig, "resume-leg" | "provenance">>;

type ResumeDisposition = typeof SPAWN_CONFIG_RESUME_DISPOSITION;

/** The `spawn_config` members a resumed leg re-realizes through its params. */
type ResumeLegSpawnConfigKey = {
  [Key in keyof ResumeDisposition]: ResumeDisposition[Key] extends "resume-leg" ? Key : never;
}[keyof ResumeDisposition];

/** Raised when a binding cannot describe a resumable leg; recovery should relaunch, not retry. */
export class RuntimeBindingNotResumableError extends Error {
  readonly bindingId: string;
  readonly runId: string;

  constructor(message: string, bindingId: string, runId: string) {
    super(message);
    this.name = "RuntimeBindingNotResumableError";
    this.bindingId = bindingId;
    this.runId = runId;
  }
}

/**
 * Rebuilds a resumed leg's spawn-bound surface from its durable binding and the session's current
 * model, its recorded larger window and its mode. Throws `RuntimeBindingNotResumableError` when
 * `resumeHandle` is null or empty, as it names no session.
 */
export function composeResumeSessionParams(
  sessionId: SessionId,
  binding: RuntimeBinding,
  model: string,
  largerWindow: number | undefined,
  mode: SessionMode,
  functionLegs: ResumeFunctionLegInjection,
): ResumeSessionParams {
  const resumeHandle = binding.resumeHandle;
  if (resumeHandle === null || resumeHandle.length === 0) {
    throw new RuntimeBindingNotResumableError(
      `RuntimeBindingStore: binding ${binding.id} (run ${binding.runId}, driver ` +
        `${binding.driverName}) carries no resume handle — the leg must be relaunched fresh, ` +
        `not resumed`,
      binding.id,
      binding.runId,
    );
  }
  const spawnConfig = binding.spawnConfig;
  // Enumerated, not spread, so the `provenance` member stays off the params.
  const resumeLegs = {
    executionPosture: spawnConfig.executionPosture,
    callbackTools: spawnConfig.callbackTools,
    subagentPolicy: spawnConfig.subagentPolicy,
    toolServers: spawnConfig.toolServers,
    outputSchema: spawnConfig.outputSchema,
    // Read back verbatim, never re-resolved.
    providerAccountId: spawnConfig.providerAccountId,
    outputSpeed: spawnConfig.outputSpeed,
  } satisfies { [Key in ResumeLegSpawnConfigKey]: RuntimeBindingSpawnConfig[Key] };
  return {
    sessionId,
    resumeHandle,
    model,
    largerWindow,
    mode,
    ...resumeLegs,
    onCallbackToolCall: functionLegs.onCallbackToolCall,
    onMcpServerStatus: functionLegs.onMcpServerStatus,
  };
}

const INSERT_BINDING_SQL = `
  INSERT INTO runtime_bindings
    (id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
     resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
  VALUES
    (@id, @run_id, @driver_name, @contract_version, @cli_version_raw, @cli_version_semver,
     @resume_handle, @spawn_config, @runtime_metadata, @created_at, @updated_at)`;

// `created_at` and the spawn-scoped columns are never in the SET list, so they are preserved.
const UPDATE_BINDING_SQL = `
  UPDATE runtime_bindings
     SET contract_version = CASE WHEN @sets_contract_version THEN @contract_version
                                 ELSE contract_version END,
         resume_handle    = CASE WHEN @sets_resume_handle THEN @resume_handle
                                 ELSE resume_handle END,
         runtime_metadata = CASE WHEN @sets_runtime_metadata THEN @runtime_metadata
                                 ELSE runtime_metadata END,
         updated_at       = @updated_at
   WHERE id = @id AND driver_name = @driver_name AND spawn_config = @spawn_config
  RETURNING id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
            resume_handle, spawn_config, runtime_metadata, created_at, updated_at`;

// The relaunch resolved the provider's command again, so the build the predecessor recorded may not
// be the one that runs now: the version pair and the executable path are left unrecorded.
const INSERT_RELAUNCHED_BINDING_SQL = `
  INSERT INTO runtime_bindings
    (id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
     resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
  SELECT @id, run_id, driver_name, contract_version, NULL, NULL, @resume_handle,
         json_remove(spawn_config, '$.resolvedExecutablePath'), '{}', @timestamp, @timestamp
    FROM runtime_bindings
   WHERE id = @predecessor_id`;

const DELETE_BINDING_SQL = `DELETE FROM runtime_bindings WHERE id = ?`;

/** Reads `runtime_bindings` synchronously and writes it through the database writer. */
export class RuntimeBindingStore {
  readonly #selectByIdStmt: Statement;
  readonly #selectByRunStmt: Statement;
  readonly #selectByRunsStmt: Statement;
  readonly #selectResumableStmt: Statement;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #now: () => string;
  readonly #newId: () => string;

  constructor(
    database: DatabaseConnections,
    deps: { now?: () => string; newId?: () => string } = {},
  ) {
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    // UUIDv7 ids sort by mint order when a table is read back.
    this.#newId = deps.newId ?? mintUuidV7;
    this.#writer = database.writer;
    const db = database.reader;

    this.#selectByIdStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
              resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE id = ?`,
    );
    // Uses `idx_runtime_bindings_run`; the order is stable for a run's many bindings.
    this.#selectByRunStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
              resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE run_id = ?
        ORDER BY created_at, id`,
    );
    // One statement for any arity: run ids arrive as one JSON-array parameter, since an
    // `IN (?,?,...)` list would need SQL per arity and could reach SQLITE_MAX_VARIABLE_NUMBER.
    this.#selectByRunsStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
              resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE run_id IN (SELECT value FROM json_each(?))
        ORDER BY run_id, created_at, id`,
    );
    this.#selectResumableStmt = db.prepare(
      `SELECT id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver,
              resume_handle, spawn_config, runtime_metadata, created_at, updated_at
         FROM runtime_bindings
        WHERE resume_handle IS NOT NULL
        ORDER BY created_at, id`,
    );
  }

  /**
   * Creates a binding, validating the provider-declared fields before the INSERT. Mints `id` and
   * resolves, once committed, with the binding built from the values just written.
   */
  async create(input: CreateRuntimeBindingInput): Promise<RuntimeBinding> {
    assertValidContractVersion(input.contractVersion);
    if (input.resumeHandle != null) {
      assertValidResumeHandle(input.resumeHandle);
    }
    // Validated where the daemon read it off the spawned build, so it is trusted here.
    const cliVersion: DriverCliVersionReport | null = input.cliVersion ?? null;

    const id: string = this.#newId();
    const timestamp: string = this.#now();
    const resumeHandle: string | null = input.resumeHandle ?? null;
    // Only an untyped caller reaches this; writing `'{}'` would leave a posture-less record.
    if (input.spawnConfig === undefined) {
      throw new Error(
        `RuntimeBindingStore.create: spawnConfig is required at every binding write for run ` +
          `${input.runId} (driver ${input.driverName}) — the '{}' column default is never a ` +
          `write's outcome`,
      );
    }
    const spawnConfigJson: string = JSON.stringify(input.spawnConfig);
    // Parse with the read path's parser so a record this store cannot read back never lands. A
    // failure is a plain `Error`: the record is daemon-assembled.
    const persistedSpawnConfig: RuntimeBindingSpawnConfig = this.#parseSpawnConfig(
      id,
      spawnConfigJson,
    );
    const runtimeMetadata: Record<string, unknown> = input.runtimeMetadata ?? {};
    const runtimeMetadataJson: string = JSON.stringify(runtimeMetadata);

    await this.#writer.write([
      {
        sql: INSERT_BINDING_SQL,
        bindings: {
          id,
          run_id: input.runId,
          driver_name: input.driverName,
          contract_version: input.contractVersion,
          cli_version_raw: cliVersion === null ? null : cliVersion.rawVersion,
          cli_version_semver: cliVersion?.parsedVersion ?? null,
          resume_handle: resumeHandle,
          spawn_config: spawnConfigJson,
          runtime_metadata: runtimeMetadataJson,
          created_at: timestamp,
          updated_at: timestamp,
        },
      },
    ]);

    return {
      id,
      runId: input.runId,
      driverName: input.driverName,
      contractVersion: input.contractVersion,
      cliVersion,
      resumeHandle,
      // The parser's output, never the caller's object.
      spawnConfig: persistedSpawnConfig,
      // The JSON round-trip, so `create()` agrees with `findById()` for values JSON normalizes
      // (an `undefined` member drops, a `Date` becomes its ISO string).
      runtimeMetadata: JSON.parse(runtimeMetadataJson) as Record<string, unknown>,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** Returns the binding with primary key `id`, or `undefined`. */
  findById(id: string): RuntimeBinding | undefined {
    const row = this.#selectByIdStmt.get(id) as RuntimeBindingRow | undefined;
    return row === undefined ? undefined : this.#rowToDomain(row);
  }

  /** Lists a run's bindings (`created_at`, `id` order); empty when none. */
  findByRun(runId: string): RuntimeBinding[] {
    const rows = this.#selectByRunStmt.all(runId) as RuntimeBindingRow[];
    return rows.map((row) => this.#rowToDomain(row));
  }

  /**
   * Lists many runs' bindings in one flat query ordered `run_id, created_at, id`, superseded ones
   * included; the caller groups by run. Synchronous, since it feeds the ack barrier and a promise
   * would move it across a microtask boundary. Throws if any row is unreadable.
   */
  findByRuns(runIds: readonly string[]): RuntimeBinding[] {
    if (runIds.length === 0) {
      return [];
    }
    const rows = this.#selectByRunsStmt.all(JSON.stringify(runIds)) as RuntimeBindingRow[];
    return rows.map((row) => this.#rowToDomain(row));
  }

  /**
   * Patches a binding's mutable columns and bumps `updated_at`, recording in the same write each
   * conversation the patch moved its session off; resolves with the updated binding, or
   * `undefined` when `id` is absent and nothing is written. An invalid patch throws even for an
   * absent id, and an unreadable stored row throws before anything is written.
   */
  async update(
    id: string,
    patch: UpdateRuntimeBindingPatch,
    leftConversations: readonly LeftConversation[] = [],
  ): Promise<RuntimeBinding | undefined> {
    if (patch.contractVersion !== undefined) {
      assertValidContractVersion(patch.contractVersion);
    }
    if (patch.resumeHandle != null) {
      assertValidResumeHandle(patch.resumeHandle);
    }

    const existing = this.#selectByIdStmt.get(id) as RuntimeBindingRow | undefined;
    if (existing === undefined) {
      return undefined;
    }
    // Parse first: a patch committed onto an unreadable record would hide the corruption behind a
    // fresh `updated_at`.
    const parsedColumns: ParsedRuntimeBindingColumns = this.#parseStoredColumns(existing);

    // The merge runs in SQL, so a concurrent patch to another column is never overwritten with the
    // value read above. An absent key keeps the stored value and `resumeHandle: null` clears it,
    // which COALESCE cannot express. The parsed columns are part of the match, so the patch lands
    // only on the record just parsed.
    const updatedAt = this.#now();
    const [result] = await this.#writer.write([
      {
        sql: UPDATE_BINDING_SQL,
        bindings: {
          id,
          driver_name: existing.driver_name,
          spawn_config: existing.spawn_config,
          sets_contract_version: patch.contractVersion === undefined ? 0 : 1,
          contract_version: patch.contractVersion ?? null,
          sets_resume_handle: patch.resumeHandle === undefined ? 0 : 1,
          resume_handle: patch.resumeHandle ?? null,
          sets_runtime_metadata: patch.runtimeMetadata === undefined ? 0 : 1,
          runtime_metadata:
            patch.runtimeMetadata === undefined ? null : JSON.stringify(patch.runtimeMetadata),
          updated_at: updatedAt,
        },
      },
      ...leftConversations.map((conversation) =>
        composeLeftConversationInsert(id, updatedAt, conversation),
      ),
    ]);
    const updated = result?.rows[0] as RuntimeBindingRow | undefined;
    if (updated === undefined) {
      // The row was deleted after the read, or its driver or spawn columns, which the daemon never
      // changes, were edited outside it. Reading again answers `undefined` for the first and parses
      // the record as now stored for the second, refusing it if it no longer reads.
      return this.update(id, patch, leftConversations);
    }
    // Reuses the columns the patch was gated on, so the result cannot disagree with them.
    return this.#rowToDomain(updated, parsedColumns);
  }

  /**
   * Points a binding at the conversation its session moved onto, so a later resume opens that one,
   * recording in the same write each conversation the session left. Rejects when the binding has
   * no row, so nothing was recorded.
   */
  async rebind(rebind: RuntimeBindingRebind): Promise<void> {
    const rebound = await this.update(
      rebind.bindingId,
      { resumeHandle: rebind.resumeHandle },
      rebind.leftConversations,
    );
    if (rebound === undefined) {
      throw new Error(`The runtime binding ${rebind.bindingId} has no row to point elsewhere`);
    }
  }

  /**
   * Records the binding a driver minted when it resumed a session on its own: a new row on the
   * predecessor's run, driver and spawn record, naming the conversation the leg runs on now, with
   * each conversation the leg left in the same write. Rejects when the predecessor has no row, so
   * nothing was recorded.
   */
  async recordRelaunch(relaunch: RuntimeBindingRelaunch): Promise<void> {
    assertValidResumeHandle(relaunch.resumeHandle);
    const timestamp = this.#now();
    await this.#writer.write([
      {
        sql: INSERT_RELAUNCHED_BINDING_SQL,
        bindings: {
          id: relaunch.bindingId,
          resume_handle: relaunch.resumeHandle,
          timestamp,
          predecessor_id: relaunch.predecessorId,
        },
        expectedRowCount: 1,
      },
      ...relaunch.leftConversations.map((conversation) =>
        composeLeftConversationInsert(relaunch.bindingId, timestamp, conversation),
      ),
    ]);
  }

  /** Deletes a binding by primary key; resolves with whether a row was removed. */
  async delete(id: string): Promise<boolean> {
    const [result] = await this.#writer.write([{ sql: DELETE_BINDING_SQL, bindings: [id] }]);
    return (result?.rowCount ?? 0) > 0;
  }

  /**
   * Lists every binding with a non-null `resume_handle`, for recovery. Throws for the whole list
   * if a row is unreadable: dropping the row would read as nothing to recover.
   */
  findResumableBindings(): RuntimeBinding[] {
    const rows = this.#selectResumableStmt.all() as RuntimeBindingRow[];
    return rows.map((row) => this.#rowToDomain(row));
  }

  /**
   * Maps a raw row to the public type; the CLI version folds from its printed column. `update()`
   * passes the columns it parsed before its write.
   */
  #rowToDomain(
    row: RuntimeBindingRow,
    parsedColumns: ParsedRuntimeBindingColumns = this.#parseStoredColumns(row),
  ): RuntimeBinding {
    return {
      id: row.id,
      runId: row.run_id,
      driverName: parsedColumns.driverName,
      contractVersion: row.contract_version,
      cliVersion:
        row.cli_version_raw === null
          ? null
          : readCliVersionColumns(row.cli_version_raw, row.cli_version_semver),
      resumeHandle: row.resume_handle,
      spawnConfig: parsedColumns.spawnConfig,
      runtimeMetadata: JSON.parse(row.runtime_metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Parses the row's `driver_name` and `spawn_config`. A `driver_name` naming no provider throws a
   * plain `Error` naming the binding, as an unreadable `spawn_config` does, rather than passing a
   * corrupt name on as a `ProviderName`.
   */
  #parseStoredColumns(row: RuntimeBindingRow): ParsedRuntimeBindingColumns {
    const driverName = ProviderNameSchema.safeParse(row.driver_name);
    if (!driverName.success) {
      throw new Error(`runtime_bindings.driver_name names no provider (binding id ${row.id}).`);
    }
    return {
      driverName: driverName.data,
      spawnConfig: this.#parseSpawnConfig(row.id, row.spawn_config),
    };
  }

  /**
   * Parses a stored `spawn_config` against `SPAWN_CONFIG_MEMBER_CHECKS`. Throws a plain `Error`
   * naming the binding, not a `ProviderOutputValidationError`: the daemon's own state is bad, not
   * the provider's. Member names are safe in the message because the key vocabulary is
   * daemon-owned.
   */
  #parseSpawnConfig(bindingId: string, rawSpawnConfig: string): RuntimeBindingSpawnConfig {
    // Fails loudly because an all-absent record would relaunch posture-less, i.e. unsandboxed, and
    // one unreadable row refuses the whole list (skipping it would under-count the fail-open ack
    // barrier and the recovery dispatcher). Both write seams parse first, so only corruption lands
    // here.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSpawnConfig);
    } catch {
      throw new Error(
        `runtime_bindings.spawn_config is not parseable JSON (binding id ${bindingId}).`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(
        `runtime_bindings.spawn_config is not a JSON object (binding id ${bindingId}).`,
      );
    }
    const record = parsed;
    for (const key of Object.keys(record)) {
      // Own keys only (see `assertValidCapabilityFlags`), so the table lookup below is total.
      if (!Object.prototype.hasOwnProperty.call(SPAWN_CONFIG_MEMBER_CHECKS, key)) {
        throw new Error(
          `runtime_bindings.spawn_config carries unknown member "${key}" (binding id ` +
            `${bindingId}).`,
        );
      }
      const check = SPAWN_CONFIG_MEMBER_CHECKS[key as keyof typeof SPAWN_CONFIG_MEMBER_CHECKS];
      if (!check(record[key])) {
        throw new Error(
          `runtime_bindings.spawn_config member "${key}" has the wrong shape (binding id ` +
            `${bindingId}).`,
        );
      }
    }
    // An empty record is indistinguishable from the column's `'{}'` default, which is inert because
    // spawn writers always record `resolvedExecutablePath`.
    return record as RuntimeBindingSpawnConfig;
  }
}
