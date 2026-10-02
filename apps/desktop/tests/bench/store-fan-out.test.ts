// Store fan-out micro-benchmark: the bench tier's first arm.
//
// The store design claims a flat entity map costs about 1.3 ms per event at 20,000 entities and
// a partitioned one about 57 µs. This benchmark re-derives the comparison on every run and writes
// it to the bench ledger, so the claim cannot go stale unnoticed.
//
// The assertion gates the ratio, not either absolute figure, because an absolute time depends on
// the machine, the engine and the entity shape. The ledger keeps every run's absolutes with the
// machine that produced them.
//
// What it measures is the immutable apply. Both stores hold the same entities and replace one
// by id per event, but a flat `Record<string, StoredEntity>` copies all 20,000 keys to produce a
// new identity, while a partitioned `Record<EntityKind, Record<string, StoredEntity>>` copies
// only the touched kind's partition plus an outer record. Every count below is read off
// `ENTITY_KINDS` (`lib/entity-kinds.ts`), so a new kind moves the arithmetic.
//
// A plain `test` with its own sampler is used rather than Vitest's `bench`: `bench` runs only under
// `vitest bench`, a separate mode from every other tier's project, and its statistics publish no
// p95, which the ledger row needs.
//
// The partitioned arm drives the app's own `mergeUpsert`
// (`store/session/entities/entity-partitions.ts`) over `emptyPartitions()`, the merge every
// projected upsert goes through, so an apply path refactored onto a flat map turns this
// benchmark red. It is the merge and not `SessionStore.applyBatch`, whose validation, dedupe,
// gap detection and projectors are not what the figure is about. The flat arm is a model: the
// app ships no flat map, and the shape exists only as the alternative this benchmark prices.
// `ENTITY_KINDS` is imported rather than copied, because a second copy would under-count the
// partitions.

import process from "node:process";
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import { ENTITY_KINDS } from "@renderer/lib/entity-kinds.js";
import { emptyPartitions } from "@renderer/store/session/entities/entities.js";
import type { StoredEntity } from "@renderer/store/session/entities/entities.js";
import {
  mergeUpsert,
  type SessionPartitions,
} from "@renderer/store/session/entities/entity-partitions.js";
import {
  BenchmarkLedger,
  DEFAULT_BENCHMARK_LEDGER_PATH,
  formatBenchmarkLedgerRow,
  summarizeBenchmarkSamples,
  type BenchmarkLedgerRowInput,
  type BenchmarkSampleStatistics,
} from "./ledger.js";

/** The entity count the adoption figure is stated at. */
const BENCHMARK_ENTITY_COUNT = 20_000;

/** Applies timed inside one sample. Large enough to swamp timer resolution. */
const EVENTS_PER_SAMPLE = 50;

/** Samples discarded before recording, so JIT warm-up is not in the series. */
const WARM_UP_SAMPLE_COUNT = 5;

/** Recorded samples per arm. */
const RECORDED_SAMPLE_COUNT = 25;

/**
 * The floor the partitioned arm must clear against the flat one. The structural expectation is
 * about `ENTITY_KINDS.length`× and the claimed figure ~23×; three is far below both because the
 * assertion catches the apply path losing its partitioning, not a shared runner's variance.
 */
const MINIMUM_PARTITIONING_SPEEDUP = 3;

/** Any store the benchmark can drive. */
interface BenchEntityStore {
  seed(entities: readonly StoredEntity[]): void;
  apply(entity: StoredEntity): void;
  readonly entityCount: number;
}

/** The control: one flat `Record<string, StoredEntity>` with an immutable apply. */
class FlatEntityStore implements BenchEntityStore {
  #entities: Readonly<Record<string, StoredEntity>> = {};

  seed(entities: readonly StoredEntity[]): void {
    const seeded: Record<string, StoredEntity> = {};
    for (const entity of entities) {
      seeded[entity.id] = entity;
    }
    this.#entities = seeded;
  }

  apply(entity: StoredEntity): void {
    this.#entities = { ...this.#entities, [entity.id]: entity };
  }

