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
//
// This file is about what the composition DOES. What its SOURCE says — the seat
// block's grammar and the header's count — is `families.seat-board.test.ts`, which
// reads the same board with a different instrument.

import { describe, expect, it } from "vitest";

import { registerConsoleFamilies } from "./families.js";
import { ConsoleEntityProjectorRegistry, consoleEntityProjectorRegistry } from "./store/index.js";
// The registry's own refusal, from the module that declares it: the core door
// deliberately publishes no line for it, because a family consumes it by calling
// `register` rather than by naming the class.
import { DuplicateRegistrationError } from "./core/keyed-registry.js";
import {
  FRAME_BINDING_SLOTS,
  mountFrameBindings,
  type FrameBindingContext,
  type FrameBindingSlot,
} from "./seats/frame-bindings.js";
import {
  ConsolePaneRegistry,
  consolePaneRegistry,
  ConsoleSurfaceRegistry,
  consoleSurfaceRegistry,
  FrameBindingRegistry,
  frameBindingRegistry,
  InlineCardSeatRegistry,
  inlineCardSeatRegistry,
  SidebarSectionRegistry,
  sidebarSectionRegistry,
} from "./seats/index.js";
// The pane probe by its own specifier, for the reason below it: a door cannot
// publish a fixture helper, because the barrel census fails a door line no
// production module reads.
import { registerFreePaneKindProbe } from "./seats/pane-probe.test-support.js";
// The slot tuple by its own specifier: the seats door does not publish it, because
// this suite is its only reader and a door line no production module reaches is one
// the barrel census fails.
import { CONSOLE_SURFACE_SLOTS } from "./seats/surface-registry.js";

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

/** The six boards a case owns outright, so nothing it composes reaches production. */
function ownedRegistries(): {
  readonly surfaces: ConsoleSurfaceRegistry;
  readonly panes: ConsolePaneRegistry;
  readonly projectors: ConsoleEntityProjectorRegistry;
  readonly sidebar: SidebarSectionRegistry;
  readonly inlineCards: InlineCardSeatRegistry;
  readonly frameBindings: FrameBindingRegistry;
} {
  return {
    surfaces: new ConsoleSurfaceRegistry(),
    panes: new ConsolePaneRegistry(),
    projectors: new ConsoleEntityProjectorRegistry(),
    sidebar: new SidebarSectionRegistry(),
    inlineCards: new InlineCardSeatRegistry(),
    frameBindings: new FrameBindingRegistry(),
  };
}

/** Compose into boards the case owns, naming every one of them at the call. */
function composeInto(boards: ReturnType<typeof ownedRegistries>): void {
  registerConsoleFamilies(
    boards.surfaces,
    boards.panes,
    boards.projectors,
    boards.sidebar,
    boards.inlineCards,
    boards.frameBindings,
  );
}

/** Every board the process shares, as the pairs an emptiness claim names. */
const PRODUCTION_BOARDS: readonly (readonly [string, () => readonly unknown[]])[] = [
  ["surfaces", () => consoleSurfaceRegistry.registeredSlots()],
  ["panes", () => consolePaneRegistry.registeredPaneKinds()],
  ["projectors", () => Object.keys(consoleEntityProjectorRegistry.snapshot())],
  ["sidebar sections", () => sidebarSectionRegistry.registeredSectionIds()],
  ["inline cards", () => inlineCardSeatRegistry.registeredCardKinds()],
  ["frame bindings", () => frameBindingRegistry.registeredSlots()],
];

