// Plan-023 Phase 1B (T-023p-1B-2) — the application menu.
//
// The property under test is the one Phase 1C depends on: the `Window`
// submenu's auxiliary entries are derived from the ROUTE REGISTRY and never
// from the route type, so Phase 1B — which registers nothing — offers no
// command that would open a hash route with no renderer body behind it.
//
// Two things are asserted together on every arm, because either alone is
// satisfiable by a wrong implementation: which entries the submenu carries,
// AND that the submenu still carries its platform window roles. A build that
// dropped the whole submenu to hide two entries would pass "no Timeline entry"
// while taking Minimize and Close off the menu bar with it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  interface MenuTemplateItem {
    readonly label?: string;
    readonly role?: string;
    readonly type?: string;
    readonly accelerator?: string;
    readonly click?: () => void;
    readonly submenu?: MenuTemplateItem[];
  }

  const installedTemplates: MenuTemplateItem[][] = [];

  return {
    installedTemplates,
    reset(): void {
      installedTemplates.length = 0;
    },
  };
});

vi.mock("electron", () => {
  interface MenuTemplateItem {
    readonly label?: string;
    readonly submenu?: MenuTemplateItem[];
  }

  return {
    Menu: {
      // `buildFromTemplate` hands the template straight through: the assertions
      // below read the template the module built, which is the whole of what
      // this module decides. What Electron then renders is Electron's.
      buildFromTemplate: vi.fn((template: MenuTemplateItem[]) => template),
      setApplicationMenu: vi.fn((menu: MenuTemplateItem[]) => {
        electronMock.installedTemplates.push(menu as never);
      }),
    },
    // `window.ts` is imported transitively by `menu.ts`; these keep that import
    // resolvable without a real Electron process. No menu test constructs a
    // window — the click paths are asserted as wiring, not as launches.
    app: { isPackaged: true },
    BrowserWindow: class {},
  };
});

interface MenuTemplateItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
  readonly accelerator?: string;
  readonly click?: () => void;
  readonly submenu?: MenuTemplateItem[];
}

type MenuModule = typeof import("./menu.js");
type RoutesModule = typeof import("./routes.js");

/** Re-imports both modules so each case starts from an empty registry. */
async function loadMenuModules(): Promise<{
  readonly menu: MenuModule;
  readonly routes: RoutesModule;
}> {
  vi.resetModules();
  const [menu, routes] = await Promise.all([import("./menu.js"), import("./routes.js")]);
  return { menu, routes };
}

function latestWindowSubmenu(): MenuTemplateItem[] {
  const template = electronMock.installedTemplates.at(-1) as MenuTemplateItem[] | undefined;
  expect(template).toBeDefined();
  const windowMenu = template?.find((item) => item.label === "Window");
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
  });

  it("offers no auxiliary entry when no route is registered", async () => {
    const { menu } = await loadMenuModules();

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
    const { menu } = await loadMenuModules();

    menu.installApplicationMenu();

    const separators = latestWindowSubmenu().filter((item) => item.type === "separator");
    expect(separators).toHaveLength(1);
  });

  it("offers exactly the registered route, with its accelerator", async () => {
    const { menu, routes } = await loadMenuModules();
    routes.auxiliaryRouteRegistry.register("timeline");

    menu.installApplicationMenu();

    const submenu = latestWindowSubmenu();
    expect(labelsOf(submenu)).toEqual(["Timeline"]);
    const timelineEntry = submenu.find((item) => item.label === "Timeline");
    expect(timelineEntry?.accelerator).toBe("CmdOrCtrl+Shift+T");
    expect(typeof timelineEntry?.click).toBe("function");
    expect(rolesOf(submenu)).toContain("minimize");
  });

  it("offers both entries in presentation order, not registration order", async () => {
    const { menu, routes } = await loadMenuModules();
    routes.auxiliaryRouteRegistry.register("agent-console");
    routes.auxiliaryRouteRegistry.register("timeline");

    menu.installApplicationMenu();

    expect(labelsOf(latestWindowSubmenu())).toEqual(["Timeline", "Agent console"]);
  });

  it("rebuilds the menu when a route registers after install", async () => {
    const { menu, routes } = await loadMenuModules();

    menu.installApplicationMenu();
    expect(labelsOf(latestWindowSubmenu())).toEqual([]);

    routes.auxiliaryRouteRegistry.register("agent-console");

    expect(electronMock.installedTemplates).toHaveLength(2);
    const submenu = latestWindowSubmenu();
    expect(labelsOf(submenu)).toEqual(["Agent console"]);
    expect(submenu.find((item) => item.label === "Agent console")?.accelerator).toBe(
      "CmdOrCtrl+Shift+A",
    );
  });

  it("rebuilds nothing when a route registers twice", async () => {
    const { menu, routes } = await loadMenuModules();
    menu.installApplicationMenu();
    routes.auxiliaryRouteRegistry.register("timeline");
    const installsAfterFirstRegistration = electronMock.installedTemplates.length;

    routes.auxiliaryRouteRegistry.register("timeline");

    expect(electronMock.installedTemplates).toHaveLength(installsAfterFirstRegistration);
  });

  // Installing twice must not stack subscriptions: two live listeners would
  // rebuild the menu twice per registration, and the leak grows with every
  // install.
  it("holds one registry subscription across repeated installs", async () => {
    const { menu, routes } = await loadMenuModules();

    menu.installApplicationMenu();
    menu.installApplicationMenu();
    const installsBeforeRegistration = electronMock.installedTemplates.length;

    routes.auxiliaryRouteRegistry.register("timeline");

    expect(electronMock.installedTemplates.length - installsBeforeRegistration).toBe(1);
  });
});

describe("the auxiliary route registry", () => {
  it("reports only what has been registered", async () => {
    const { routes } = await loadMenuModules();
    const registry = routes.auxiliaryRouteRegistry;

    expect(registry.has("timeline")).toBe(false);
    expect(registry.registered()).toEqual([]);

    registry.register("timeline");

    expect(registry.has("timeline")).toBe(true);
    expect(registry.has("agent-console")).toBe(false);
    expect(registry.registered()).toEqual(["timeline"]);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const { routes } = await loadMenuModules();
    const listener = vi.fn();
    const unsubscribe = routes.auxiliaryRouteRegistry.onChange(listener);

    unsubscribe();
    routes.auxiliaryRouteRegistry.register("timeline");

    expect(listener).not.toHaveBeenCalled();
  });

  // Phase 1B's own contract, asserted rather than assumed: this phase ships the
  // main-process half only, so nothing in `src/main/**` may register a route.
  // Phase 1C's route modules are what flip these.
  it("is empty after the main process starts up", async () => {
    const { routes } = await loadMenuModules();
    await import("./window.js");
    await import("./menu.js");

    expect(routes.auxiliaryRouteRegistry.registered()).toEqual([]);
  });
});
