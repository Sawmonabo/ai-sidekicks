// Drawn pictures are kept for every block, so each case draws a source of its own. The drawing
// library stands in for itself here: its real layout needs a browser.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESOLVED_SCHEME_ATTRIBUTE } from "#shared/appearance.js";
import { DiagramBlock } from "./DiagramBlock.js";

/** The drawing library's two calls, and how many times its module has been evaluated. */
const drawingLibrary = vi.hoisted(() => ({
  evaluations: 0,
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  render: vi.fn<(id: string, text: string) => Promise<{ svg: string }>>(),
}));

vi.mock("mermaid", () => {
  drawingLibrary.evaluations += 1;
  return {
    default: { initialize: drawingLibrary.initialize, render: drawingLibrary.render },
  };
});

/** Read after every static import ran: a static import of the library would have evaluated it. */
const evaluationsAtImport = drawingLibrary.evaluations;

/** The parser's message for a source it cannot read, in the shape the library throws. */
const PARSE_FAILURE = "Parse error on line 3:\n...TD  A -->> oops\n---^\nExpecting 'NODE_STRING'";

/** The idle callbacks the window was asked for, in order; a canceled one is `undefined`. */
const idleCallbacks: (IdleRequestCallback | undefined)[] = [];

beforeEach(() => {
  idleCallbacks.length = 0;
  drawingLibrary.initialize.mockReset();
  drawingLibrary.render.mockReset();
  drawingLibrary.render.mockImplementation(async (id, text) => {
    if (text.includes("oops")) {
      throw new Error(PARSE_FAILURE);
    }
    return {
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" width="100%" ` +
        `style="max-width: 120.5px;" viewBox="0 0 120.5 80"><text>${text}</text></svg>`,
    };
  });
  window.requestIdleCallback = (callback) => {
    idleCallbacks.push(callback);
    return idleCallbacks.length;
  };
  window.cancelIdleCallback = (handle) => {
    idleCallbacks[handle - 1] = undefined;
  };
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(RESOLVED_SCHEME_ATTRIBUTE);
  document.documentElement.style.removeProperty("font-size");
  document.documentElement.style.removeProperty("--meridian-transcript-width");
});

/** Runs the oldest idle callback still armed, in an idle period `timeRemainingMs` long. */
function runIdlePeriod(timeRemainingMs = 50): void {
  const index = idleCallbacks.findIndex((armed) => armed !== undefined);
  const callback = idleCallbacks[index] ?? expect.fail("a drawing is waiting for idle time");
  idleCallbacks[index] = undefined;
  act(() => {
    callback({ didTimeout: false, timeRemaining: () => timeRemainingMs });
  });
}

function armedIdleCallbacks(): number {
  return idleCallbacks.filter((armed) => armed !== undefined).length;
}

describe("a diagram block", () => {
  it("loads the drawing library only when a settled block is first drawn", async () => {
    expect(evaluationsAtImport).toBe(0);
    render(
      <DiagramBlock source={"flowchart LR\n  load --> draw\n"} isSettled renderCopy={undefined} />,
    );
    runIdlePeriod();

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Diagram" })).toBeDefined();
    });
    expect(drawingLibrary.evaluations).toBe(1);
  });

  it("draws once, and a remount shows the kept picture at its size without drawing", async () => {
    const source = "flowchart LR\n  kept --> remounted\n";
    const first = render(<DiagramBlock source={source} isSettled renderCopy={undefined} />);
    // The source holds the picture's place until a long idle period comes.
    expect(first.container.querySelector("code")?.textContent).toBe(source);
    runIdlePeriod(10);
    expect(drawingLibrary.render).not.toHaveBeenCalled();
    runIdlePeriod();
    await waitFor(() => {
      expect(drawingLibrary.render).toHaveBeenCalledTimes(1);
    });
    first.unmount();

    const second = render(<DiagramBlock source={source} isSettled renderCopy={undefined} />);

    // On the first render, before any effect or idle time.
    const picture = second.container.querySelector("img");
    expect(picture?.getAttribute("width")).toBe("121");
    expect(picture?.getAttribute("height")).toBe("80");
    expect(picture?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/u);
    expect(second.container.querySelector("code")).toBeNull();
    expect(armedIdleCallbacks()).toBe(0);
    expect(drawingLibrary.render).toHaveBeenCalledTimes(1);
  });

  it("shows the parser's reason above its source when it cannot be drawn", async () => {
    const source = "flowchart TD\n  A --> B\n  A -->> oops\n";
    const { container } = render(<DiagramBlock source={source} isSettled renderCopy={undefined} />);
    runIdlePeriod();

    await waitFor(() => {
      expect(screen.getByText("Could not draw this diagram · Parse error on line 3")).toBeTruthy();
    });
    expect(container.querySelector("code")?.textContent).toBe(source);
    expect(container.querySelector("img")).toBeNull();
  });

  it("is drawn again when the scheme or the text size changes, and for nothing else", async () => {
    const root = document.documentElement;
    root.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "light");
    const { container } = render(
      <DiagramBlock
        source={"flowchart LR\n  scheme --> size\n"}
        isSettled
        renderCopy={undefined}
      />,
    );
    runIdlePeriod();
    await waitFor(() => {
      expect(drawingLibrary.render).toHaveBeenCalledTimes(1);
    });
    const lightPicture = container.querySelector("img")?.getAttribute("src");

    act(() => {
      root.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "dark");
    });
    await waitFor(() => {
      expect(armedIdleCallbacks()).toBe(1);
    });
    // The light picture stays until the dark one lands.
    expect(container.querySelector("img")?.getAttribute("src")).toBe(lightPicture);
    runIdlePeriod();
    await waitFor(() => {
      expect(drawingLibrary.render).toHaveBeenCalledTimes(2);
    });
    expect(drawingLibrary.initialize.mock.lastCall?.[0]).toMatchObject({ darkMode: true });

    act(() => {
      root.style.setProperty("font-size", "20px");
    });
    await waitFor(() => {
      expect(armedIdleCallbacks()).toBe(1);
    });
    runIdlePeriod();
    await waitFor(() => {
      expect(drawingLibrary.render).toHaveBeenCalledTimes(3);
    });
    expect(drawingLibrary.initialize.mock.lastCall?.[0]).toMatchObject({
      themeVariables: { fontSize: "16.25px" },
    });

    act(() => {
      root.style.setProperty("--meridian-transcript-width", "40rem");
      root.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "dark");
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(armedIdleCallbacks()).toBe(0);
    expect(drawingLibrary.render).toHaveBeenCalledTimes(3);
  });
});
