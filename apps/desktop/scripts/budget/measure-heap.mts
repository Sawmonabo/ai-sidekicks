#!/usr/bin/env node
// Renderer heap-at-rest budget — Plan-023 Phase 1C (T-023p-1C-1).
//
// Reads `process.memoryUsage().heapUsed` with a console-shaped workload
// retained — a reference entity store standing in for `console/store/` until
// T-023p-1C-2 lands the real one — and gates it against the
// `renderer-heap-at-rest` row of `test/console/budget/budgets.json`.
//
// This is a Node process, not an Electron renderer, so a pass is necessary and
// not sufficient; every reading prints what it does not prove. Without
// `--expose-gc` nothing forces a collection and the figure is an UPPER bound,
// so the CLI re-executes itself with the flag to get a settled one.
//
//   node --experimental-strip-types scripts/budget/measure-heap.mts [--json] [--entities=<n>]
// Exit: 0 within budget · 1 over budget · 2 bad usage.

import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import {
  type ConsoleBudget,
  type ConsoleBudgetRegistry,
  type ConsoleBudgetVerdict,
} from "./budget-registry.mts";
import { formatBudgetReport, formatBytes, runBudgetHarness } from "./budget-harness.mts";

export const HEAP_AT_REST_BUDGET_ID: string = "renderer-heap-at-rest";

/**
 * The closed console entity-kind set the store partitions by — NOT the pane-kind
 * set, which is a different closed set.
 * TODO(T-023p-1C-2): re-export from `console/store/` so there is one declaration.
 */
export const CONSOLE_ENTITY_KINDS = [
  "session",
  "participant",
  "channel",
  "run",
  "agent",
  "workspace",
  "worktree",
  "artifact",
  "approval",
  "workflow-run",
  "browser-page",
] as const;

export type ConsoleEntityKind = (typeof CONSOLE_ENTITY_KINDS)[number];

/** A deliberately generous session: the budget is a ceiling, so the workload sits high. */
export const HEAP_AT_REST_ENTITY_COUNT: number = 2000;

/** Stops the `--expose-gc` re-exec from recursing. */
const GC_REEXEC_SENTINEL = "SIDEKICKS_HEAP_BUDGET_REEXEC";

export interface ConsoleEntity {
  readonly kind: ConsoleEntityKind;
  readonly id: string;
  readonly state: string;
  readonly touchedAt: string;
  readonly attributedTo: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface HeapAtRestMeasurement {
  readonly measuredAt: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly entityCount: number;
  readonly partitionCount: number;
  /** `false` when the process has no `--expose-gc`; the reading is then an upper bound. */
  readonly garbageCollectionForced: boolean;
  readonly baselineHeapUsedBytes: number;
  /** The figure compared against the budget. */
  readonly atRestHeapUsedBytes: number;
  readonly workloadHeapDeltaBytes: number;
  /** Printed with every reading; never empty. */
  readonly limitations: readonly string[];
}

/**
 * Partitioned entity map standing in for `console/store/`'s `SessionStore`.
 * TODO(T-023p-1C-2): delete in favour of the real `SessionStore`.
 */
export class ReferencePartitionedEntityStore {
  #partitions: Record<string, Record<string, ConsoleEntity>>;

  constructor() {
    this.#partitions = Object.fromEntries(CONSOLE_ENTITY_KINDS.map((kind) => [kind, {}]));
  }

  /** Immutable, as the real store's reducer will be — the shape being measured. */
  apply(entity: ConsoleEntity): void {
    const partition = this.#partitions[entity.kind] ?? {};
    this.#partitions = {
      ...this.#partitions,
      [entity.kind]: { ...partition, [entity.id]: entity },
    };
  }

