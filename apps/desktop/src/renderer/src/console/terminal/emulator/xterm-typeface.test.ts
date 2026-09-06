// What the grid is told to draw in, and when it is told nothing.

import { describe, expect, it } from "vitest";

import {
  applyDeclaredMonospaceFamily,
  readDeclaredMonospaceFamily,
  type TypefaceBearingTerminal,
} from "./xterm-typeface.js";

/** An emulator stand-in that records what was written to it, and how often. */
function fakeTerminal(fontFamily?: string): TypefaceBearingTerminal & { writeCount: number } {
  let current = fontFamily;
  const record = {
    writeCount: 0,
    options: {
      get fontFamily(): string | undefined {
        return current;
      },
      set fontFamily(next: string | undefined) {
        current = next;
        record.writeCount += 1;
      },
    },
  };
  return record;
}

/** A host element in the document, carrying whatever face the caller declares. */
function hostDeclaring(fontFamily: string | undefined): HTMLElement {
  const element = document.createElement("div");
  if (fontFamily !== undefined) {
    element.style.fontFamily = fontFamily;
  }
  document.body.append(element);
  return element;
}

describe("the face the grid is told to draw in", () => {
  it("reads the family its host declares", () => {
    expect(readDeclaredMonospaceFamily(hostDeclaring("Menlo, monospace"))).toBe("Menlo, monospace");
  });

  it("reads nothing from a host outside any document", () => {
    // The shape a detached element and a DOM shim both answer with. It has to be
    // distinguishable from a real declaration, because the two are treated
    // differently one function down.
    expect(readDeclaredMonospaceFamily(document.createElement("div"))).toBeUndefined();
  });

  it("tells the emulator the face its host is in", () => {
    const terminal = fakeTerminal("courier-new, courier, monospace");

    applyDeclaredMonospaceFamily(terminal, hostDeclaring("Menlo, monospace"));

    expect(terminal.options.fontFamily).toBe("Menlo, monospace");
  });

  it("leaves the library's own default alone where the host declares nothing", () => {
    // Not a cleared option: a grid with no face at all draws nothing, and the
    // library's default is a worse face rather than an absent one.
    const terminal = fakeTerminal("courier-new, courier, monospace");

    applyDeclaredMonospaceFamily(terminal, document.createElement("div"));

    expect(terminal.options.fontFamily).toBe("courier-new, courier, monospace");
    expect(terminal.writeCount).toBe(0);
  });

  it("does not rewrite the face it is already set to", () => {
    // The write re-measures the cell and repaints every row, and `attach` runs on
    // every remount — so the guard is the difference between a remount that costs
    // nothing and one that costs a full re-render.
    const terminal = fakeTerminal("Menlo, monospace");

    applyDeclaredMonospaceFamily(terminal, hostDeclaring("Menlo, monospace"));

    expect(terminal.writeCount).toBe(0);
  });
});
