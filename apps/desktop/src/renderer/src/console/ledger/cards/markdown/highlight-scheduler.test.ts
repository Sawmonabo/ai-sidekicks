// Where a block is tokenised, where the answer is kept, and what happens when it cannot
// be tokenised at all.

import { afterEach, describe, expect, it } from "vitest";

import { CODE_HIGHLIGHT_SOURCE_BYTE_CAP, CODE_WORKER_THRESHOLD_BYTES } from "../card-bounds.js";
import { HIGHLIGHT_DECLINE_REASONS, CodeHighlightScheduler } from "./highlight-scheduler.js";

const schedulers: CodeHighlightScheduler[] = [];

function scheduler(byteCap?: number): CodeHighlightScheduler {
  const created =
    byteCap === undefined ? new CodeHighlightScheduler() : new CodeHighlightScheduler(byteCap);
  schedulers.push(created);
  return created;
}

afterEach(() => {
  for (const created of schedulers.splice(0)) {
    created.dispose();
  }
});

describe("tokenising a small block", () => {
  it("returns lines whose tokens carry family references and never colours", () => {
    const created = scheduler();
    return created.requestTokens("const answer = 1;\n", "typescript").then((outcome) => {
      expect(outcome.status).toBe("highlighted");
      if (outcome.status !== "highlighted") {
        return;
      }
      const references = outcome.lines
        .flat()
        .map((token) => token.colorReference)
        .filter((reference): reference is string => reference !== undefined);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference).toMatch(/^var\(--meridian-code-[a-z]+\)$/u);
      }
    });
  });

  it("serves the second request for one block from the cache", async () => {
    const created = scheduler();
    const first = await created.requestTokens("const a = 1;\n", "typescript");
    expect(created.cachedTokens("const a = 1;\n", "typescript")).not.toBeUndefined();
    const second = await created.requestTokens("const a = 1;\n", "typescript");
    expect(first.status).toBe("highlighted");
    expect(second.status).toBe("highlighted");
    if (first.status === "highlighted" && second.status === "highlighted") {
      expect(second.lines).toBe(first.lines);
    }
  });

  it("keys the cache on the language as well as the source", async () => {
    // The same text tokenises differently under two grammars; a key that dropped the
    // language would serve a JSON block's tokens for a YAML one.
    const created = scheduler();
    await created.requestTokens("a: 1\n", "yaml");
    expect(created.cachedTokens("a: 1\n", "yaml")).not.toBeUndefined();
    expect(created.cachedTokens("a: 1\n", "json")).toBeUndefined();
  });

  it("negative control: nothing is cached before it is asked for", () => {
    // Without this, a `cachedTokens` that answered with an empty array would make every
    // cache assertion above vacuous.
    expect(scheduler().cachedTokens("never requested\n", "typescript")).toBeUndefined();
  });
});

describe("declining to tokenise", () => {
  it("refuses a block past the source cap by name", async () => {
    const created = scheduler();
    const oversized = "x".repeat(CODE_HIGHLIGHT_SOURCE_BYTE_CAP + 1);
    const outcome = await created.requestTokens(oversized, "typescript");
    expect(outcome.status).toBe("declined");
    if (outcome.status === "declined") {
      expect(outcome.reason).toBe("source-too-large");
    }
  });

  it("names every refusal from its own closed set", async () => {
    const created = scheduler();
    const overThreshold = "y".repeat(CODE_WORKER_THRESHOLD_BYTES + 1);
    const outcome = await created.requestTokens(overThreshold, "typescript");
    if (outcome.status === "declined") {
      expect(HIGHLIGHT_DECLINE_REASONS).toContain(outcome.reason);
    } else {
      expect(outcome.lines.length).toBeGreaterThan(0);
    }
  });

  it("holds its cache inside a stated bound", async () => {
    const created = scheduler(512);
    await created.requestTokens("const a = 1;\n", "typescript");
    const stats = created.cacheStats();
    expect(stats.byteCap).toBe(512);
    expect(stats.retainedByteCount).toBeLessThanOrEqual(512);
  });
});