  get entityCount(): number {
    const partitions = Object.values(this.#partitions);
    return partitions.reduce((total, partition) => total + Object.keys(partition).length, 0);
  }

  get partitionCount(): number {
    return Object.keys(this.#partitions).length;
  }
}

/** Deterministic in `ordinal`, so two runs measure the identical object graph. */
export function buildReferenceConsoleEntity(ordinal: number): ConsoleEntity {
  const kind = CONSOLE_ENTITY_KINDS[ordinal % CONSOLE_ENTITY_KINDS.length] ?? "session";
  return {
    kind,
    id: `${kind}-${String(ordinal).padStart(6, "0")}`,
    state: ordinal % 3 === 0 ? "active" : ordinal % 3 === 1 ? "idle" : "terminal",
    touchedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, ordinal % 60)).toISOString(),
    attributedTo: `participant-${String(ordinal % 12).padStart(2, "0")}`,
    body: {
      label: `Reference console entity ${ordinal}`,
      sequence: ordinal,
      digest: `b3:${(ordinal * 2654435761).toString(16).padStart(16, "0")}`,
    },
  };
}

export class ConsoleHeapAtRestMeasurer {
  readonly #entityCount: number;

  constructor(entityCount: number = HEAP_AT_REST_ENTITY_COUNT) {
    this.#entityCount = entityCount;
  }

  async measure(): Promise<HeapAtRestMeasurement> {
    const collectGarbage = (globalThis as Record<string, unknown>)["gc"] as
      | (() => void)
      | undefined;
    const garbageCollectionForced = typeof collectGarbage === "function";
    const settle = async (): Promise<void> => {
      for (let pass = 0; pass < 4; pass += 1) {
        collectGarbage?.();
        await delay(10);
      }
    };

    await settle();
    const baselineHeapUsedBytes = process.memoryUsage().heapUsed;

    const store = new ReferencePartitionedEntityStore();
    for (let ordinal = 0; ordinal < this.#entityCount; ordinal += 1) {
      store.apply(buildReferenceConsoleEntity(ordinal));
    }

    await settle();
    const atRestHeapUsedBytes = process.memoryUsage().heapUsed;

    // Read the store AFTER the reading so the graph is provably live across it —
    // measuring a workload the engine was free to collect measures nothing.
    const entityCount = store.entityCount;
    const partitionCount = store.partitionCount;

    const limitations = [
      "Measured in a Node process, not an Electron renderer: no Chromium, no React reconciler, no DOM, no compositor. The renderer's own floor is higher than this process can observe; that figure is the endurance tier's at T-023p-1C-8.",
      `Measured against a reference partitioned entity store standing in for the console's \`SessionStore\` (${entityCount} entities across ${partitionCount} partitions). TODO(T-023p-1C-2): re-point at the real store.`,
      "`heapUsed` excludes external and ArrayBuffer memory, neither of which this budget counts.",
    ];
    if (!garbageCollectionForced) {
      limitations.push(
        "No `--expose-gc` in this process, so no collection was forced: the reading includes uncollected garbage and is an UPPER bound on retained heap. The gate can therefore fail early but never pass wrongly.",
      );
    }

    return {
      measuredAt: new Date().toISOString(),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      entityCount,
      partitionCount,
      garbageCollectionForced,
      baselineHeapUsedBytes,
      atRestHeapUsedBytes,
      workloadHeapDeltaBytes: atRestHeapUsedBytes - baselineHeapUsedBytes,
      limitations,
    };
  }
}

