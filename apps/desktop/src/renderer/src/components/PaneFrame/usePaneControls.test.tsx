// The seam itself: absent means no host, and never a host offering nothing.
//
// The chrome's own suite covers what the two states RENDER. This covers the
// distinction they render from, which no rendering can witness: an empty object and
// `undefined` produce the same head — no controls — so a context that quietly
// defaulted to `{}` would be invisible there and would make "there is no host"
// indistinguishable from a pane layout that supplied nothing.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaneControlsContext, type PaneControls } from "./pane-controls.js";
import { usePaneControls } from "./usePaneControls.js";

/** Reads the seam once and hands the reading back, without rendering anything of it. */
function readSeam(wrap: (probe: React.JSX.Element) => React.JSX.Element): {
  readonly read: number;
  readonly value: PaneControls | undefined;
} {
  const readings: (PaneControls | undefined)[] = [];
  function SeamProbe(): null {
    readings.push(usePaneControls());
    return null;
  }
  render(wrap(<SeamProbe />));
  return { read: readings.length, value: readings[0] };
}

describe("pane controls — the seam", () => {
  it("answers `undefined` where no host is mounted", () => {
    const seam = readSeam((probe) => probe);
    expect(seam.read).toBe(1);
    expect(seam.value).toBeUndefined();
  });

  it("negative control: the absent answer is not an empty host", () => {
    // The whole distinction. Both render no controls, and only one of them means the
    // pane is outside a pane layout.
    expect(readSeam((probe) => probe).value).not.toStrictEqual({});
  });

  it("hands a mounted host's acts through untouched", () => {
    const controls: PaneControls = { onClose: () => undefined };
    const seam = readSeam((probe) => (
      <PaneControlsContext.Provider value={controls}>{probe}</PaneControlsContext.Provider>
    ));
    // Identity, not equality: a seam that rebuilt the object would give every reader a
    // fresh one and turn a memoised body into one that re-renders on every pane layout tick.
    expect(seam.value).toBe(controls);
  });

  it("negative control: a partial host is not filled in", () => {
    // A pane layout that provides the close alone. A seam that supplied a default for the
    // other acts would hand the chrome controls the host cannot serve.
    const seam = readSeam((probe) => (
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        {probe}
      </PaneControlsContext.Provider>
    ));
    expect(seam.value?.openPane).toBeUndefined();
    expect(seam.value?.registerDragHandle).toBeUndefined();
    expect(seam.value?.onClose).toBeTypeOf("function");
  });
});
