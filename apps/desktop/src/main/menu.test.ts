// Plan-023 Phase 1B (T-023p-1B-2) — the application menu.
//
// Two properties are asserted here.
//
// The first is the one Phase 1C depends on: the `Window` submenu's auxiliary
// entries are derived from the SHARED BARE-LAUNCHABLE ROUTE LIST and never from
// the route type nor from the wider implemented set, so a build whose bare
// launch can reach no subject offers no command that opens a window which can
// never be given one. Both lists are stubbed per case so the empty and the
// populated shapes are reachable and so the two can be driven APART — a route in
// one and not the other must not leak into the menu, which is the whole reason
// they are two lists. One case cross-asserts the menu against the shared closed
// set, and one asserts the REAL shipped lists, which is the build's own claim.
//
// The second is the `registerMenuSection` seam Plan-026 T7.3 consumes. A seam
// that is promised in a plan and not exported is a promise its consumer cannot
// keep, so these cases drive registration through the same public function that
// plan will call.
//
// Two things are asserted together on every auxiliary arm, because either alone
// is satisfiable by a wrong implementation: which entries the submenu carries,
// AND that the submenu still carries its platform window roles. A build that
// dropped the whole submenu to hide two entries would pass "no Timeline entry"
// while taking Minimize and Close off the menu bar with it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock, type MenuTemplateItem } from "../../test/helpers/electron-mock.js";
import { AUXILIARY_ROUTE_LABELS, AUXILIARY_ROUTE_NAMES } from "../shared/auxiliary-routes.js";

const routeListsMock = vi.hoisted(() => {
  const implementedRoutes: string[] = [];
  const bareLaunchableRoutes: string[] = [];
  return {
    implementedRoutes,
    bareLaunchableRoutes,
    reset(): void {
      implementedRoutes.length = 0;
      bareLaunchableRoutes.length = 0;
    },
  };
});

// Only the two route LISTS are stubbed, and they are stubbed as two independent
// arrays rather than one aliased twice — an alias would make every case that
// publishes a bare-launchable route silently publish an implemented one, which
// is the coupling under test. The labels and the closed route set come from the
// real module, so the fixture supplies WHICH routes this build offers and never
// what they are called: a menu asserted against a local copy of the labels would
// agree with a typo in either.
vi.mock("../shared/auxiliary-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/auxiliary-routes.js")>();
  return {
    ...actual,
    IMPLEMENTED_AUXILIARY_ROUTES: routeListsMock.implementedRoutes,
    BARE_LAUNCHABLE_AUXILIARY_ROUTES: routeListsMock.bareLaunchableRoutes,
  };
});

// The one shared `electron` mock (`test/helpers/electron-mock.ts`). No
// `recordOrder`: this suite asserts the SHAPE of a built template, and the
// click path is asserted as wiring (a window was constructed, at that route's
// geometry) rather than as a sequence.
const electronMock = createElectronMock({});

vi.mock("electron", () => electronMock.moduleExports);

// The geometry the agent-console route opens at, restated from `window.ts`'s
// module-private `AUXILIARY_WINDOW_GEOMETRY` for the reason `window.test.ts`
// gives at its own copy: a test that imported the record would agree with a typo
// in it.
const AGENT_CONSOLE_GEOMETRY = { width: 980, height: 720 } as const;

type MenuModule = typeof import("./menu.js");

/** Re-imports `menu.ts` so each case starts with no registered section. */
async function loadMenuModule(): Promise<MenuModule> {
  vi.resetModules();
  return import("./menu.js");
}

/** Publishes routes into BOTH lists — the ordinary "this route fully ships" case. */
function publishLaunchableRoutes(...routes: readonly string[]): void {
  routeListsMock.reset();
  routeListsMock.implementedRoutes.push(...routes);
  routeListsMock.bareLaunchableRoutes.push(...routes);
}

/** Publishes routes into the implemented list ONLY — a body with no reachable read. */
function publishImplementedOnlyRoutes(...routes: readonly string[]): void {
  routeListsMock.reset();
  routeListsMock.implementedRoutes.push(...routes);
}

function latestTemplate(): MenuTemplateItem[] {
  const template = electronMock.installedMenuTemplates.at(-1);
  expect(template).toBeDefined();
  return template ?? [];
}

function latestWindowSubmenu(): MenuTemplateItem[] {
  const windowMenu = latestTemplate().find((item) => item.label === "Window");
  expect(windowMenu).toBeDefined();
  return windowMenu?.submenu ?? [];
}

function labelsOf(submenu: readonly MenuTemplateItem[]): string[] {
  return submenu.flatMap((item) => (item.label === undefined ? [] : [item.label]));
}

function rolesOf(submenu: readonly MenuTemplateItem[]): string[] {
  return submenu.flatMap((item) => (item.role === undefined ? [] : [item.role]));
}

