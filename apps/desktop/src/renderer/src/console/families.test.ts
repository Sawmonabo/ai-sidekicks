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
import { ConsoleEntityProjectorRegistry, consoleEntityProjectorRegistry } from "./store/index.js";
import { ConsolePaneRegistry, consolePaneRegistry } from "./seats/index.js";

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

/** The three boards a case owns outright, so nothing it composes reaches production. */
function ownedRegistries(): {
  readonly surfaces: ConsoleSurfaceRegistry;
  readonly panes: ConsolePaneRegistry;
  readonly projectors: ConsoleEntityProjectorRegistry;
} {
  return {
    surfaces: new ConsoleSurfaceRegistry(),
    panes: new ConsolePaneRegistry(),
    projectors: new ConsoleEntityProjectorRegistry(),
  };
}

describe("console families — composing every shipped family", () => {
  it("claims no slot twice", () => {
    // The registry throws `DuplicateRegistrationError` naming the slot when two
    // owners claim one, so "does not throw" is a real assertion here rather than
    // the absence of one: the raise is the mechanism being checked.
    const { surfaces, panes, projectors } = ownedRegistries();
    expect(() => {
      registerConsoleFamilies(surfaces, panes, projectors);
    }).not.toThrow();
  });

  it("claims at least one slot, and only declared ones", () => {
    const { surfaces, panes, projectors } = ownedRegistries();
    registerConsoleFamilies(surfaces, panes, projectors);
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
    registerConsoleFamilies(first.surfaces, first.panes, first.projectors);
    expect(second.surfaces.registeredSlots()).toStrictEqual([]);
    registerConsoleFamilies(second.surfaces, second.panes, second.projectors);
    expect(second.surfaces.registeredSlots()).toStrictEqual(first.surfaces.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    // Same owners re-claiming the same slots: the owner-scoped policy replaces.
    // A family that changed its owner string between composes would raise here,
    // which is the correct answer — the owner is what the policy is about.
    const { surfaces, panes, projectors } = ownedRegistries();
    registerConsoleFamilies(surfaces, panes, projectors);
    const afterFirst = surfaces.registeredSlots();
    registerConsoleFamilies(surfaces, panes, projectors);
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

  it("takes all three registries, so a composition names every board it writes into", () => {
    // Arity, asserted directly. Under the first signature this reads 1 and there was
    // no pane registry a caller could pass; under the second it reads 2 and the fold
    // a store opens with was a constant no family could add to. Each defect is one
    // number.
    expect(registerConsoleFamilies).toHaveLength(3);
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
    expect(seatBoardSource).toContain('import type { ConsolePaneRegistry } from "./seats');
  });

  it("forwards the projector board it was handed and reaches for no singleton", () => {
    // The seam that makes a family able to project its own event category at all.
    // Read behaviourally rather than off the source, because unlike the pane board
    // this one has a producer today: the frame claims the run-lifecycle kinds
    // through the composition, so a registrar reaching for the module-scope board
    // would leave the caller's empty while still "working".
    const { surfaces, panes, projectors } = ownedRegistries();

    registerConsoleFamilies(surfaces, panes, projectors);

    expect(Object.keys(projectors.snapshot()).length).toBeGreaterThan(0);
    expect(projectors.ownerOf("run.running")).toBe("frame");
  });

  it("negative control: a board no composition wrote into stays empty", () => {
    // Without it the case above would pass over a board that reported claims nobody
    // registered — which is how a snapshot assertion goes vacuous.
    expect(new ConsoleEntityProjectorRegistry().snapshot()).toStrictEqual({});
  });

  it("leaves the production boards untouched when a caller composes its own", () => {
    // The behavioural half, and the probe is what keeps it from being vacuous: the
    // caller's registry really does record a body, and the singleton really is
    // asked about that same kind, so the instrument is shown to work on the one
    // registry a composition is allowed to write into.
    //
    // The probe claims a kind still RESERVED on the seat board, for the reason the
    // registry refuses a second owner: a kind a shipped family claims would be
    // claimed twice by the composition below and throw before the assertion. It is
    // the sibling board's own probe kind (`panes/panes.test.ts`), so the two move
    // together the day the family that owns it lands.
    const { surfaces, panes, projectors } = ownedRegistries();
    panes.register({ kind: "timeline", owner: "families.test", render: () => null });

    registerConsoleFamilies(surfaces, panes, projectors);

    expect(panes.registeredPaneKinds()).toContain("timeline");
    expect(consolePaneRegistry.registeredPaneKinds()).not.toContain("timeline");
    // Same claim for the projector board, and it needs no probe: the frame's own
    // registration is the body, so a composition writing into the singleton would
    // show up here as a production board that has been claimed by this test's run.
    expect(projectors.ownerOf("run.running")).toBe("frame");
    expect(consoleEntityProjectorRegistry.ownerOf("run.running")).toBeUndefined();
  });
});
