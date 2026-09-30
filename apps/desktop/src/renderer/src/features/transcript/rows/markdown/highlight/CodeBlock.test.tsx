// A code block is legible before it is colored, paints the daemon's spans as classes,
// and asks only when it is settled, names a language the daemon colors, and has not
// been answered before.
//
// The span cache is shared by every block, so each case draws a source of its own.

import { render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";

import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { CodeBlock } from "./CodeBlock.js";

function answeringSpans(spans: readonly number[]): ReturnType<typeof bridgeAnswering> {
  return bridgeAnswering(async (call, passThrough) =>
    call.method === "highlight.read" ? { spans } : passThrough(),
  );
}

function highlightReads(calls: readonly RecordedDaemonCall[]): readonly RecordedDaemonCall[] {
  return calls.filter((call) => call.method === "highlight.read");
}

function paintedSpans(container: HTMLElement): readonly (readonly [string, string])[] {
  return [...container.querySelectorAll("code span")].map((span) => [
    span.className,
    span.textContent ?? "",
  ]);
}

/**
 * Reads the DOM at the first commit, before any passive effect runs: what the first
 * frame would paint. A read after `render` returns sees the effects' work too.
 */
function FirstCommit(props: { readonly onCommit: () => void }): null {
  useLayoutEffect(() => {
    props.onCommit();
  }, []);
  return null;
}

describe("a settled code block", () => {
  it("shows its source at once, before the daemon answers", () => {
    const { bridge } = bridgeAnswering(() => new Promise(() => undefined));
    const { container } = render(
      <CodeBlock source="const early = 1;" infoString="ts" isSettled />,
      { wrapper: bridgeWrapper(bridge) },
    );
    expect(container.textContent).toBe("const early = 1;");
  });

  it("paints each span as its class over the text it covers", async () => {
    const source = "const painted = 1;";
    const { bridge, calls } = answeringSpans([0, 5, 0, 6, 7, 1, 16, 1, 3]);
    const { container } = render(<CodeBlock source={source} infoString="ts" isSettled />, {
      wrapper: bridgeWrapper(bridge),
    });
    await waitFor(() => {
      expect(paintedSpans(container)).toStrictEqual([
        ["meridian-code__keyword", "const"],
        ["meridian-code__name", "painted"],
        ["meridian-code__number", "1"],
      ]);
    });
    expect(container.textContent).toBe(source);
    expect(container.querySelector("[style]")).toBeNull();
    expect(highlightReads(calls)).toStrictEqual([
      { method: "highlight.read", params: { language: "typescript", source } },
    ]);
  });

  it("cuts the source in UTF-16 code units, as the daemon counts them", async () => {
    // The face takes two code units; a cut by characters would paint `a';` as the string.
    const source = "x = '😀'; y = 'a';";
    const { bridge } = answeringSpans([4, 4, 2, 14, 3, 2]);
    const { container } = render(<CodeBlock source={source} infoString="js" isSettled />, {
      wrapper: bridgeWrapper(bridge),
    });
    await waitFor(() => {
      expect(paintedSpans(container)).toStrictEqual([
        ["meridian-code__string", "'😀'"],
        ["meridian-code__string", "'a'"],
      ]);
    });
    expect(container.textContent).toBe(source);
  });

  it("paints a block drawn again from what it was handed, without asking again", async () => {
    const source = "const again = 2;";
    const { bridge, calls } = answeringSpans([0, 5, 0]);
    const first = render(<CodeBlock source={source} infoString="ts" isSettled />, {
      wrapper: bridgeWrapper(bridge),
    });
    await waitFor(() => {
      expect(paintedSpans(first.container)).toHaveLength(1);
    });
    first.unmount();

    const container = document.body.appendChild(document.createElement("div"));
    let firstFrame: readonly (readonly [string, string])[] = [];
    render(
      <>
        <CodeBlock source={source} infoString="ts" isSettled />
        <FirstCommit
          onCommit={() => {
            firstFrame = paintedSpans(container);
          }}
        />
      </>,
      { container, wrapper: bridgeWrapper(bridge) },
    );
    // Colored on its first frame: a block scrolled back to never shows plain first.
    expect(firstFrame).toStrictEqual([["meridian-code__keyword", "const"]]);
    expect(highlightReads(calls)).toHaveLength(1);
  });

  it("stays plain when the read is refused", async () => {
    // The shipped fixture scripts no `highlight.read`, so the call is refused.
    const source = "const refused = 3;";
    const { bridge, calls } = bridgeAnswering((_call, passThrough) => passThrough());
    const { container } = render(<CodeBlock source={source} infoString="ts" isSettled />, {
      wrapper: bridgeWrapper(bridge),
    });
    await waitFor(() => {
      expect(highlightReads(calls)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paintedSpans(container)).toStrictEqual([]);
    expect(container.textContent).toBe(source);
  });

  it("carries the fence's info string wire-verbatim", () => {
    const { container } = render(
      <CodeBlock source="x" infoString="TypeScript" isSettled={false} />,
    );
    expect(container.querySelector(".meridian-code")?.getAttribute("data-language")).toBe(
      "TypeScript",
    );
  });
});

describe("a block that asks nothing", () => {
  it("negative control: a block still streaming is never colored", async () => {
    // Its text changes every frame, and the colors of an unfinished line would ripple
    // as the grammar's reading of it changed under the reader.
    const { bridge, calls } = answeringSpans([0, 5, 0]);
    const { container } = render(
      <CodeBlock source="const streaming = 4;" infoString="ts" isSettled={false} />,
      { wrapper: bridgeWrapper(bridge) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(highlightReads(calls)).toStrictEqual([]);
    expect(container.textContent).toBe("const streaming = 4;");
  });

  it("renders a language the daemon does not color as plain text and asks nothing", async () => {
    const { bridge, calls } = answeringSpans([0, 3, 0]);
    const { container } = render(
      <CodeBlock source="?!? not a language" infoString="brainfuck" isSettled />,
      { wrapper: bridgeWrapper(bridge) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(highlightReads(calls)).toStrictEqual([]);
    expect(container.textContent).toBe("?!? not a language");
  });
});
