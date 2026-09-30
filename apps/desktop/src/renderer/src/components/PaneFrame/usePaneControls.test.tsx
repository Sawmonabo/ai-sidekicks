// The seam: absent means no host, never a host offering nothing. Rendering cannot witness this,
// since `{}` and `undefined` both draw a head with no controls.

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
    // Both render no controls; only `undefined` means the pane is outside a pane layout.
    expect(readSeam((probe) => probe).value).not.toStrictEqual({});
  });

  it("hands a mounted host's acts through untouched", () => {
    const controls: PaneControls = { onClose: () => undefined };
    const seam = readSeam((probe) => (
      <PaneControlsContext.Provider value={controls}>{probe}</PaneControlsContext.Provider>
    ));
    // Identity, not equality: a rebuilt object would re-render memoized bodies every tick.
    expect(seam.value).toBe(controls);
  });

  it("negative control: a partial host is not filled in", () => {
    // The host provides close alone; a default for the other acts would offer controls it cannot
    // serve.
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
