// The menu accelerator table and its one conversion — Plan-023 Phase 1C.
//
// The table itself is a declaration, so what is checkable is the conversion beneath it
// and the property that makes one home worth having: the console's grammar goes in and
// Electron's spelling comes out, and a token neither side agrees on is refused loudly
// rather than handed to `Menu.buildFromTemplate`, which accepts an accelerator it
// cannot parse and renders an entry whose shortcut silently does nothing.

import { describe, expect, it } from "vitest";

import {
  AUXILIARY_MENU_CHORDS,
  AUXILIARY_MENU_CHORD_LIST,
  UnrenderableAcceleratorError,
  electronAcceleratorFor,
} from "./auxiliary-menu-chords.js";
import { AUXILIARY_ROUTE_LABELS } from "./auxiliary-routes.js";

describe("every auxiliary route carries a chord", () => {
  it("covers the route set exactly, with no entry for a route that does not exist", () => {
    // A `Record` over the route union is a compile-time claim; this is the runtime half
    // of it, and it is what makes the menu's `AUXILIARY_MENU_CHORDS[route]` total.
    expect(Object.keys(AUXILIARY_MENU_CHORDS).sort()).toEqual(
      Object.keys(AUXILIARY_ROUTE_LABELS).sort(),
    );
  });

  it("gives each route a chord no other route takes", () => {
    // Two entries on one accelerator is not an error Electron reports: it installs both
    // and one of them never fires.
    expect(new Set(AUXILIARY_MENU_CHORD_LIST).size).toBe(AUXILIARY_MENU_CHORD_LIST.length);
  });

  it("lists exactly the chords the record declares", () => {
    // The list is what the renderer's audit reads. A list that drifted from the record
    // would report a chord as free while the menu held it — the whole defect class.
    expect([...AUXILIARY_MENU_CHORD_LIST]).toEqual(Object.values(AUXILIARY_MENU_CHORDS));
  });
});

describe("the conversion renders what Electron parses", () => {
  it("renders every declared chord", () => {
    for (const chord of AUXILIARY_MENU_CHORD_LIST) {
      expect(electronAcceleratorFor(chord)).toMatch(/^CmdOrCtrl(\+[A-Za-z0-9]+)+$/);
    }
  });

  it("spells the primary modifier as Electron's cross-platform token", () => {
    expect(electronAcceleratorFor("$mod+KeyK")).toBe("CmdOrCtrl+K");
  });

  it("keeps modifier order and renders digits", () => {
    expect(electronAcceleratorFor("$mod+Shift+Alt+Digit1")).toBe("CmdOrCtrl+Shift+Alt+1");
  });
});

describe("the conversion refuses what Electron would swallow", () => {
  it("refuses a modifier it does not know", () => {
    // `Menu.buildFromTemplate` accepts `Hyper+K` and produces an entry with no working
    // shortcut, so the refusal has to happen on this side of the call.
    expect(() => electronAcceleratorFor("Hyper+KeyK")).toThrow(UnrenderableAcceleratorError);
  });

  it("refuses a key token it does not know", () => {
    expect(() => electronAcceleratorFor("$mod+Slash")).toThrow(UnrenderableAcceleratorError);
  });

  it("refuses a bare key with no modifier", () => {
    expect(() => electronAcceleratorFor("KeyK")).toThrow(UnrenderableAcceleratorError);
  });

  it("names the token that could not be rendered", () => {
    // A refusal that named only the whole chord would leave the reader to find which of
    // four tokens was wrong.
    expect(() => electronAcceleratorFor("Hyper+KeyK")).toThrow(/"Hyper"/);
  });
});