describe("the application menu", () => {
  beforeEach(() => {
    electronMock.reset();
    routeListsMock.reset();
  });

  it("offers no auxiliary entry when no route is bare-launchable", async () => {
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    const submenu = latestWindowSubmenu();
    expect(labelsOf(submenu)).toEqual([]);
    // ...and the platform window commands survive. This is the half that fails
    // if the submenu is dropped wholesale rather than emptied.
    expect(rolesOf(submenu)).toContain("minimize");
    expect(rolesOf(submenu).length).toBeGreaterThanOrEqual(2);
  });

  // A separator introducing nothing is a divider the user reads as a boundary
  // between two groups when there is only one.
  it("emits no separator for an empty auxiliary block", async () => {
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    const separators = latestWindowSubmenu().filter((item) => item.type === "separator");
    expect(separators).toHaveLength(1);
  });

  it("offers exactly the bare-launchable route, with its accelerator", async () => {
    publishLaunchableRoutes("timeline");
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    const submenu = latestWindowSubmenu();
    // The absent half is the point: `agent-console` is in the closed route SET
    // and out of the published lists, and the menu follows the published list.
    expect(labelsOf(submenu)).toEqual([AUXILIARY_ROUTE_LABELS["timeline"]]);
    const timelineEntry = submenu.find((item) => item.label === "Timeline");
    expect(timelineEntry?.accelerator).toBe("CmdOrCtrl+Shift+T");
    expect(typeof timelineEntry?.click).toBe("function");
    expect(rolesOf(submenu)).toContain("minimize");
  });

  it("offers bare-launchable entries in bare-launchable order", async () => {
    publishLaunchableRoutes("timeline", "agent-console");
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    expect(labelsOf(latestWindowSubmenu())).toEqual([
      AUXILIARY_ROUTE_LABELS["timeline"],
      AUXILIARY_ROUTE_LABELS["agent-console"],
    ]);
  });

  // The cross-assertion: with every route in the SHARED closed set
  // bare-launchable, the menu offers exactly that set — no entry the set does
  // not carry, and no route of the set missing. Written against
  // `AUXILIARY_ROUTE_NAMES` and `AUXILIARY_ROUTE_LABELS` rather than against a
  // local list, so a route added to the shared module and forgotten here fails
  // rather than passing silently.
  it("offers exactly the shared closed route set when every route is launchable", async () => {
    publishLaunchableRoutes(...AUXILIARY_ROUTE_NAMES);
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    expect(labelsOf(latestWindowSubmenu())).toEqual(
      AUXILIARY_ROUTE_NAMES.map((route) => AUXILIARY_ROUTE_LABELS[route]),
    );
  });

  it("opens the bare route at its own geometry when an entry is clicked", async () => {
    publishLaunchableRoutes("agent-console");
    const menu = await loadMenuModule();
    menu.installApplicationMenu();

    latestWindowSubmenu()
      .find((item) => item.label === AUXILIARY_ROUTE_LABELS["agent-console"])
      ?.click?.();

    expect(electronMock.constructed.map((browserWindow) => browserWindow.options)).toEqual([
      expect.objectContaining(AGENT_CONSOLE_GEOMETRY),
    ]);
  });

  // The two lists are consulted INDEPENDENTLY, which is the whole reason there
  // are two. A route whose body has landed is detachable — the deck's control
  // supplies the session id — while its BARE launch still reaches no subject,
  // because an auxiliary renderer starts with no open stores and the live bridge
  // refuses the session directory by name. The menu must stay silent about that
  // route. Without this case the split is decorative: pointing the menu back at
  // the implemented list would pass every other assertion here.
  it("offers no entry for a route that is implemented but not bare-launchable", async () => {
    publishImplementedOnlyRoutes("timeline");
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    const submenu = latestWindowSubmenu();
    expect(labelsOf(submenu)).toEqual([]);
    // ...and the platform window commands survive, so this is an emptied block
    // and not a dropped submenu.
    expect(rolesOf(submenu)).toContain("minimize");
  });

  // The other direction of the same independence, and the negative control that
  // keeps the case above from being vacuous: publishing the very same route into
  // the bare-launchable list DOES produce the entry. A build that had simply
  // stopped emitting auxiliary entries at all would pass the case above and fail
  // this one.
  it("offers the entry once that same route becomes bare-launchable", async () => {
    publishLaunchableRoutes("timeline");
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    expect(labelsOf(latestWindowSubmenu())).toEqual([AUXILIARY_ROUTE_LABELS["timeline"]]);
  });

  // The build's own contract, asserted against the REAL module rather than the
  // fixture, and asserted on BOTH lists because they now make two claims.
  //
  // `timeline` is implemented: its Phase-1C route body has landed, the console's
  // ledger family claims that surface slot, so `#/window/timeline` resolves to a
  // rendered pane and the deck can detach a pane into it. `agent-console` is
  // absent because its body has not landed.
  //
  // Nothing is bare-launchable. A context-less auxiliary window has exactly two
  // candidate sources — this window's open session stores, empty by construction
  // in a freshly opened auxiliary renderer, and the node's session directory,
  // which the live bridge refuses by name. So the menu offers no auxiliary entry
  // in the shipped build, which is the claim that makes this assertion worth
  // having.
  it("publishes exactly the routes whose bodies and whose reads have landed", async () => {
    const actual = await vi.importActual<typeof import("../shared/auxiliary-routes.js")>(
      "../shared/auxiliary-routes.js",
    );

    expect(actual.IMPLEMENTED_AUXILIARY_ROUTES).toEqual(["timeline", "agent-console"]);
    expect(actual.BARE_LAUNCHABLE_AUXILIARY_ROUTES).toEqual([]);
    // ...while the closed set itself is unchanged: both lists are claims about
    // this build, not about which routes exist.
    expect(actual.AUXILIARY_ROUTE_NAMES).toEqual(["timeline", "agent-console"]);
    // Negative control on the claim above: an implemented route is always a
    // member of the closed set, and this case would pass over a build that had
    // put a name in the list that no route grammar knows.
    for (const route of actual.IMPLEMENTED_AUXILIARY_ROUTES) {
      expect(actual.AUXILIARY_ROUTE_NAMES).toContain(route);
    }
  });
});

