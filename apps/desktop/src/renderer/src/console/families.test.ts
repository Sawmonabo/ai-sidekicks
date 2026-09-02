// Composition holds: every family that fills a seat gets a slot of its own.
//
// The seat board is edited by concurrent branches — that is the whole reason it
// exists — and the failure it invites is two families claiming one slot. The
// registry refuses that rather than letting module evaluation order pick a
// winner, so the conflict IS caught; the question is where. Without this file it
// surfaces at import time in a running window, as a blank console with a message
// in a devtools log nobody has open. With it, it surfaces in the unit tier, named
// by slot, before the branch merges.
//
// The assertions are deliberately about the SHAPE of the composition rather than
// about which families are in it. A test pinning today's occupants would have to
// be edited by every branch that adds a seat, which makes it a second seat board
// and reintroduces exactly the conflict the first one exists to avoid.

import { describe, expect, it } from "vitest";

import { registerConsoleFamilies } from "./families.js";
import { CONSOLE_SURFACE_SLOTS, ConsoleSurfaceRegistry } from "./frame/surface-registry.js";
import { ConsolePaneRegistry, consolePaneRegistry } from "./workspace/index.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

// The seat board's own text, inlined at transform time through Vite's raw glob —
// `node:fs` is banned in renderer programs, and this is the form `panes/panes.test.ts`
// established for the sibling seat board's source reads.
const seatBoardSources = import.meta.glob("./families.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The composition root's own source. One entry, keyed by the glob's resolved path. */
const seatBoardSource: string = Object.values(seatBoardSources).join("");

/** A registry pair a case owns outright, so nothing it composes reaches production. */
function ownedRegistries(): {
  readonly surfaces: ConsoleSurfaceRegistry;
  readonly panes: ConsolePaneRegistry;
} {
  return { surfaces: new ConsoleSurfaceRegistry(), panes: new ConsolePaneRegistry() };
}

describe("console families — composing every shipped family", () => {
  it("claims no slot twice", () => {
    // The registry throws `DuplicateRegistrationError` naming the slot when two
    // owners claim one, so "does not throw" is a real assertion here rather than
    // the absence of one: the raise is the mechanism being checked.
    const { surfaces, panes } = ownedRegistries();
    expect(() => {
      registerConsoleFamilies(surfaces, panes);
    }).not.toThrow();
  });

  it("claims at least one slot, and only declared ones", () => {
    const { surfaces, panes } = ownedRegistries();
    registerConsoleFamilies(surfaces, panes);
    const slots = surfaces.registeredSlots();
    // Non-empty, or "only declared ones" below is a claim about nothing and the
    // case passes over a composition root that silently registered no family.
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(CONSOLE_SURFACE_SLOTS).toContain(slot);
    }
  });

  it("composes into a registry the caller owns, not a singleton", () => {
    // The seat signature takes a registry so a test can compose into its own and
    // an auxiliary window can compose a subset. A registrar that reached for the
    // module-scope singleton would leave this one empty while still "working".
    const first = ownedRegistries();
    const second = ownedRegistries();
    registerConsoleFamilies(first.surfaces, first.panes);
    expect(second.surfaces.registeredSlots()).toStrictEqual([]);
    registerConsoleFamilies(second.surfaces, second.panes);
    expect(second.surfaces.registeredSlots()).toStrictEqual(first.surfaces.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    // Same owners re-claiming the same slots: the owner-scoped policy replaces.
    // A family that changed its owner string between composes would raise here,
    // which is the correct answer — the owner is what the policy is about.
    const { surfaces, panes } = ownedRegistries();
    registerConsoleFamilies(surfaces, panes);
    const afterFirst = surfaces.registeredSlots();
    registerConsoleFamilies(surfaces, panes);
    expect(surfaces.registeredSlots()).toStrictEqual(afterFirst);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Every case above reads `registeredSlots`, and all of them would pass over a
    // registry that reported slots nobody registered.
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
  });
});

describe("console families — the pane board a composition writes into", () => {
  // The seat board takes a SURFACE registry and used to reach for the module-scope
  // PANE registry, so a caller composing its own family set still wrote panes into
  // the production deck. That is inert only while every pane seat is reserved: the
  // day the first family registers a body, an independent composition mutates the
  // running console, registrations leak between compositions, and an auxiliary
  // window cannot select a subset however it asks. These cases are about the seam
  // rather than about today's empty board, because today's empty board is exactly
  // what makes a behavioural assertion alone pass over the defect.

  it("takes both registries, so a composition names the deck it writes into", () => {
    // Arity, asserted directly. Under the old signature this reads 1 and there is
    // no pane registry a caller could pass, which is the defect in one number.
    expect(registerConsoleFamilies).toHaveLength(2);
  });

  it("forwards the pane registry it was handed and reaches for no singleton", () => {
    // The claim that survives the board filling up. A behavioural check cannot make
    // it today — the seats are reserved, so composing registers nothing either way —
    // so it is read off the composition's own source, on the precedent
    // `panes/panes.test.ts` sets for the sibling board.
    expect(Object.keys(seatBoardSources)).toHaveLength(1);
    expect(seatBoardSource).toContain("registerConsolePanes(paneRegistry)");
    // The singleton is not merely unused here — it is unreachable, because the
    // module does not import it. A value import would be a default waiting to be
    // reintroduced.
    expect(seatBoardSource).not.toContain("registerConsolePanes(consolePaneRegistry)");
    expect(seatBoardSource).toContain('import type { ConsolePaneRegistry } from "./workspace');
  });

  it("leaves the production deck untouched when a caller composes its own", () => {
    // The behavioural half, and the probe is what keeps it from being vacuous: the
    // caller's registry really does record a body, and the singleton really is
    // asked about that same kind, so the instrument is shown to work on the one
    // registry a composition is allowed to write into.
    const { surfaces, panes } = ownedRegistries();
    panes.register({ kind: "terminal", owner: "families.test", render: () => null });

    registerConsoleFamilies(surfaces, panes);

    expect(panes.registeredPaneKinds()).toContain("terminal");
    expect(consolePaneRegistry.registeredPaneKinds()).not.toContain("terminal");
  });
});
