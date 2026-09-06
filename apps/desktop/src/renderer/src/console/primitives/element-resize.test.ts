// The console's one size observer, against a platform that can be missing it.
//
// Two claims, and the second is why the module exists at all: a resize observer that
// is never disconnected outlives its subject, and a platform without the constructor
// has to degrade rather than throw — a seam that threw here would stop the overlay
// registry registering overlays and stop the terminal re-fitting its grid, on the
// same host, for the same missing global.

import { afterEach, describe, expect, it, vi } from "vitest";

import { observeElementResize } from "./element-resize.js";
import { installFakeResizeObserver } from "./element-resize.test-support.js";

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
    // Without the guard this line throws rather than degrading, and the whole
    // registry stops registering overlays on that platform.
    vi.stubGlobal("ResizeObserver", undefined);
    const onResize = vi.fn();

    const detach = observeElementResize(document.createElement("div"), onResize);
    detach();

    expect(onResize).not.toHaveBeenCalled();
  });
});
