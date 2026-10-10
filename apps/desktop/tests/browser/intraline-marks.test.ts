// A long replaced pair keeps its word marks. The pair is too long for the window's own thread, so
// it is compared on the window's alignment worker, which only a real browser can start: the row
// reads its whole line first, and the changed words once the worker's alignment lands. The worker
// ends once nothing is pending, and a worker that fails costs only the long pair its marks.

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseUnifiedPatch } from "#renderer/features/repos/diff/patch-parse.js";
import { IntralineSegmentCache } from "#renderer/features/repos/diff/intraline/segment-cache.js";
import { AlignmentWorker } from "#renderer/features/repos/diff/intraline/worker/handle.js";
import type { DiffModel } from "#renderer/features/repos/diff/model.js";
import type { DiffLineRow } from "#renderer/features/repos/diff/rows/model.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";

/** How long the worker may take to start and answer. */
const LANDING_TIMEOUT_MS = 5000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser — the word marks of a long replaced pair", () => {
  it("marks exactly the renamed words of a 3,000-character pair, then ends the worker", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const previousText = minifiedLine(new Set());
    const nextText = minifiedLine(new Set([7, 220, 441]));
    expect(previousText.length).toBeGreaterThan(3000);
    const cache = new IntralineSegmentCache(
      longPairModel(previousText, nextText),
      new AlignmentWorker(),
    );
    const row = bodyRow(0);
    const firstLanding = cache.landingFor(row);
    // The first read starts the worker and draws the whole line meanwhile.
    expect(cache.readingFor(row, 0).segments).toStrictEqual([
      { text: previousText, changed: false },
    ]);
    await nextChange(cache);
    expect(cache.landingFor(row)).not.toBe(firstLanding);

    expect(changedWords(cache, 0)).toStrictEqual(["v7", "v220", "v441"]);
    expect(changedWords(cache, 1)).toStrictEqual(["q7", "q220", "q441"]);
    // Both sides still read as the whole of their own line.
    expect(
      cache
        .readingFor(row, 0)
        .segments.map((segment) => segment.text)
        .join(""),
    ).toBe(previousText);
    // Nothing is pending, so the window runs no worker.
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("draws only the long pair whole when the worker fails, and records the failure", async () => {
    vi.stubGlobal("Worker", WorkerThatCannotLoad);
    const forwardedLines: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      forwardedLines.push(...jsonLines.split("\n").filter((line) => line.length > 0));
    });
    try {
      const previousText = minifiedLine(new Set());
      const cache = new IntralineSegmentCache(
        longPairModel(previousText, minifiedLine(new Set([7])), [
          "-const value = previousBudget;",
          "+const value = nextBudget;",
        ]),
        new AlignmentWorker(),
      );
      cache.readingFor(bodyRow(0), 0);
      await nextChange(cache);

      // The long pair keeps its whole-line wash; the short pair beside it is still marked.
      expect(cache.readingFor(bodyRow(0), 0).segments).toStrictEqual([
        { text: previousText, changed: false },
      ]);
      expect(changedWords(cache, 2)).toStrictEqual(["previousBudget"]);
      windowDiagnosticCapture.flush();
      expect(
        forwardedLines
          .map((line) => JSON.parse(line) as { source: string; kind: string })
          .filter((record) => record.source === "features/repos/diff/intraline"),
      ).toStrictEqual([
        expect.objectContaining({ kind: "alignment-worker-failed" }) as {
          source: string;
          kind: string;
        },
      ]);
    } finally {
      detachForwarder();
    }
  });
});

/** A worker whose script never loads: every message it is sent fails it. */
class WorkerThatCannotLoad extends EventTarget {
  public postMessage(): void {
    queueMicrotask(() => {
      this.dispatchEvent(new ErrorEvent("error", { message: "the script did not load" }));
    });
  }

  public terminate(): void {
    // Nothing runs, so there is nothing to end.
  }
}

/** One file whose one hunk replaces `previousText` with `nextText`, then any further lines. */
function longPairModel(
  previousText: string,
  nextText: string,
  furtherLines: readonly string[] = [],
): DiffModel {
  const furtherBase = furtherLines.filter((line) => !line.startsWith("+")).length;
  const furtherHead = furtherLines.filter((line) => !line.startsWith("-")).length;
  return parseUnifiedPatch(
    [
      "--- bundle.js",
      "+++ bundle.js",
      `@@ -1,${String(1 + furtherBase)} +1,${String(1 + furtherHead)} @@`,
      `-${previousText}`,
      `+${nextText}`,
      ...furtherLines,
      "",
    ].join("\n"),
    { baseRef: "main", headRef: "feature" },
  );
}

function bodyRow(lineIndex: number): DiffLineRow {
  return { kind: "line", fileIndex: 0, hunkIndex: 0, source: "hunk-body", lineIndex };
}

function changedWords(cache: IntralineSegmentCache, lineIndex: number): string[] {
  return cache
    .readingFor(bodyRow(lineIndex), lineIndex)
    .segments.filter((segment) => segment.changed)
    .map((segment) => segment.text);
}

/** The cache's next change, or a failure once the worker has had its time. */
async function nextChange(cache: IntralineSegmentCache): Promise<void> {
  let unsubscribe = (): void => undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        unsubscribe = cache.subscribe(resolve);
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("the alignment worker never answered"));
        }, LANDING_TIMEOUT_MS);
      }),
    ]);
  } finally {
    unsubscribe();
  }
}

/** A minified-looking line of short statements, about 3,000 characters. */
function minifiedLine(renamed: ReadonlySet<number>): string {
  const statements: string[] = [];
  for (let ordinal = 0; ordinal < 450; ordinal += 1) {
    statements.push(`${renamed.has(ordinal) ? "q" : "v"}${String(ordinal)}=e;`);
  }
  return statements.join("");
}