export function formatHeapAtRestReport(
  measurement: HeapAtRestMeasurement,
  budget: ConsoleBudget,
  verdict: ConsoleBudgetVerdict,
  registry: ConsoleBudgetRegistry,
): string {
  return formatBudgetReport(
    {
      title: "Renderer heap-at-rest budget — Plan-023 T-023p-1C-1",
      provenance: [
        `  measured at:   ${measurement.measuredAt}`,
        `  runtime:       Node ${measurement.nodeVersion} on ${measurement.platform}`,
        `  workload:      ${measurement.entityCount.toLocaleString("en-US")} entities across ${measurement.partitionCount} partitions`,
        `  forced GC:     ${measurement.garbageCollectionForced ? "yes (--expose-gc)" : "NO — reading is an upper bound"}`,
      ],
      readings: [
        `Readings — heap ${formatBytes(measurement.baselineHeapUsedBytes)} before the workload, ` +
          `${formatBytes(measurement.atRestHeapUsedBytes)} at rest ` +
          `(workload ${formatBytes(measurement.workloadHeapDeltaBytes)})`,
        "",
        "What this reading does not prove",
        ...measurement.limitations.map((limitation) => `  • ${limitation}`),
      ],
      measuredDescription: "heapUsed at rest",
    },
    budget,
    verdict,
    registry,
  );
}

const USAGE = `measure-heap.mts — renderer heap-at-rest budget (Plan-023 T-023p-1C-1)

  --json             emit the measurement and verdict as JSON on stdout
  --entities=<n>     workload size (default: ${HEAP_AT_REST_ENTITY_COUNT})
  -h, --help         this text

exit 0 within budget · 1 over budget · 2 bad usage`;

/** CLI entry point; returns the process exit code. */
export async function runHeapBudgetCommand(argumentList: readonly string[]): Promise<number> {
  let values: { json?: boolean; help?: boolean; entities?: string };
  try {
    ({ values } = parseArgs({
      args: [...argumentList],
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        entities: { type: "string", default: String(HEAP_AT_REST_ENTITY_COUNT) },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (usageError) {
    console.error(usageError instanceof Error ? usageError.message : String(usageError));
    console.error(USAGE);
    return 2;
  }

  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }

  const entityCount = Number.parseInt(values.entities ?? "", 10);
  if (!Number.isInteger(entityCount) || entityCount <= 0) {
    console.error(`--entities must be a positive integer, got \`${values.entities ?? ""}\`.`);
    console.error(USAGE);
    return 2;
  }

  return runBudgetHarness({
    budgetId: HEAP_AT_REST_BUDGET_ID,
    measure: () => new ConsoleHeapAtRestMeasurer(entityCount).measure(),
    compare: (measurement: HeapAtRestMeasurement) => measurement.atRestHeapUsedBytes,
    format: formatHeapAtRestReport,
    emitJson: values.json === true,
  });
}

/**
 * Re-runs this file under `--expose-gc` so the reading is settled, returning the
 * child's exit code — or `null` when no re-exec was needed or possible, in which
 * case we measure here and the report says the reading is an upper bound.
 *
 * `--experimental-strip-types` travels with it: this file is TypeScript, and on
 * a Node below 22.18 the flag is what makes it loadable at all.
 */
function reExecuteWithExposedGarbageCollector(argumentList: readonly string[]): number | null {
  const selfPath = process.argv[1];
  if (
    typeof (globalThis as Record<string, unknown>)["gc"] === "function" ||
    process.env[GC_REEXEC_SENTINEL] === "1" ||
    selfPath === undefined
  ) {
    return null;
  }
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--expose-gc", selfPath, ...argumentList],
    { stdio: "inherit", env: { ...process.env, [GC_REEXEC_SENTINEL]: "1" } },
  );
  return child.error !== undefined || child.status === null ? null : child.status;
}

// Compared through `realpathSync` on BOTH sides, never `import.meta.url ===
// pathToFileURL(argv[1])`: Node resolves the module URL through symlinks while
// argv[1] keeps the path as typed, so the naive form silently no-ops through a
// symlinked or spaced checkout and exits 0 over an unrun budget gate
// (`tools/__tests__/entry-guard.test.mjs` pins exactly this).
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  const commandArguments = process.argv.slice(2);
  const reExecStatus = reExecuteWithExposedGarbageCollector(commandArguments);
  process.exitCode =
    reExecStatus !== null ? reExecStatus : await runHeapBudgetCommand(commandArguments);
}
