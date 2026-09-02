// Store fan-out micro-benchmark — Plan-023 Phase 1C (T-023p-1C-1), the console
// bench tier's first arm.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CLAIM UNDER TEST
// ─────────────────────────────────────────────────────────────────────────────
//
// `Spec-023 §Console Libraries` (State, storage, forms, search, dates) adopts
// zustand under a named constraint — "one store per open session, partitioned
// entity maps, per-frame event coalescing, per-row selectors" — and justifies
// the partitioning with a figure: "A flat entity map costs 1.3 ms per event at
// 20,000 entities and a partitioned one 57 µs."
//
// That figure is the load-bearing half of the fourth product bar ("light on the
// machine"): the whole apply path's cost model rests on it, and the idle-CPU
// and frame-time budgets are priced against it. A number a spec asserts and no
// harness re-derives is a number nobody notices going stale, so this benchmark
// re-derives it on every run and writes the result to the bench ledger.
//
// WHAT IS GATED, AND WHAT IS NOT. The assertion below is on the RATIO, not on
// either absolute figure — an absolute millisecond count is a property of the
// machine, the engine, and the entity shape, and gating one would make this a
// hardware detector. The first recorded run makes the reason concrete: on an
// Apple-silicon laptop under Node 24, with the entity shape built below, the
// flat arm measured ~4.6 ms/event and the partitioned arm ~0.35 ms/event —
// roughly 3.5× and 6× the spec's two figures, at a 13× ratio against the spec's
// ~23×. So the spec's absolutes should be read as an order of magnitude taken
// on some other machine and shape, while the STRUCTURAL claim they were cited
// for — that partitioning is what keeps the apply path cheap — reproduces with
// a wide margin. The ledger keeps every run's absolutes, with the machine that
// produced them, so a later reader can compare like with like.
//
// The mechanism it measures is the immutable apply. Both stores hold the same
// entities and do the same work per event — replace one entity by id — but a
// flat `Record<string, ConsoleEntity>` must copy all 20,000 keys to produce the
// new identity a subscriber can compare, while a partitioned
// `Record<ConsoleEntityKind, Record<string, ConsoleEntity>>` copies only the
// touched kind's partition — `BENCHMARK_ENTITY_COUNT / CONSOLE_ENTITY_KINDS.length`
// keys — plus an outer record with one key per kind. The saving is structural,
// not incidental, and it scales with the partition count rather than with any
// figure written here: every count below is read off `CONSOLE_ENTITY_KINDS`, which
// `console/store/entities.ts` declares once and this file imports, so a kind added
// there moves the arithmetic without touching this comment.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PLAIN `test` AND AN OWN SAMPLER RATHER THAN VITEST'S `bench`
// ─────────────────────────────────────────────────────────────────────────────
//
// The pinned runner (vitest 4.1.5, `pnpm-workspace.yaml` `catalogs.testing`)
// does export `bench`, so the API is available. Two properties of it decided
// against using it here, both checked rather than assumed:
//
//   • `bench` runs only under `vitest bench`, a separate mode driven by a
//     `benchmark.include` config rather than `test.include`. Using it would put
//     this tier on a different invocation from every other console tier, which
//     `Spec-023 §Console Test Tiers` registers as ordinary Vitest projects.
//
//   • Its statistics come from tinybench 2.9.0, whose `TaskResult` publishes
//     `p75`, `p99`, `p995`, and `p999` and no `p95` — and reaches the calling
//     file only through a `teardown` hook or a custom reporter. The ledger row
//     this tier owes carries a p95, so the numbers would have to be re-derived
//     from `result.samples` anyway, through reporter plumbing.
//
// So the arm below samples with `performance.now()` and computes its own
// statistics from the raw series (`summarizeBenchmarkSamples`). It runs under
// the ordinary `vitest run --project=console-bench` with every other tier.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE TWO ARMS ARE, AND WHAT THEY ARE NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// Both stores below are LOCAL REFERENCE IMPLEMENTATIONS of one MAP SHAPE, and
// neither is the console's. They isolate the immutable apply so the two shapes
// are compared and nothing else is: `SessionStore.applyBatch` also validates,
// dedupes, detects gaps, and runs projectors, so driving it here would price
// that work into a figure the spec states about the map.
//
// The entity KIND SET is not local, and no longer could be. `CONSOLE_ENTITY_KINDS`
// is imported from `console/store/entities.ts`, which declares it once: a second
// copy here would have been a closed set restated, and it drifted the moment the
// store grew `workflow-definition` — under-counting the partitions this benchmark
// exists to measure.

import process from "node:process";
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import { CONSOLE_ENTITY_KINDS } from "../../../src/renderer/src/console/store/entities.js";
import type {
  ConsoleEntity,
  ConsoleEntityKind,
} from "../../../src/renderer/src/console/store/entities.js";
import {
  BenchmarkLedger,
  DEFAULT_BENCHMARK_LEDGER_PATH,
  formatBenchmarkLedgerRow,
  summarizeBenchmarkSamples,
  type BenchmarkLedgerRowInput,
  type BenchmarkSampleStatistics,
} from "./ledger.js";

