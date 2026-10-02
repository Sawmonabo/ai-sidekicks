// The streaming block layer's benchmark gate: the bench tier's second arm.
//
// The console's streaming block layer is its largest own build: an incremental block
// segmenter, a memoized settled-block parse, and a tail that is the only text `remend` is
// applied to. It ships only on a measured win over the library path, and this file measures it.
//
// Both arms consume the same recorded stream and produce the same trees, and both call the
// console's real modules, so a regression in the segmenter or a cache that stops caching moves
// the number:
//
// - own: `MarkdownBlockSegmenter` splits each cumulative snapshot into settled blocks and a
//   volatile tail; settled blocks go through `parseSettledBlock`, which memoizes by block text,
//   and only the tail is re-parsed per delta.
// - library: no segmentation and no memo; every delta re-parses the whole accumulated message.
//
// The library arm's cost per delta grows with the message, while the own arm's grows with the
// tail, which the segmenter keeps bounded. The gate is therefore on the ratio, not on an
// absolute time, which depends on the machine.
//
// Not measured here: a volatile tail written as a direct DOM text node the framework never
// reconciles (bounded by a character limit, word-segmented with `Intl.Segmenter`, handed back by
// keyed remount when the block settles). Its gate needs p95 frame time and retained heap, and
// this `node`-environment project has no compositor, frame or renderer heap; a DOM-mutation
// figure taken under `jsdom` would measure `jsdom`, not Chromium. So the direct-DOM tail is not
// shipped and the library path stands for the tail. A frame-time reading for it would have to
// come from the endurance tier.

import { performance } from "node:perf_hooks";
import process from "node:process";

import { expect, test } from "vitest";

import { MarkdownBlockSegmenter } from "@renderer/features/transcript/rows/markdown/parse/block-segmenter.js";
import {
  parseSettledBlock,
  parseVolatileTail,
} from "@renderer/features/transcript/rows/markdown/parse/markdown-parse.js";
import {
  BenchmarkLedger,
  DEFAULT_BENCHMARK_LEDGER_PATH,
  formatBenchmarkLedgerRow,
  summarizeBenchmarkSamples,
  type BenchmarkLedgerRowInput,
} from "./ledger.js";

/** Lanes streaming at once, a busy session. */
const CONCURRENT_LANE_COUNT = 12;

/** Deltas each lane receives. One sample replays every one of them. */
const DELTAS_PER_LANE = 40;

/** Recorded samples, and the warm-up passes discarded before them. */
const RECORDED_SAMPLE_COUNT = 9;
const WARM_UP_SAMPLE_COUNT = 2;

/**
 * The floor the own layer has to clear. Deliberately modest: it fails when the mechanism is
 * gone (the segmenter stopped bounding the re-parsed text, or the settled-block cache stopped
 * hitting), not to encode one machine's margin.
 */
const MINIMUM_INCREMENTAL_SPEEDUP = 2;

/**
 * One lane's recorded stream: the cumulative snapshots a card would be handed. It mixes prose
 * blocks, a fenced code block and a list so the segmenter does real work.
 */
function buildLaneSnapshots(laneIndex: number): readonly string[] {
  const snapshots: string[] = [];
  let cumulative = `## Lane ${String(laneIndex)} — run summary\n\n`;
  for (let delta = 0; delta < DELTAS_PER_LANE; delta += 1) {
    if (delta % 7 === 3) {
      cumulative += `\`\`\`ts\nconst step${String(delta)} = resolveStep(${String(delta)});\n\`\`\`\n\n`;
    } else if (delta % 5 === 2) {
      cumulative += `- item ${String(delta)} for lane ${String(laneIndex)}\n- follow-up ${String(delta)}\n\n`;
    } else {
      cumulative += `Paragraph ${String(delta)} of lane ${String(laneIndex)}: the reveal engine published this much of the turn, and the block layer has to decide how much of it has settled.\n\n`;
    }
    snapshots.push(cumulative);
  }
  return snapshots;
}

const LANE_SNAPSHOTS: readonly (readonly string[])[] = Array.from(
  { length: CONCURRENT_LANE_COUNT },
  (_unused, laneIndex) => buildLaneSnapshots(laneIndex),
);

/** Total deltas one sample replays, across every lane. */
const DELTAS_PER_SAMPLE = CONCURRENT_LANE_COUNT * DELTAS_PER_LANE;

