// The bench-tier ledger: where the own-build measurements (bytes, heap, frame cost) are recorded.
//
// - It appends and never deletes: a ledger that rewrites history cannot record a refutation.
// - Every row carries its provenance: the git commit (best effort; a detached or git-less
//   checkout records `null` rather than failing the run), an ISO timestamp and the machine,
//   because rows from different hardware differ by more than any regression this tier catches.
// - Statistics come from the raw samples: `summarizeBenchmarkSamples` sorts what it is given, so
//   p95 is the real 95th percentile of that run.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The machine a row's numbers were taken on. Recorded per row because one ledger accumulates
 * rows from laptops and CI runners, and a timing is only comparable on the same hardware.
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
  /** Anything a reader needs to interpret the numbers: entity counts, batch sizes, notes. */
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
 * Computes min / median / p95 / max over a sample series, throwing on an empty one. The
 * percentile is nearest-rank, the only definition that returns a value the run observed.
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
 * Reads the current commit, tolerating every failure (no git, not a repository, a shallow clone
 * with no HEAD): a row without a commit is worth keeping, a benchmark failing over git is not.
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

/** Append-only ledger over a JSON document; it owns a file path and a lazily-read commit. */
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
      // Resolved from this module's directory, not the ledger file's: a row records the commit
      // of the benchmarked code, and a run writing to an out-of-tree path would otherwise record
      // `null`.
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
      // A corrupt ledger is a loud failure, never a silent reset, since overwriting it would
      // delete history.
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