describe("console families — composing every shipped family", () => {
  it("claims no slot twice", () => {
    // The registry throws `DuplicateRegistrationError` naming the slot when two
    // owners claim one, so "does not throw" is a real assertion here rather than
    // the absence of one: the raise is the mechanism being checked.
    const boards = ownedRegistries();
    expect(() => {
      composeInto(boards);
    }).not.toThrow();
  });

  it("claims at least one slot, and only declared ones", () => {
    const boards = ownedRegistries();
    composeInto(boards);
    const slots = boards.surfaces.registeredSlots();
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
    composeInto(first);
    expect(second.surfaces.registeredSlots()).toStrictEqual([]);
    composeInto(second);
    expect(second.surfaces.registeredSlots()).toStrictEqual(first.surfaces.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    // Same owners re-claiming the same slots: the owner-scoped policy replaces.
    // A family that changed its owner string between composes would raise here,
    // which is the correct answer — the owner is what the policy is about.
    const boards = ownedRegistries();
    composeInto(boards);
    const afterFirst = boards.surfaces.registeredSlots();
    composeInto(boards);
    expect(boards.surfaces.registeredSlots()).toStrictEqual(afterFirst);
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

  it("takes all six boards, so a composition names every board it writes into", () => {
    // Arity, asserted directly. Under the first signature this reads 1 and there was
    // no pane registry a caller could pass; under the second it reads 2 and the fold
    // a store opens with was a constant no family could add to; under the third it
    // reads 3 and a family filling a sidebar section or an inline card had nowhere to
    // be handed one, so it would have reached for that board's module-scope
    // registrar and written into production from inside a composition. Under the
    // fifth, every seat a family could claim was a place to hand over a BODY, so a
    // read the frame renders had to be mounted by whichever destination happened to
    // perform it and ended when a person navigated away from that destination. Each
    // defect is one number.
    expect(registerConsoleFamilies).toHaveLength(6);
  });

  it("forwards the pane registry it was handed and reaches for no singleton", () => {
    // The claim that survives the board filling up, read off the composition's own
    // source on the precedent `panes/panes.test.ts` sets for the sibling board. It
    // used to say a behavioural check could not make it because composing registered
    // nothing either way, which stops being true the moment `registerConsolePanes`
    // claims its first kinds — the case at the foot of this file makes exactly that
    // check, on whatever the board holds — and this one is what a behavioural check
    // cannot say: that the singleton is unreachable from the module rather than
    // merely unused by it, and that the board takes its registry as a TYPE from the
    // seats door.
    expect(Object.keys(seatBoardSources)).toHaveLength(1);
    expect(seatBoardSource).toContain("registerConsolePanes(panes)");
    // Unreachable rather than unused, and stated over EVERY board rather than the
    // one that has a forwarding call today: the two boards no family fills yet have
    // no call to assert, so naming their singletons is the only claim available —
    // and it is the claim that matters, because a value import is a default waiting
    // to be reintroduced.
    for (const singleton of [
      "consoleSurfaceRegistry",
      "consolePaneRegistry",
      "consoleEntityProjectorRegistry",
      "sidebarSectionRegistry",
      "inlineCardSeatRegistry",
      "frameBindingRegistry",
    ]) {
      expect({ singleton, named: seatBoardSource.includes(singleton) }).toStrictEqual({
        singleton,
        named: false,
      });
    }
    // The whole statement, so what is asserted is that the board takes its registries
    // as TYPES from the seats door — `import type` and the door together.
    expect(seatBoardSource).toContain('} from "./seats/index.js";');
    expect(seatBoardSource).toContain("import type {");
  });

  it("forwards the projector board it was handed and reaches for no singleton", () => {
    // The seam that makes a family able to project its own event category at all.
    // Read behaviourally rather than off the source, because unlike the pane board
    // this one has a producer today: the frame claims the run-lifecycle kinds
    // through the composition, so a registrar reaching for the module-scope board
    // would leave the caller's empty while still "working".
    const boards = ownedRegistries();

    composeInto(boards);

    expect(Object.keys(boards.projectors.snapshot()).length).toBeGreaterThan(0);
    expect(boards.projectors.ownerOf("run.running")).toBe("frame");
  });

  it("negative control: a board no composition wrote into stays empty", () => {
    // Without it the case above would pass over a board that reported claims nobody
    // registered — which is how a snapshot assertion goes vacuous.
    expect(new ConsoleEntityProjectorRegistry().snapshot()).toStrictEqual({});
  });

  it("leaves the production boards untouched when a caller composes its own", () => {
    // The behavioural half, and the probe is what keeps it from being vacuous: the
    // caller's registry really does record a body, and the singleton really is
    // asked about the kinds it holds, so the instrument is shown to work on the one
    // registry a composition is allowed to write into.
    //
    // THE PROBE RUNS AFTER THE COMPOSITION AND NAMES NO KIND. It used to claim a
    // kind still reserved on the pane seat board, spelled here — which the registry
    // turns into a throw the day the family that owns that kind lands, because it
    // refuses a second owner rather than letting import order decide. The pane-kind
    // set is closed at eleven members and six view families are landing at once, so
    // there is no kind a landed board leaves unclaimed to spell. The kind is
    // derived from what this composition left free instead, and where it left
    // nothing free the composition's own registrations ARE the probe — the arm
    // `seats/pane-probe.test-support.test.ts` proves. Either way this file names no
    // family, no kind, and no seat, so every branch carries it unchanged.
    const boards = ownedRegistries();

    composeInto(boards);
    registerFreePaneKindProbe(boards.panes, "families.test");

    expect(boards.panes.registeredPaneKinds().length).toBeGreaterThan(0);
    expect(boards.projectors.ownerOf("run.running")).toBe("frame");

    // THE DISCRIMINATING ASSERTION, AND THE ONE THE PROBE CANNOT MAKE. A probe put
    // straight into the owned board never travels through the composition, so a
    // composition that wrote into the production boards instead would leave the
    // owned ones holding the probe alone — non-empty, and disjoint from a singleton
    // holding the landed families' claims, which is to say green over the leak. What
    // names it is EVERY production board being EXACTLY empty once a caller has
    // composed its own: no console module registers into one at import time, by the
    // seat board's own contract, so anything in one after this line arrived through
    // a composition that ignored what it was handed.
    //
    // All five, derived from the list rather than spelled here, because the two that
    // no family fills yet are the two a leak would reach FIRST — their module-scope
    // registrars still exist, so they are the boards a landing family is most likely
    // to write into without passing through this composition at all.
    for (const [board, readClaims] of PRODUCTION_BOARDS) {
      expect({ board, claims: readClaims() }).toStrictEqual({ board, claims: [] });
    }
  });
});

describe("console families — the frame-lifetime binding board", () => {
  // The board that is not a place to hand over a body. Its seats are mounted once per
  // window by the frame rather than by a route, so what is asserted here is the two
  // halves nothing else can: that composing fills it, and that the fold the frame
  // performs over it really does put a family's element around the frame's subtree.

  it("is filled by the composition, and only with declared slots", () => {
    const boards = ownedRegistries();

    composeInto(boards);

    const slots = boards.frameBindings.registeredSlots();
    // Non-empty, or the membership claim below is a claim about nothing and this case
    // passes over a composition that silently registered no binding at all.
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(FRAME_BINDING_SLOTS).toContain(slot);
    }
  });

  it("wraps the frame's subtree in what a family registered — the planted control", () => {
    // The instrument, driven over a board this case fills itself. A planted binding is
    // the only way to assert the WRAPPING without mounting React: what the fold returns
    // for a registered slot has to be the family's own node holding the children, and a
    // fold that silently dropped either would look identical from the composition side.
    const registry = new FrameBindingRegistry();
    const wrapped: unknown[] = [];
    registry.register({
      slot: PLANTED_BINDING_SLOT,
      owner: "families.test",
      mount: (bindingProps) => {
        wrapped.push(bindingProps.children);
        return PLANTED_BINDING_NODE;
      },
    });

    expect(mountFrameBindings(registry, PLANTED_BINDING_CONTEXT, "the frame")).toBe(
      PLANTED_BINDING_NODE,
    );
    expect(wrapped).toStrictEqual(["the frame"]);
  });

  it("negative control: an unfilled board hands the frame back untouched", () => {
    // The other half, and the reason the case above is not vacuous. A seat nothing
    // claimed contributes no element at all — reserved-not-stubbed, the same answer
    // every other board gives — so a fold that wrapped regardless would put a mount and
    // a reconciliation node in the tree standing for a family that has not landed.
    expect(
      mountFrameBindings(new FrameBindingRegistry(), PLANTED_BINDING_CONTEXT, "the frame"),
    ).toBe("the frame");
  });

  it("negative control: a second owner claiming one binding is a conflict", () => {
    // A binding is mounted once per window, so a second owner on one slot would mean
    // two reads of one thing and which one ran would depend on module import order.
    const registry = new FrameBindingRegistry();
    const claim = (owner: string): void => {
      registry.register({ slot: PLANTED_BINDING_SLOT, owner, mount: () => PLANTED_BINDING_NODE });
    };

    claim("first");

    expect(() => {
      claim("first");
    }).not.toThrow();
    expect(() => {
      claim("second");
    }).toThrow(DuplicateRegistrationError);
  });
});

/** The slot the planted cases claim: a real member, on a board the case owns. */
const PLANTED_BINDING_SLOT: FrameBindingSlot = FRAME_BINDING_SLOTS[0];

/** What a planted binding returns, so the fold's result is identifiable by identity. */
const PLANTED_BINDING_NODE = "the planted binding";

/**
 * What a planted binding is handed.
 *
 * Cast rather than constructed, on `sessions/session-surface.test-support.tsx`' rule:
 * the three real members are a bridge, a frame store, and a session-store registry, and
 * building all three to prove that a fold passes an object through would make the setup
 * the subject.
 */
const PLANTED_BINDING_CONTEXT = {} as unknown as FrameBindingContext;
