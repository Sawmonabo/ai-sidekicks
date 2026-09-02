// The console bench-tier ledger — Plan-023 Phase 1C (T-023p-1C-1).
//
// `Spec-023 §Console Design (Meridian)`'s fourth product bar ("light on the
// machine") admits a library "only after its bytes, heap, and frame cost are
// measured against an own build", and `Spec-023 §Console Test Tiers` records
// endurance results "in a dated ledger that records refutations". The bench
// tier is where the own-build measurements those two rules depend on are taken,
// and this file is where their numbers go.
//
// Three properties, each deliberate:
//
//   • It appends and never deletes. A ledger that rewrites history cannot
//     record a refutation, which is the one thing `§Console Test Tiers` asks of
//     it. Re-running a benchmark adds a row; it does not replace one.
//
//   • Every row carries its provenance — the git commit the numbers were taken
//     at (best effort; a detached or git-less checkout records `null` rather
//     than failing the run), an ISO timestamp, AND the machine that produced
//     them. The machine is not decoration: a benchmark row is meaningless
//     without it, because two rows from different hardware differ by more than
//     any regression this tier is meant to catch, and a reader comparing them
//     without knowing that would draw exactly the wrong conclusion.
//
//   • Statistics come from the raw samples, not from a summary the harness was
//     handed. `summarizeBenchmarkSamples` computes min, median, p95, and max by
//     sorting the samples it is given, so the p95 is the real 95th percentile
//     of that run rather than an interpolation of somebody else's percentiles.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The machine a row's numbers were taken on. Recorded per row rather than per
 * document because one ledger accumulates rows from developer laptops and CI
 * runners alike, and a timing is only comparable to another timing from the
 * same hardware.
 */
export interface BenchmarkRuntimeEnvironment {
  readonly nodeVersion: string;
  readonly platform: string;
  /** `null` when the OS reports no CPU list (containers occasionally do not). */
  readonly cpuModel: string | null;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
}

/** Summary statistics over one benchmark's sample series. */
export interface BenchmarkSampleStatistics {
  readonly sampleCount: number;
  readonly minimum: number;
  readonly median: number;
  readonly percentile95: number;
  readonly maximum: number;
}

/** What a benchmark hands the ledger. */
export interface BenchmarkLedgerRowInput {
  /** Stable identifier for this benchmark; rows with the same id are comparable over time. */
  readonly benchmarkId: string;
  /** Human label for the ledger reader. */
  readonly label: string;
  /** The unit every sample is expressed in (e.g. `"ms/event"`, `"ms"`). */
  readonly unit: string;
  /** The raw per-sample measurements. */
  readonly samples: readonly number[];
  /** Anything a reader needs to interpret the numbers — entity counts, batch sizes, machine notes. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

/** One appended ledger row. */
export interface BenchmarkLedgerRow extends BenchmarkSampleStatistics {
  readonly benchmarkId: string;
  readonly label: string;
  readonly unit: string;
  /** `null` when the commit could not be read (git absent, or not a repository). */
  readonly gitCommitSha: string | null;
  readonly recordedAt: string;
  readonly runtimeEnvironment: BenchmarkRuntimeEnvironment;
  readonly context: Readonly<Record<string, string | number | boolean>>;
}

/** The on-disk ledger document. */
export interface BenchmarkLedgerDocument {
  readonly schemaVersion: number;
  readonly rows: readonly BenchmarkLedgerRow[];
}

const LEDGER_SCHEMA_VERSION = 1;

const THIS_DIRECTORY: string = path.dirname(fileURLToPath(import.meta.url));

/** Default ledger path: beside the benchmarks that write it. */
export const DEFAULT_BENCHMARK_LEDGER_PATH: string = path.join(THIS_DIRECTORY, "ledger.json");

/**
 * Computes min / median / p95 / max over a sample series.
 *
 * The percentile is the nearest-rank definition — the smallest sample at or
 * above the 95th percentile position — which for a small sample count is the
 * only definition that returns a value the run actually observed.
 */
export function summarizeBenchmarkSamples(samples: readonly number[]): BenchmarkSampleStatistics {
  if (samples.length === 0) {
    throw new Error("summarizeBenchmarkSamples: refusing to summarize an empty sample series");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const sampleCount = sorted.length;

  const valueAtIndex = (index: number): number => {
    const clamped = Math.min(Math.max(index, 0), sampleCount - 1);
    const value = sorted[clamped];
    if (value === undefined) {
      throw new Error(`summarizeBenchmarkSamples: no sample at index ${clamped}`);
    }
    return value;
  };

  const medianIndex = Math.floor((sampleCount - 1) / 2);
  const median =
    sampleCount % 2 === 1
      ? valueAtIndex(medianIndex)
      : (valueAtIndex(medianIndex) + valueAtIndex(medianIndex + 1)) / 2;

  return {
    sampleCount,
    minimum: valueAtIndex(0),
    median,
    percentile95: valueAtIndex(Math.ceil(0.95 * sampleCount) - 1),
    maximum: valueAtIndex(sampleCount - 1),
  };
}

/** Reads the machine this process is running on. */
export function readBenchmarkRuntimeEnvironment(): BenchmarkRuntimeEnvironment {
  const cpus = os.cpus();
  const firstCpu = cpus[0];
  return {
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuModel: firstCpu === undefined ? null : firstCpu.model,
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

/**
 * Reads the current commit, tolerating every failure mode: no git on the path,
 * not a repository, a shallow clone with no HEAD. A ledger row without a commit
 * is still worth keeping; a benchmark that fails because git is missing is not.
 */
export function readGitCommitSha(workingDirectory: string = THIS_DIRECTORY): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Append-only ledger over a JSON document.
 *
 * Stateful (it owns a file path and a lazily-read commit), so it is a class
 * rather than a pair of free functions.
 */
export class BenchmarkLedger {
  readonly #ledgerFilePath: string;
  #gitCommitShaResolved = false;
  #gitCommitSha: string | null = null;

  constructor(ledgerFilePath: string = DEFAULT_BENCHMARK_LEDGER_PATH) {
    this.#ledgerFilePath = ledgerFilePath;
  }

  get ledgerFilePath(): string {
    return this.#ledgerFilePath;
  }

  /** Every row ever appended, oldest first. An absent or unreadable file reads as empty. */
  readAll(): readonly BenchmarkLedgerRow[] {
    return this.#readDocument().rows;
  }

  /** Rows for one benchmark id, oldest first. */
  readBenchmark(benchmarkId: string): readonly BenchmarkLedgerRow[] {
    return this.readAll().filter((row) => row.benchmarkId === benchmarkId);
  }

  /** Appends one row, computing its statistics from the raw samples. Never deletes. */
  append(input: BenchmarkLedgerRowInput): BenchmarkLedgerRow {
    const statistics = summarizeBenchmarkSamples(input.samples);
    const row: BenchmarkLedgerRow = {
      benchmarkId: input.benchmarkId,
      label: input.label,
      unit: input.unit,
      gitCommitSha: this.#resolveGitCommitSha(),
      recordedAt: new Date().toISOString(),
      runtimeEnvironment: readBenchmarkRuntimeEnvironment(),
      context: input.context ?? {},
      ...statistics,
    };
    const document = this.#readDocument();
    this.#writeDocument({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      rows: [...document.rows, row],
    });
    return row;
  }

  /** Appends several rows in one write, so a multi-arm benchmark lands atomically. */
  appendAll(inputs: readonly BenchmarkLedgerRowInput[]): readonly BenchmarkLedgerRow[] {
    const gitCommitSha = this.#resolveGitCommitSha();
    const recordedAt = new Date().toISOString();
    const runtimeEnvironment = readBenchmarkRuntimeEnvironment();
    const rows: BenchmarkLedgerRow[] = inputs.map((input) => ({
      benchmarkId: input.benchmarkId,
      label: input.label,
      unit: input.unit,
      gitCommitSha,
      recordedAt,
      runtimeEnvironment,
      context: input.context ?? {},
      ...summarizeBenchmarkSamples(input.samples),
    }));
    const document = this.#readDocument();
    this.#writeDocument({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      rows: [...document.rows, ...rows],
    });
    return rows;
  }

