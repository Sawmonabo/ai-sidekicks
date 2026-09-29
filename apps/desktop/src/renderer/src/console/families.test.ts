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
import { RUN_LIFECYCLE_PROJECTOR_OWNER } from "@renderer/store/session-events/run-lifecycle-projector.js";
import {
  ConsoleEntityProjectorRegistry,
  consoleEntityProjectorRegistry,
} from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import {
  ConsolePaneRegistry,
  consolePaneRegistry,
  ConsoleSurfaceRegistry,
  consoleSurfaceRegistry,
  InlineCardSeatRegistry,
  inlineCardSeatRegistry,
} from "./seats/index.js";
// The pane probe by its own specifier, for the reason below it: a door cannot
// publish a fixture helper, because the barrel census fails a door line no
// production module reads.
import { registerFreePaneKindProbe } from "@renderer/registries/panes/pane-probe.test-support.js";
// The slot tuple by its own specifier: the seats door does not publish it, because
// this suite is its only reader and a door line no production module reaches is one
// the barrel census fails.
import { CONSOLE_SURFACE_SLOTS } from "@renderer/registries/screens/screen-registry.js";

/** The four boards a case owns outright, so nothing it composes reaches production. */
function ownedRegistries(): {
  readonly surfaces: ConsoleSurfaceRegistry;
  readonly panes: ConsolePaneRegistry;
  readonly projectors: ConsoleEntityProjectorRegistry;
  readonly inlineCards: InlineCardSeatRegistry;
} {
  return {
    surfaces: new ConsoleSurfaceRegistry(),
    panes: new ConsolePaneRegistry(),
    projectors: new ConsoleEntityProjectorRegistry(),
    inlineCards: new InlineCardSeatRegistry(),
  };
}

/** Compose into boards the case owns, naming every one of them at the call. */
function composeInto(boards: ReturnType<typeof ownedRegistries>): void {
  registerConsoleFamilies(boards.surfaces, boards.panes, boards.projectors, boards.inlineCards);
}

/** Every board the process shares, as the pairs an emptiness claim names. */
const PRODUCTION_BOARDS: readonly (readonly [string, () => readonly unknown[]])[] = [
  ["surfaces", () => consoleSurfaceRegistry.registeredSlots()],
  ["panes", () => consolePaneRegistry.registeredPaneKinds()],
  ["projectors", () => Object.keys(consoleEntityProjectorRegistry.snapshot())],
  ["inline cards", () => inlineCardSeatRegistry.registeredCardKinds()],
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
  // what makes a behavioral assertion alone pass over the defect.

  it("forwards the projector board it was handed and reaches for no singleton", () => {
    // The seam that makes a family able to project its own event category at all.
    // Unlike the pane board, this one has a producer today: the frame claims the
    // run-lifecycle kinds through the composition, so a registrar reaching for the
    // module-scope board would leave the caller's empty while still "working".
    const boards = ownedRegistries();

    composeInto(boards);

    expect(Object.keys(boards.projectors.snapshot()).length).toBeGreaterThan(0);
    expect(boards.projectors.ownerOf("run.running")).toBe(RUN_LIFECYCLE_PROJECTOR_OWNER);
  });

  it("negative control: a board no composition wrote into stays empty", () => {
    // Without it the case above would pass over a board that reported claims nobody
    // registered — which is how a snapshot assertion goes vacuous.
    expect(new ConsoleEntityProjectorRegistry().snapshot()).toStrictEqual({});
  });

  it("leaves the production boards untouched when a caller composes its own", () => {
    // The probe is what keeps this from being vacuous: the caller's registry really
    // does record a body, and the singleton really is asked about the kinds it
    // holds, so the instrument is shown to work on the one registry a composition
    // is allowed to write into.
    //
    // THE PROBE RUNS AFTER THE COMPOSITION AND NAMES NO KIND. It used to claim a
    // kind still reserved on the pane seat board, spelled here — which the registry
    // turns into a throw the day the family that owns that kind lands, because it
    // refuses a second owner rather than letting import order decide. The pane-kind
    // set is closed at eleven members and six view families are landing at once, so
    // there is no kind a landed board leaves unclaimed to spell. The kind is
    // derived from what this composition left free instead, and where it left
    // nothing free the composition's own registrations ARE the probe — the arm
    // `seats/pane/pane-probe.test-support.test.ts` proves. Either way this file names no
    // family, no kind, and no seat, so every branch carries it unchanged.
    const boards = ownedRegistries();

    composeInto(boards);
    registerFreePaneKindProbe(boards.panes, "families.test");

    expect(boards.panes.registeredPaneKinds().length).toBeGreaterThan(0);
    expect(boards.projectors.ownerOf("run.running")).toBe(RUN_LIFECYCLE_PROJECTOR_OWNER);

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
    // Every board, derived from the list rather than spelled here, because the boards no
    // family fills yet are the ones a leak would reach FIRST — their module-scope
    // registrars still exist, so they are the boards a landing family is most likely
    // to write into without passing through this composition at all.
    for (const [board, readClaims] of PRODUCTION_BOARDS) {
      expect({ board, claims: readClaims() }).toStrictEqual({ board, claims: [] });
    }
  });
});
