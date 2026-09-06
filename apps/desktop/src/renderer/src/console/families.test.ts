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
import { ConsoleEntityProjectorRegistry, consoleEntityProjectorRegistry } from "./store/index.js";
import {
  ConsolePaneRegistry,
  consolePaneRegistry,
  ConsoleSurfaceRegistry,
  consoleSurfaceRegistry,
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
    // The claim that survives the board filling up, read off the composition's own
    // source on the precedent `panes/panes.test.ts` sets for the sibling board. It
    // used to say a behavioural check could not make it because composing registered
    // nothing either way, which stopped being true the moment `registerConsolePanes`
    // claimed its first kinds — the case at the foot of this file makes exactly that
    // check now, and this one is what a behavioural check cannot say: that the
    // singleton is unreachable from the module rather than merely unused by it, and
    // that the board takes its registry as a TYPE from the seats door.
    expect(Object.keys(seatBoardSources)).toHaveLength(1);
    expect(seatBoardSource).toContain("registerConsolePanes(paneRegistry)");
    // The singleton is not merely unused here — it is unreachable, because the
    // module does not import it. A value import would be a default waiting to be
    // reintroduced.
    expect(seatBoardSource).not.toContain("registerConsolePanes(consolePaneRegistry)");
    // The whole statement, so what is asserted is that the board takes the pane
    // registry as a TYPE from the seats door — `import type` and the door together.
    // The surface registry rides the same statement because it comes from the same
    // door, having moved there from `frame/` with the rest of that seat.
    expect(seatBoardSource).toContain(
      'import type { ConsolePaneRegistry, ConsoleSurfaceRegistry } from "./seats/index.js";',
    );
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
    const { surfaces, panes, projectors } = ownedRegistries();

    registerConsoleFamilies(surfaces, panes, projectors);
    registerFreePaneKindProbe(panes, "families.test");

    expect(panes.registeredPaneKinds().length).toBeGreaterThan(0);
    expect(projectors.ownerOf("run.running")).toBe("frame");

    // THE DISCRIMINATING ASSERTION, AND THE ONE THE PROBE CANNOT MAKE. A probe put
    // straight into the owned board never travels through the composition, so a
    // composition that wrote into the production boards instead would leave the
    // owned ones holding the probe alone — non-empty, and disjoint from a singleton
    // holding the landed families' claims, which is to say green over the leak. What
    // names it is the production boards being EXACTLY empty once a caller has
    // composed its own: no console module registers into them at import time, by the
    // seat board's own contract, so anything in one after this line arrived through
    // a composition that ignored what it was handed.
    expect(consolePaneRegistry.registeredPaneKinds()).toStrictEqual([]);
    expect(consoleSurfaceRegistry.registeredSlots()).toStrictEqual([]);
    expect(consoleEntityProjectorRegistry.snapshot()).toStrictEqual({});
  });
});

/**
 * Every seat at the foot of the composition, as the task each names.
 *
 * The list a branch replaces one line of, read off the board's own source: nothing in
 * the compiler counts them, so the header's count was kept in step by hand until this
 * case.
 *
 * BOTH STATES OF A SEAT MATCH, which is what makes the count stable as families land.
 * A seat is the task marker, whether it stands alone as the reserved comment or rides
 * the registration that replaced it — the shape `panes/index.ts` already uses. Reading
 * only the reserved form would count seats DOWN as the board fills, so the first
 * family to land would have had to edit the header it was supposed to be held to.
 */
const SEAT_LINE = /^\s*(?:\/\/|[^\n]*;\s*\/\/) T-023p-1C-\d+ [a-z-]+(?: [a-z-]+)*$/gmu;

/**
 * Spelled cardinals, indexed by the number each spells.
 *
 * Spelled rather than numeric because that is how the header writes a count, and
 * the header is what this compares against.
 */
const SPELLED_CARDINALS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** The board's header: everything above the first import, which is its whole prose. */
function seatBoardHeader(): string {
  const firstImport = seatBoardSource.indexOf("\nimport ");
  return firstImport === -1 ? seatBoardSource : seatBoardSource.slice(0, firstImport);
}

/**
 * Every spelled cardinal in a header that names a number other than the seat count.
 *
 * The one home for the rule, read by the claim below and by its control, so a change
 * to what counts as a stray moves both. Values below two are not strays: "one" and
 * "zero" are ordinary English in prose about a single seat or an empty board, and
 * neither reads as a count of families. The seat count's own spelling is not a stray
 * either — repeating it names the same number, which is what the header is for; what
 * the defect looked like was a SECOND, DIFFERENT number standing beside it.
 */
function straySpelledCardinals(header: string, seatCount: number): readonly string[] {
  return SPELLED_CARDINALS.filter(
    (word, value) =>
      value > 1 && value !== seatCount && new RegExp(`\\b${word}\\b`, "iu").test(header),
  );
}

describe("console families — the header states the seat count, once", () => {
  it("spells the number of reserved seats and no other number", () => {
    // The defect this replaces: the header opened with "Seven surface families" and
    // three lines later said six branches produce six diffs at six positions, while
    // seven seats stood below — 1C-8 read as an audit task when it lands a family of
    // its own. Nothing reported the disagreement, because a count in prose is a claim
    // no compiler holds.
    //
    // So the rule is one count in one place, and this is what makes it one: the seat
    // count is DERIVED by counting the lines — reserved and filled alike — the header
    // has to spell that number, and any cardinal in the header naming a DIFFERENT
    // number is an offence.
    const seatCount = [...seatBoardSource.matchAll(SEAT_LINE)].length;
    expect(seatCount).toBe(7);
    const header = seatBoardHeader();
    const spelled = SPELLED_CARDINALS[seatCount];
    expect(header.toLowerCase()).toContain(`${spelled ?? "?"} surface families`);
    expect(straySpelledCardinals(header, seatCount)).toStrictEqual([]);
  });

  it("negative control: a header spelling a second, different count is an offence", () => {
    // Without this the clean result above could come from a predicate that reports
    // nothing at all. It plants the shape the defect actually took — a header opening
    // on one number and naming another three lines down — and drives the SHIPPED
    // predicate the claim above evaluates, so emptying that predicate reddens this
    // case rather than leaving it green over a hand-copied rule.
    //
    // The other direction is planted too, and it is deliberately NOT an offence: the
    // seat count spelled twice is still one number, and a rule that reported it would
    // forbid a header from using its own count in a sentence.
    //
    // The number here is the one the PLANTED headers spell, not a second copy of the
    // board's: the last assertion is the one that reads the real header, and it takes
    // the same derived count the claim above does.
    const plantedSeatCount = 7;
    expect(
      straySpelledCardinals(
        "// Seven surface families, and six branches that build them.",
        plantedSeatCount,
      ),
    ).toStrictEqual(["six"]);
    expect(
      straySpelledCardinals(
        "// Seven surface families. Seven branches, seven diffs.",
        plantedSeatCount,
      ),
    ).toStrictEqual([]);
    expect(
      straySpelledCardinals(seatBoardHeader(), [...seatBoardSource.matchAll(SEAT_LINE)].length),
    ).toStrictEqual([]);
  });
});
