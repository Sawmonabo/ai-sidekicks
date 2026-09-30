// `highlight.read` through the daemon's real method registry: the colorer's
// spans reach the wire packed, and each refusal holds.

import { describe, expect, it, vi } from "vitest";

import { HIGHLIGHT_READ_METHOD, HIGHLIGHT_SPANS_MAX_BYTES } from "@ai-sidekicks/contracts";

import { CodeHighlighter } from "../../../highlight/code-highlighter.js";
import { MethodRegistryImpl, RegistryDispatchError } from "../../registry.js";
import { registerHighlightRead } from "../highlight-read.js";

const dispatchContext = { transportId: 1 };

async function dispatchError(registry: MethodRegistryImpl, params: unknown): Promise<unknown> {
  try {
    await registry.dispatch(HIGHLIGHT_READ_METHOD, params, dispatchContext);
  } catch (error) {
    return error;
  }
  throw new Error("the dispatch was expected to be refused");
}

describe("highlight.read", () => {
  it("answers with the colorer's spans as a flat list", async () => {
    const registry = new MethodRegistryImpl();
    registerHighlightRead(registry, { highlighter: new CodeHighlighter() });
    const result = await registry.dispatch(
      HIGHLIGHT_READ_METHOD,
      { language: "python", source: "def main():\n    return 7\n" },
      dispatchContext,
    );
    // `def` and `return` are keywords, `main` a name, `7` a number.
    expect(result).toStrictEqual({ spans: [0, 3, 0, 4, 4, 1, 16, 6, 0, 23, 1, 3] });
  });

  it("refuses an unknown language and an over-bound source before coloring", async () => {
    const readSpans = vi.fn(async () => new Uint32Array());
    const registry = new MethodRegistryImpl();
    registerHighlightRead(registry, { highlighter: { readSpans } });
    for (const params of [
      { language: "cobol", source: "MOVE 1 TO X." },
      { language: "json", source: "1".repeat(300_000) },
    ]) {
      const refusal = await dispatchError(registry, params);
      expect(refusal).toBeInstanceOf(RegistryDispatchError);
      expect((refusal as RegistryDispatchError).registryCode).toBe("invalid_params");
    }
    expect(readSpans).not.toHaveBeenCalled();
  });

  it("fails a read whose spans would not fit one reply frame", async () => {
    const spanCount = Math.ceil(HIGHLIGHT_SPANS_MAX_BYTES / 10);
    const spans = new Uint32Array(spanCount * 3);
    for (let index = 0; index < spanCount; index += 1) {
      spans.set([1_000_000 + index * 2, 1, 0], index * 3);
    }
    const registry = new MethodRegistryImpl();
    registerHighlightRead(registry, { highlighter: { readSpans: async () => spans } });
    const refusal = await dispatchError(registry, { language: "json", source: "[1]" });
    expect(refusal).toBeInstanceOf(RegistryDispatchError);
    expect((refusal as RegistryDispatchError).registryCode).toBe("invalid_result");
  });
});
