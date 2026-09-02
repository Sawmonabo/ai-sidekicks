// Unit coverage for the bench-tier ledger — Plan-023 Phase 1C (T-023p-1C-1).
//
// The ledger makes three promises the benchmarks rely on: it appends and never
// deletes, its percentiles are computed from the samples it was handed, and a
// corrupt file is a loud failure rather than a silent reset. Each is asserted
// here — including the last, which is the one a passing benchmark run would
// never exercise and the one whose failure destroys history.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BenchmarkLedger,
  formatBenchmarkLedgerRow,
  readBenchmarkRuntimeEnvironment,
  readGitCommitSha,
  summarizeBenchmarkSamples,
} from "./ledger.js";

const temporaryDirectories: string[] = [];

function temporaryLedgerPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "console-bench-ledger-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "ledger.json");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("summarizeBenchmarkSamples", () => {
  it("returns values the run actually observed, by nearest rank", () => {
    // 20 samples: the 95th percentile position is ceil(0.95 * 20) = 19, so the
    // 19th smallest — index 18, value 19.
    const samples = Array.from({ length: 20 }, (_unused, index) => index + 1);
    const statistics = summarizeBenchmarkSamples(samples);

    expect(statistics.sampleCount).toBe(20);
    expect(statistics.minimum).toBe(1);
    expect(statistics.maximum).toBe(20);
    expect(statistics.median).toBe(10.5);
    expect(statistics.percentile95).toBe(19);
    expect(samples).toContain(statistics.percentile95);
  });

  it("takes the middle sample for an odd count, and never mutates its input", () => {
    const samples = [9, 1, 5];
    expect(summarizeBenchmarkSamples(samples).median).toBe(5);
    expect(samples).toStrictEqual([9, 1, 5]);
  });

  it("refuses an empty series rather than inventing a zero", () => {
    expect(() => summarizeBenchmarkSamples([])).toThrow(/empty sample series/);
  });
});

describe("BenchmarkLedger", () => {
  it("appends rows and never replaces them", () => {
    const ledger = new BenchmarkLedger(temporaryLedgerPath());

    ledger.append({ benchmarkId: "alpha", label: "Alpha", unit: "ms", samples: [3, 1, 2] });
    ledger.append({ benchmarkId: "alpha", label: "Alpha", unit: "ms", samples: [30, 10, 20] });
    ledger.append({ benchmarkId: "beta", label: "Beta", unit: "ms", samples: [7] });

    expect(ledger.readAll()).toHaveLength(3);
    const alphaRows = ledger.readBenchmark("alpha");
    expect(alphaRows).toHaveLength(2);
    // Oldest first, so a reader scanning down the ledger reads forward in time.
    expect(alphaRows[0]?.median).toBe(2);
    expect(alphaRows[1]?.median).toBe(20);
  });

  // The ledger path here is a temp directory outside the repository, which is
  // the case that catches a commit resolved from the OUTPUT location rather
  // than from the benchmarked code: that mistake stamps `null` on every
  // out-of-tree run and on none of the in-tree ones, so an in-tree-only test
  // would never see it.
  it("stamps provenance on every row — machine included — even writing out of tree", () => {
    const ledger = new BenchmarkLedger(temporaryLedgerPath());
    const [row] = ledger.appendAll([
      { benchmarkId: "gamma", label: "Gamma", unit: "ms/event", samples: [1, 2, 3] },
    ]);

    expect(row).toBeDefined();
    expect(row?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.gitCommitSha).toBe(readGitCommitSha());
    expect(row?.runtimeEnvironment.platform).toBe(readBenchmarkRuntimeEnvironment().platform);
    expect(row?.runtimeEnvironment.cpuCount).toBeGreaterThan(0);
  });

  it("carries a caller's context through unchanged", () => {
    const ledger = new BenchmarkLedger(temporaryLedgerPath());
    const row = ledger.append({
      benchmarkId: "delta",
      label: "Delta",
      unit: "ms",
      samples: [1],
      context: { entityCount: 20_000, partitioned: true },
    });
    expect(row.context).toStrictEqual({ entityCount: 20_000, partitioned: true });
  });

  it("reads an absent ledger as empty rather than failing", () => {
    expect(new BenchmarkLedger(temporaryLedgerPath()).readAll()).toStrictEqual([]);
  });

  it("refuses to overwrite a corrupt ledger, because that would delete history", () => {
    const ledgerFilePath = temporaryLedgerPath();
    writeFileSync(ledgerFilePath, "{ this is not json", "utf8");
    const ledger = new BenchmarkLedger(ledgerFilePath);

    expect(() => ledger.readAll()).toThrow(/not valid JSON and will not be overwritten/);
    expect(() =>
      ledger.append({ benchmarkId: "epsilon", label: "Epsilon", unit: "ms", samples: [1] }),
    ).toThrow(/not valid JSON and will not be overwritten/);
  });

  it("refuses a well-formed JSON document that is not a ledger", () => {
    const ledgerFilePath = temporaryLedgerPath();
    writeFileSync(ledgerFilePath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(() => new BenchmarkLedger(ledgerFilePath).readAll()).toThrow(
      /no `rows` array and will not be overwritten/,
    );
  });
});

describe("formatBenchmarkLedgerRow", () => {
  it("names the benchmark, the sample count, and every statistic with its unit", () => {
    const ledger = new BenchmarkLedger(temporaryLedgerPath());
    const row = ledger.append({
      benchmarkId: "store-fan-out.flat",
      label: "Flat map",
      unit: "ms/event",
      samples: [1, 2, 3, 4],
    });
    const line = formatBenchmarkLedgerRow(row);

    expect(line).toContain("store-fan-out.flat");
    expect(line).toContain("n=4");
    expect(line).toContain("min");
    expect(line).toContain("median");
    expect(line).toContain("p95");
    expect(line).toContain("max");
    expect(line).toContain("ms/event");
  });
});
