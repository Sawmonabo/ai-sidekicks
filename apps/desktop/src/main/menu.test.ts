// Plan-023 Phase 1B (T-023p-1B-2) — the application menu.
//
// Two properties are asserted here.
//
// The first is the one Phase 1C depends on: the `Window` submenu's auxiliary
// entries are derived from the SHARED IMPLEMENTED-ROUTE LIST and never from the
// route type, so Phase 1B — which implements neither route — offers no command
// that would open a hash route with no renderer body behind it. That list is
// stubbed per case so both the empty and the populated shapes are reachable, one
// case cross-asserts the menu against the shared closed set, and one asserts the
// REAL shipped list is empty, which is the phase's own claim.
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

const implementedRoutesMock = vi.hoisted(() => {
  const routes: string[] = [];
  return {
    routes,
    reset(): void {
      routes.length = 0;
    },
  };
});

// Only the implemented-route list is stubbed. The labels and the closed route
// set come from the real module, so the fixture supplies WHICH routes this
// build implements and never what they are called — a menu asserted against a
// local copy of the labels would agree with a typo in either.
vi.mock("../shared/auxiliary-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/auxiliary-routes.js")>();
  return { ...actual, IMPLEMENTED_AUXILIARY_ROUTES: implementedRoutesMock.routes };
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

function publishImplementedRoutes(...routes: readonly string[]): void {
  implementedRoutesMock.reset();
  implementedRoutesMock.routes.push(...routes);
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
    implementedRoutesMock.reset();
  });

  it("offers no auxiliary entry when no route is implemented", async () => {
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

  it("offers exactly the implemented route, with its accelerator", async () => {
    publishImplementedRoutes("timeline");
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    const submenu = latestWindowSubmenu();
    // The absent half is the point: `agent-console` is in the closed route SET
    // and out of the implemented list, and the menu follows the implemented
    // list.
    expect(labelsOf(submenu)).toEqual([AUXILIARY_ROUTE_LABELS["timeline"]]);
    const timelineEntry = submenu.find((item) => item.label === "Timeline");
    expect(timelineEntry?.accelerator).toBe("CmdOrCtrl+Shift+T");
    expect(typeof timelineEntry?.click).toBe("function");
    expect(rolesOf(submenu)).toContain("minimize");
  });

  it("offers implemented entries in implemented order", async () => {
    publishImplementedRoutes("timeline", "agent-console");
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    expect(labelsOf(latestWindowSubmenu())).toEqual([
      AUXILIARY_ROUTE_LABELS["timeline"],
      AUXILIARY_ROUTE_LABELS["agent-console"],
    ]);
  });

  // The cross-assertion: with every route in the SHARED closed set implemented,
  // the menu offers exactly that set — no entry the set does not carry, and no
  // route of the set missing. Written against `AUXILIARY_ROUTE_NAMES` and
  // `AUXILIARY_ROUTE_LABELS` rather than against a local list, so a route added
  // to the shared module and forgotten here fails rather than passing silently.
  it("offers exactly the shared closed route set when every route is implemented", async () => {
    publishImplementedRoutes(...AUXILIARY_ROUTE_NAMES);
    const menu = await loadMenuModule();

    menu.installApplicationMenu();

    expect(labelsOf(latestWindowSubmenu())).toEqual(
      AUXILIARY_ROUTE_NAMES.map((route) => AUXILIARY_ROUTE_LABELS[route]),
    );
  });

  it("opens the bare route at its own geometry when an entry is clicked", async () => {
    publishImplementedRoutes("agent-console");
    const menu = await loadMenuModule();
    menu.installApplicationMenu();

    latestWindowSubmenu()
      .find((item) => item.label === AUXILIARY_ROUTE_LABELS["agent-console"])
      ?.click?.();

    expect(electronMock.constructed.map((browserWindow) => browserWindow.options)).toEqual([
      expect.objectContaining(AGENT_CONSOLE_GEOMETRY),
    ]);
  });

  // The build's own contract, asserted against the REAL module rather than the
  // fixture. Phase 1B shipped the main-process half only and implemented no
  // route; a Phase-1C route body is what adds one, and `timeline` is the first —
  // the console's ledger family claims that surface slot, so `#/window/timeline`
  // resolves to a rendered pane. `agent-console` is still absent because its body
  // has not landed, which is the claim that makes this assertion worth having.
  it("implements exactly the auxiliary routes whose bodies have landed", async () => {
    const actual = await vi.importActual<typeof import("../shared/auxiliary-routes.js")>(
      "../shared/auxiliary-routes.js",
    );

    expect(actual.IMPLEMENTED_AUXILIARY_ROUTES).toEqual(["timeline"]);
    // ...while the closed set itself is unchanged: "implemented" is a claim
    // about this build, not about which routes exist.
    expect(actual.AUXILIARY_ROUTE_NAMES).toEqual(["timeline", "agent-console"]);
  });
});

describe("registerMenuSection", () => {
  beforeEach(() => {
    electronMock.reset();
    implementedRoutesMock.reset();
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