describe("registerMenuSection", () => {
  beforeEach(() => {
    electronMock.reset();
    routeListsMock.reset();
  });

  it("renders a section registered before the menu is installed", async () => {
    const menu = await loadMenuModule();

    menu.registerMenuSection({
      id: "onboarding",
      label: "Session",
      items: [{ label: "Set up providers" }],
    });
    menu.installApplicationMenu();

    const sessionMenu = latestTemplate().find((item) => item.label === "Session");
    expect(sessionMenu).toBeDefined();
    expect(labelsOf(sessionMenu?.submenu ?? [])).toEqual(["Set up providers"]);
  });

  it("places a registered section between View and Window", async () => {
    const menu = await loadMenuModule();

    menu.registerMenuSection({
      id: "onboarding",
      label: "Session",
      items: [{ label: "Set up collaboration" }],
    });
    menu.installApplicationMenu();

    const template = latestTemplate();
    const viewIndex = template.findIndex((item) => item.role === "viewMenu");
    const sessionIndex = template.findIndex((item) => item.label === "Session");
    const windowIndex = template.findIndex((item) => item.label === "Window");
    expect(viewIndex).toBeGreaterThanOrEqual(0);
    expect(sessionIndex).toBeGreaterThan(viewIndex);
    expect(windowIndex).toBeGreaterThan(sessionIndex);
  });

  it("rebuilds the installed menu when a section registers afterwards", async () => {
    const menu = await loadMenuModule();
    menu.installApplicationMenu();
    expect(latestTemplate().find((item) => item.label === "Session")).toBeUndefined();

    menu.registerMenuSection({
      id: "onboarding",
      label: "Session",
      items: [{ label: "Set up providers" }],
    });

    expect(electronMock.installedMenuTemplates).toHaveLength(2);
    expect(latestTemplate().find((item) => item.label === "Session")).toBeDefined();
  });

  it("replaces a section registered twice under the same id", async () => {
    const menu = await loadMenuModule();

    menu.registerMenuSection({ id: "onboarding", label: "Session", items: [{ label: "First" }] });
    menu.registerMenuSection({ id: "onboarding", label: "Session", items: [{ label: "Second" }] });
    menu.installApplicationMenu();

    const sessionMenus = latestTemplate().filter((item) => item.label === "Session");
    expect(sessionMenus).toHaveLength(1);
    expect(labelsOf(sessionMenus[0]?.submenu ?? [])).toEqual(["Second"]);
  });

  // The absent-not-disabled rule, one level up: an owner whose entries have no
  // route yet registers no items, and no empty submenu title appears.
  it("renders nothing for a section with no items", async () => {
    const menu = await loadMenuModule();

    menu.registerMenuSection({ id: "onboarding", label: "Session", items: [] });
    menu.installApplicationMenu();

    expect(latestTemplate().find((item) => item.label === "Session")).toBeUndefined();
  });

  it("holds no section across a fresh module load", async () => {
    const first = await loadMenuModule();
    first.registerMenuSection({ id: "onboarding", label: "Session", items: [{ label: "Only" }] });

    const second = await loadMenuModule();
    second.installApplicationMenu();

    expect(latestTemplate().find((item) => item.label === "Session")).toBeUndefined();
  });
});