  #resolveGitCommitSha(): string | null {
    if (!this.#gitCommitShaResolved) {
      // Resolved from THIS module's directory, deliberately, and not from the
      // ledger file's. The commit a row records is the commit of the code that
      // was benchmarked; a run directed at an out-of-tree output path (a
      // scratch file, a CI artifact directory) must still stamp that commit,
      // and reading git from the output location would silently record `null`
      // for exactly those runs.
      this.#gitCommitSha = readGitCommitSha();
      this.#gitCommitShaResolved = true;
    }
    return this.#gitCommitSha;
  }

  #readDocument(): BenchmarkLedgerDocument {
    let fileText: string;
    try {
      fileText = readFileSync(this.#ledgerFilePath, "utf8");
    } catch {
      return { schemaVersion: LEDGER_SCHEMA_VERSION, rows: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileText);
    } catch (parseError) {
      // A corrupt ledger is a loud failure, never a silent reset: overwriting it
      // would delete history, which this class exists not to do.
      throw new Error(
        `Benchmark ledger at ${this.#ledgerFilePath} is not valid JSON and will not be overwritten: ${String(parseError)}`,
        { cause: parseError },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { rows?: unknown }).rows)
    ) {
      throw new Error(
        `Benchmark ledger at ${this.#ledgerFilePath} has no \`rows\` array and will not be overwritten`,
      );
    }
    return parsed as BenchmarkLedgerDocument;
  }

  #writeDocument(document: BenchmarkLedgerDocument): void {
    mkdirSync(path.dirname(this.#ledgerFilePath), { recursive: true });
    writeFileSync(this.#ledgerFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

/** Renders one row as a single readable line, for a benchmark's own stdout. */
export function formatBenchmarkLedgerRow(row: BenchmarkLedgerRow): string {
  const format = (value: number): string => value.toPrecision(4);
  return (
    `${row.benchmarkId}  n=${row.sampleCount}  ` +
    `min ${format(row.minimum)} ${row.unit}  ` +
    `median ${format(row.median)} ${row.unit}  ` +
    `p95 ${format(row.percentile95)} ${row.unit}  ` +
    `max ${format(row.maximum)} ${row.unit}`
  );
}