  get entityCount(): number {
    return Object.keys(this.#entities).length;
  }
}

/**
 * The app's own partitioned apply, held between calls. It imports `emptyPartitions` and
 * `mergeUpsert` and adds only the value carried from one apply to the next, so the arm gates
 * the shipped path. The seed goes through the same merge, outside the timer, so the timed
 * applies run against a population the shipped path produced.
 */
class PartitionedEntityStore implements BenchEntityStore {
  #partitions: SessionPartitions = emptyPartitions();

  seed(entities: readonly StoredEntity[]): void {
    let seeded: SessionPartitions = emptyPartitions();
    for (const entity of entities) {
      seeded = mergeUpsert(seeded, entity);
    }
    this.#partitions = seeded;
  }

  apply(entity: StoredEntity): void {
    this.#partitions = mergeUpsert(this.#partitions, entity);
  }

  get entityCount(): number {
    let total = 0;
    for (const kind of ENTITY_KINDS) {
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

/** Builds the entity population, spread evenly across every app entity kind. */
function buildStoredEntities(entityCount: number): readonly StoredEntity[] {
  const entities: StoredEntity[] = [];
  while (entities.length < entityCount) {
    for (const kind of ENTITY_KINDS) {
      const ordinal = entities.length;
      if (ordinal === entityCount) {
        break;
      }
      entities.push({
        kind,
        id: `${kind}-${String(ordinal).padStart(6, "0")}`,
        state: "active",
        touchedAt: "2026-09-01T00:00:00.000Z",
        attributedTo: `user-${String(ordinal % 12).padStart(2, "0")}`,
        body: { sequence: ordinal },
      });
    }
  }
  return entities;
}

/** Builds the event stream: each event replaces one existing entity with an updated copy. */
function buildApplyEventStream(
  entities: readonly StoredEntity[],
  eventCount: number,
): readonly StoredEntity[] {
  const sequence = new DeterministicSequence(0x5eed_1c17);
  const events: StoredEntity[] = [];
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
 * Times the per-event apply cost of one store, in milliseconds per event. Each sample seeds a
 * fresh store outside the timer, then times the events against a steady-state population.
 */
function measurePerEventApplyCost(
  createStore: () => BenchEntityStore,
  entities: readonly StoredEntity[],
  events: readonly StoredEntity[],
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

    // Read after the timer so the applies cannot be optimized away as dead stores.
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
  process.env["SIDEKICKS_BENCH_LEDGER_PATH"] ?? DEFAULT_BENCHMARK_LEDGER_PATH;

test(
  "store fan-out: the app's partition merge applies an event more cheaply than a flat map at 20,000 entities",
  { timeout: 300_000 },
  () => {
    const entities = buildStoredEntities(BENCHMARK_ENTITY_COUNT);
    const events = buildApplyEventStream(entities, EVENTS_PER_SAMPLE);

    const flat = measurePerEventApplyCost(
      () => new FlatEntityStore(),
      entities,
      events,
      RECORDED_SAMPLE_COUNT,
      WARM_UP_SAMPLE_COUNT,
    );
    const partitioned = measurePerEventApplyCost(
      () => new PartitionedEntityStore(),
      entities,
      events,
      RECORDED_SAMPLE_COUNT,
      WARM_UP_SAMPLE_COUNT,
    );

    const sharedContext = {
      entityCount: BENCHMARK_ENTITY_COUNT,
      partitionCount: ENTITY_KINDS.length,
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
        context: { ...sharedContext, storeShape: "Record<string, StoredEntity>" },
      },
      {
        benchmarkId: "store-fan-out.partitioned",
        label: "Partitioned entity map — the app's own mergeUpsert at 20,000 entities",
        unit: "ms/event",
        samples: partitioned.samples,
        context: {
          ...sharedContext,
          storeShape: "store/session/entities/entity-partitions.ts mergeUpsert",
        },
      },
    ];

    const appendedRows = new BenchmarkLedger(ledgerFilePath).appendAll(rowInputs);
    const speedup = flat.statistics.median / partitioned.statistics.median;

    console.log(
      [
        `store fan-out @ ${BENCHMARK_ENTITY_COUNT.toLocaleString("en-US")} entities, ${ENTITY_KINDS.length} partitions`,
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
        "Either the app's own partition merge lost its partitioning, or the " +
        "store-adoption claim no longer holds and its cost model needs re-deriving.",
    ).toBeGreaterThanOrEqual(MINIMUM_PARTITIONING_SPEEDUP);
  },
);
