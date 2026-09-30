// An observer that is never disconnected outlives its subject, and a platform without the
// constructor must degrade rather than throw, or overlay registration and the terminal's grid
// re-fit would both stop.

import { afterEach, describe, expect, it, vi } from "vitest";

import { observeElementResize } from "./element-resize.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("observeElementResize", () => {
  it("reports every delivery until it is disposed, then disconnects", () => {
    const resizeObserver = installFakeResizeObserver();
    const element = document.createElement("div");
    const onResize = vi.fn();

    const detach = observeElementResize(element, onResize);
    expect(resizeObserver.observedCount()).toBe(1);
    resizeObserver.deliverAll();
    expect(onResize).toHaveBeenCalledTimes(1);

    detach();
    expect(resizeObserver.disconnectCount()).toBe(1);
  });

  it("negative control: a platform with no ResizeObserver arms nothing and reports nothing", () => {
    // Without the guard this throws instead of degrading.
    vi.stubGlobal("ResizeObserver", undefined);
    const onResize = vi.fn();

    const detach = observeElementResize(document.createElement("div"), onResize);
    detach();

    expect(onResize).not.toHaveBeenCalled();
  });
});