/** The entity count `Spec-023 §Console Libraries` states its figure at. */
const BENCHMARK_ENTITY_COUNT = 20_000;

/** Applies timed inside one sample. Large enough to swamp timer resolution. */
const EVENTS_PER_SAMPLE = 50;

/** Samples discarded before recording, so JIT warm-up is not in the series. */
const WARM_UP_SAMPLE_COUNT = 5;

/** Recorded samples per arm. */
const RECORDED_SAMPLE_COUNT = 25;

/**
 * The floor the partitioned arm must clear against the flat one.
 *
 * The structural expectation is about `CONSOLE_ENTITY_KINDS.length`× — one
 * partition out of that many, plus the outer record — and the spec's own figures
 * are ~23×. Three is deliberately far below both: this assertion exists to catch
 * the apply path losing its partitioning, not to police a shared runner's
 * variance, and a floor written as a multiple of the kind count would move every
 * time the store grew a partition.
 */
const MINIMUM_PARTITIONING_SPEEDUP = 3;

/** Any store the benchmark can drive. */
interface ConsoleEntityStore {
  seed(entities: readonly ConsoleEntity[]): void;
  apply(entity: ConsoleEntity): void;
  readonly entityCount: number;
}

/**
 * The control: one flat `Record<string, ConsoleEntity>` with an immutable apply.
 *
 * Never a product artifact — it exists so the partitioned arm has something to
 * be measured against.
 */
export class FlatConsoleEntityStore implements ConsoleEntityStore {
  #entities: Readonly<Record<string, ConsoleEntity>> = {};

  seed(entities: readonly ConsoleEntity[]): void {
    const seeded: Record<string, ConsoleEntity> = {};
    for (const entity of entities) {
      seeded[entity.id] = entity;
    }
    this.#entities = seeded;
  }

  apply(entity: ConsoleEntity): void {
    this.#entities = { ...this.#entities, [entity.id]: entity };
  }

  get entityCount(): number {
    return Object.keys(this.#entities).length;
  }
}

/**
 * The shape `Spec-023 §Console Libraries` adopts: one partition per entity kind,
 * each with its own immutable apply, under an outer record of one key per kind.
 */
export class PartitionedConsoleEntityStore implements ConsoleEntityStore {
  #partitions: Readonly<Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>>;

  constructor() {
    this.#partitions = PartitionedConsoleEntityStore.#emptyPartitions();
  }

  static #emptyPartitions(): Record<ConsoleEntityKind, Record<string, ConsoleEntity>> {
    const partitions = {} as Record<ConsoleEntityKind, Record<string, ConsoleEntity>>;
    for (const kind of CONSOLE_ENTITY_KINDS) {
      partitions[kind] = {};
    }
    return partitions;
  }

  seed(entities: readonly ConsoleEntity[]): void {
    const partitions = PartitionedConsoleEntityStore.#emptyPartitions();
    for (const entity of entities) {
      partitions[entity.kind][entity.id] = entity;
    }
    this.#partitions = partitions;
  }

  apply(entity: ConsoleEntity): void {
    const partition = this.#partitions[entity.kind];
    this.#partitions = {
      ...this.#partitions,
      [entity.kind]: { ...partition, [entity.id]: entity },
    };
  }

  get entityCount(): number {
    let total = 0;
    for (const kind of CONSOLE_ENTITY_KINDS) {
      total += Object.keys(this.#partitions[kind]).length;
    }
    return total;
  }
}

/**
 * Deterministic 32-bit linear congruential generator (Numerical Recipes
 * parameters), so every run of this benchmark drives the identical event
 * sequence and two runs are comparable.
 */
class DeterministicSequence {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  nextBelow(exclusiveUpperBound: number): number {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return this.#state % exclusiveUpperBound;
  }
}

/** Builds the entity population, spread evenly across every console entity kind. */
export function buildConsoleEntities(entityCount: number): readonly ConsoleEntity[] {
  const entities: ConsoleEntity[] = [];
  for (let ordinal = 0; ordinal < entityCount; ordinal += 1) {
    const kind = CONSOLE_ENTITY_KINDS[ordinal % CONSOLE_ENTITY_KINDS.length] ?? "session";
    entities.push({
      kind,
      id: `${kind}-${String(ordinal).padStart(6, "0")}`,
      state: "active",
      touchedAt: "2026-09-01T00:00:00.000Z",
      attributedTo: `participant-${String(ordinal % 12).padStart(2, "0")}`,
      body: { sequence: ordinal },
    });
  }
  return entities;
}

/**
 * Builds the event stream: each event replaces one existing entity with an
 * updated copy, which is what a session-event apply does to a projection.
 */
export function buildApplyEventStream(
  entities: readonly ConsoleEntity[],
  eventCount: number,
): readonly ConsoleEntity[] {
  const sequence = new DeterministicSequence(0x5eed_1c17);
  const events: ConsoleEntity[] = [];
  for (let ordinal = 0; ordinal < eventCount; ordinal += 1) {
    const target = entities[sequence.nextBelow(entities.length)];
    if (target === undefined) {
      throw new Error("buildApplyEventStream: empty entity population");
    }
    events.push({
      ...target,
      state: ordinal % 2 === 0 ? "streaming" : "idle",
      touchedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, ordinal % 60)).toISOString(),
    });
  }
  return events;
}

