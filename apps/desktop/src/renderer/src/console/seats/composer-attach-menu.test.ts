// The composer's attach menu: what a family may contribute, and what it may not.
//
// The registry is module-scope, so every case clears it first — the discipline
// `composer-seat.ts`'s own scaffolding names, applied here for the same reason.

import { afterEach, describe, expect, it } from "vitest";

import {
  clearComposerAttachMenu,
  composerAttachMenuEntries,
  registerComposerAttachMenuEntry,
  type ComposerAttachMenuEntry,
} from "./composer-attach-menu.js";

function entry(id: string, owner: string): ComposerAttachMenuEntry {
  return {
    id,
    owner,
    label: "Attach something",
    glyph: "plus",
    detail: "What picking it does.",
    attach: async () => ({ status: "attached" }),
  };
}

afterEach(() => {
  clearComposerAttachMenu();
});

describe("the composer attach menu", () => {
  it("renders contributed rows in registration order", () => {
    registerComposerAttachMenuEntry(entry("first", "browser"));
    registerComposerAttachMenuEntry(entry("second", "repos"));
    expect(composerAttachMenuEntries().map((row) => row.id)).toStrictEqual(["first", "second"]);
  });

  it("lets one owner replace its own row", () => {
    registerComposerAttachMenuEntry(entry("row", "browser"));
    const replacement = { ...entry("row", "browser"), label: "Attach page" };
    registerComposerAttachMenuEntry(replacement);
    expect(composerAttachMenuEntries()).toStrictEqual([replacement]);
  });

  it("refuses a second family claiming one row", () => {
    registerComposerAttachMenuEntry(entry("row", "browser"));
    expect(() => {
      registerComposerAttachMenuEntry(entry("row", "repos"));
    }).toThrow(/composer attach entry/u);
  });

  it("starts empty, so a window that composed nothing offers nothing", () => {
    expect(composerAttachMenuEntries()).toStrictEqual([]);
  });
});