/** The own layer: segment, parse the settled blocks through the memo, re-parse the tail. */
function replayThroughOwnLayer(): number {
  const segmenters = LANE_SNAPSHOTS.map(() => new MarkdownBlockSegmenter());
  let parsedNodeCount = 0;
  for (let delta = 0; delta < DELTAS_PER_LANE; delta += 1) {
    for (const [laneIndex, snapshots] of LANE_SNAPSHOTS.entries()) {
      const segmenter = segmenters[laneIndex];
      const snapshot = snapshots[delta];
      if (segmenter === undefined || snapshot === undefined) {
        continue;
      }
      const segmentation = segmenter.segment(snapshot);
      for (const settledBlock of segmentation.settledBlocks) {
        parsedNodeCount += parseSettledBlock(settledBlock).children.length;
      }
      parsedNodeCount += parseVolatileTail(segmentation.volatileTail).children.length;
    }
  }
  return parsedNodeCount;
}

/** The library path: every delta re-parses the whole accumulated message. */
function replayThroughLibraryPath(): number {
  let parsedNodeCount = 0;
  for (let delta = 0; delta < DELTAS_PER_LANE; delta += 1) {
    for (const snapshots of LANE_SNAPSHOTS) {
      const snapshot = snapshots[delta];
      if (snapshot === undefined) {
        continue;
      }
      parsedNodeCount += parseVolatileTail(snapshot).children.length;
    }
  }
  return parsedNodeCount;
}

/** Milliseconds per delta, sampled over whole replays. */
function measurePerDeltaCost(replay: () => number): {
  readonly samples: readonly number[];
  readonly statistics: ReturnType<typeof summarizeBenchmarkSamples>;
} {
  for (let warmUp = 0; warmUp < WARM_UP_SAMPLE_COUNT; warmUp += 1) {
    replay();
  }
  const samples: number[] = [];
  for (let sample = 0; sample < RECORDED_SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    replay();
    samples.push((performance.now() - startedAt) / DELTAS_PER_SAMPLE);
  }
  return { samples, statistics: summarizeBenchmarkSamples(samples) };
}

const ledgerFilePath = process.env["SIDEKICKS_BENCH_LEDGER_PATH"] ?? DEFAULT_BENCHMARK_LEDGER_PATH;

test(
  "streaming layer: the incremental block layer parses a delta more cheaply than re-parsing the message",
  { timeout: 300_000 },
  () => {
    const library = measurePerDeltaCost(replayThroughLibraryPath);
    const own = measurePerDeltaCost(replayThroughOwnLayer);

    const sharedContext = {
      laneCount: CONCURRENT_LANE_COUNT,
      deltasPerLane: DELTAS_PER_LANE,
      deltasPerSample: DELTAS_PER_SAMPLE,
      warmUpSamplesDiscarded: WARM_UP_SAMPLE_COUNT,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      // Recorded on the row so a reader knows these numbers say nothing about frame time or
      // retained heap.
      measures: "parse and segmentation cost only; no frame time, no retained heap",
    } as const;

    const rowInputs: readonly BenchmarkLedgerRowInput[] = [
      {
        benchmarkId: "streaming-layer.library",
        label: "Library path — whole-message re-parse per delta (control)",
        unit: "ms/delta",
        samples: library.samples,
        context: { ...sharedContext, path: "parseVolatileTail(cumulativeSource)" },
      },
      {
        benchmarkId: "streaming-layer.own",
        label: "Own layer — incremental segmentation with a memoized settled-block parse",
        unit: "ms/delta",
        samples: own.samples,
        context: {
          ...sharedContext,
          path: "MarkdownBlockSegmenter + parseSettledBlock + parseVolatileTail(tail)",
        },
      },
    ];

    const appendedRows = new BenchmarkLedger(ledgerFilePath).appendAll(rowInputs);
    const speedup = library.statistics.median / own.statistics.median;

    console.log(
      [
        `streaming layer @ ${String(CONCURRENT_LANE_COUNT)} lanes × ${String(DELTAS_PER_LANE)} deltas`,
        ...appendedRows.map((row) => `  ${formatBenchmarkLedgerRow(row)}`),
        `  incremental speedup (median): ${speedup.toFixed(1)}×`,
        `  direct-DOM volatile tail: not measured in this tier, not shipped (see file header)`,
        `  ledger: ${ledgerFilePath}`,
      ].join("\n"),
    );

    expect(own.statistics.sampleCount).toBe(RECORDED_SAMPLE_COUNT);
    expect(library.statistics.sampleCount).toBe(RECORDED_SAMPLE_COUNT);
    expect(
      speedup,
      `The incremental block layer bought ${speedup.toFixed(1)}× against a floor of ${String(MINIMUM_INCREMENTAL_SPEEDUP)}×. ` +
        "Either the segmenter stopped bounding the re-parsed text, or the settled-block cache stopped hitting — " +
        "and the own streaming block layer ships only on a measured win over the library path.",
    ).toBeGreaterThanOrEqual(MINIMUM_INCREMENTAL_SPEEDUP);
  },
);