/**
 * Times the per-event apply cost of one store, in milliseconds per event.
 *
 * Each sample seeds a fresh store outside the timer (seeding is a bulk build,
 * not the path under test) and then times exactly `EVENTS_PER_SAMPLE` immutable
 * applies against a steady-state population.
 */
export function measurePerEventApplyCost(
  createStore: () => ConsoleEntityStore,
  entities: readonly ConsoleEntity[],
  events: readonly ConsoleEntity[],
  sampleCount: number,
  warmUpSampleCount: number,
): { readonly samples: readonly number[]; readonly statistics: BenchmarkSampleStatistics } {
  const samples: number[] = [];
  const totalPasses = warmUpSampleCount + sampleCount;
  for (let pass = 0; pass < totalPasses; pass += 1) {
    const store = createStore();
    store.seed(entities);

    const startedAt = performance.now();
    for (const event of events) {
      store.apply(event);
    }
    const elapsedMilliseconds = performance.now() - startedAt;

    // Read the store after the timer so the applies are provably observed and
    // cannot be optimized away as dead stores.
    if (store.entityCount !== entities.length) {
      throw new Error(
        `measurePerEventApplyCost: store lost entities (${store.entityCount} of ${entities.length})`,
      );
    }
    if (pass >= warmUpSampleCount) {
      samples.push(elapsedMilliseconds / events.length);
    }
  }
  return { samples, statistics: summarizeBenchmarkSamples(samples) };
}

const ledgerFilePath: string =
  process.env["CONSOLE_BENCH_LEDGER_PATH"] ?? DEFAULT_BENCHMARK_LEDGER_PATH;

test(
  "store fan-out: a partitioned entity map applies an event more cheaply than a flat one at 20,000 entities",
  { timeout: 300_000 },
  () => {
    const entities = buildConsoleEntities(BENCHMARK_ENTITY_COUNT);
    const events = buildApplyEventStream(entities, EVENTS_PER_SAMPLE);

    const flat = measurePerEventApplyCost(
      () => new FlatConsoleEntityStore(),
      entities,
      events,
      RECORDED_SAMPLE_COUNT,
      WARM_UP_SAMPLE_COUNT,
    );
    const partitioned = measurePerEventApplyCost(
      () => new PartitionedConsoleEntityStore(),
      entities,
      events,
      RECORDED_SAMPLE_COUNT,
      WARM_UP_SAMPLE_COUNT,
    );

    const sharedContext = {
      entityCount: BENCHMARK_ENTITY_COUNT,
      partitionCount: CONSOLE_ENTITY_KINDS.length,
      eventsPerSample: EVENTS_PER_SAMPLE,
      warmUpSamplesDiscarded: WARM_UP_SAMPLE_COUNT,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
    } as const;

    const rowInputs: readonly BenchmarkLedgerRowInput[] = [
      {
        benchmarkId: "store-fan-out.flat",
        label: "Flat entity map — immutable apply at 20,000 entities (control)",
        unit: "ms/event",
        samples: flat.samples,
        context: { ...sharedContext, storeShape: "Record<string, ConsoleEntity>" },
      },
      {
        benchmarkId: "store-fan-out.partitioned",
        label: "Partitioned entity map — immutable apply at 20,000 entities",
        unit: "ms/event",
        samples: partitioned.samples,
        context: {
          ...sharedContext,
          storeShape: "Record<ConsoleEntityKind, Record<string, ConsoleEntity>>",
        },
      },
    ];

    const appendedRows = new BenchmarkLedger(ledgerFilePath).appendAll(rowInputs);
    const speedup = flat.statistics.median / partitioned.statistics.median;

    console.log(
      [
        `store fan-out @ ${BENCHMARK_ENTITY_COUNT.toLocaleString("en-US")} entities, ${CONSOLE_ENTITY_KINDS.length} partitions`,
        ...appendedRows.map((row) => `  ${formatBenchmarkLedgerRow(row)}`),
        `  partitioning speedup (median): ${speedup.toFixed(1)}×`,
        `  ledger: ${ledgerFilePath}`,
      ].join("\n"),
    );

    expect(flat.statistics.sampleCount).toBe(RECORDED_SAMPLE_COUNT);
    expect(partitioned.statistics.sampleCount).toBe(RECORDED_SAMPLE_COUNT);
    expect(
      speedup,
      `Partitioning bought ${speedup.toFixed(1)}× against a floor of ${MINIMUM_PARTITIONING_SPEEDUP}×. ` +
        "Either the apply path under test lost its partitioning, or the claim in " +
        "`Spec-023 §Console Libraries` (State row) no longer holds and the spec's cost model needs re-deriving.",
    ).toBeGreaterThanOrEqual(MINIMUM_PARTITIONING_SPEEDUP);
  },
);
