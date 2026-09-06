// The four rules the settings surface is the enforcement of.
//
// Two of them are invisible to the type system and would go wrong quietly: a rail
// that shrinks when a wire is unavailable teaches a person the setting does not
// exist, and a pane that swallows an unknown address leaves a bad deep link looking
// like a working one. The third — that the open section lives in the route and not
// in a local — is what makes a deep link and a rail click the same act.
//
// The fourth is the session a page is handed. Every settings address is
// `kind: "settings"` and names no session, so the frame store's ROUTE PROJECTION is
// `undefined` on all of them; a page handed that would render its no-session arm in
// every window that had ever opened a session, which is a constant dressed as an
// absence. The pane is handed the RETAINED session instead, subscribed rather than
// snapshotted.

import { act, render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { settle } from "../core/settle.test-support.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { SettingsSurface } from "./SettingsSurface.js";
import { registerSettingsSurface } from "./index.js";
import { SETTINGS_SECTION_IDS, SettingsPageRegistry } from "./settings-page-registry.js";
import {
  ConsoleSurfaceRegistry,
  type ConsoleSurfaceContext,
  type ConsoleSurfaceDescriptor,
} from "../seats/index.js";

/**
 * The render a window mounts, taken from the shipped registrar itself.
 *
 * Driven THROUGH `registerSettingsSurface` rather than around it. The page set that
 * function composes is closed over and is not a value this file may reach for, and
 * composing a second one here would be a copy that agrees with the shipped list until
 * someone adds a page to one of them — so claiming the slot and calling back the render
 * it registered is the only reading of "the pages a window renders" that cannot drift.
 * It also makes the slot claim itself a covered fact: a registrar that claimed nothing
 * fails here rather than rendering an empty rail.
 */
async function loadShippedSurfaceRender(): Promise<ConsoleSurfaceDescriptor["render"]> {
  const surfaces = new ConsoleSurfaceRegistry();
  registerSettingsSurface(surfaces);
  // The chunk, before the mount — which is what a window does too: the idle warm walks
  // this board after the first frame, and the rail's press warms the destination before
  // the route commits. Awaiting the same `preload` here is what makes the cases below
  // assertions about the RAIL rather than about how many turns a dynamic import takes.
  await surfaces.preload("settings");
  const descriptor = surfaces.descriptorFor("settings");
  if (descriptor === undefined) {
    throw new Error("the settings registrar claimed no surface slot");
  }
  return descriptor.render;
}

/**
 * That chunk, fetched once for the whole file and warmed off the per-case clock.
 *
 * THE COST IS REAL AND IT IS NOT WHAT ANY CASE MEASURES. The loader above pulls the
 * settings chunk — twelve page modules, the combobox stack two of them mount, and
 * eight stylesheets — and the first case to await it pays the transform for all of
 * them inside vitest's 5 s per-case default. That is comfortable when the file runs
 * alone and it is not comfortable when the tier runs beside a dozen others on one
 * machine: the first case times out, the render it abandoned keeps its effects, and
 * every case after it fails against a document the aborted one left behind — twelve
 * failures reported as twelve defects, none of them real, green standalone and red in
 * the suite. `test/console/architecture/act-settling.test.ts` records the same finding
 * about its own parse and takes the same remedy.
 *
 * So the fetch is memoised in a holder and awaited once in `beforeAll`, where the
 * budget belongs to a hook rather than to an assertion, and every case below then
 * measures the rail. A class with a private field rather than a module-level `let`,
 * per `apps/desktop/AGENTS.md`.
 */
class ShippedSurfaceRenderHolder {
  #fetched: Promise<ConsoleSurfaceDescriptor["render"]> | undefined;

  public fetch(): Promise<ConsoleSurfaceDescriptor["render"]> {
    this.#fetched ??= loadShippedSurfaceRender();
    return this.#fetched;
  }
}

const shippedSurfaceRender = new ShippedSurfaceRenderHolder();

/**
 * Long enough for a cold transform of that chunk on a loaded machine, and no case's.
 *
 * Measured rather than guessed: the file's own cold run reports ~50 s of transform and
 * import while a dozen sibling suites hold the machine, and about a second when the
 * transform cache is warm. The bound is roughly twice the measured worst case, because
 * it gates nothing — the bundle and endurance tiers own what this chunk may cost — and
 * a bound too tight here reintroduces exactly the cascade it exists to prevent.
 */
const CHUNK_WARM_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await shippedSurfaceRender.fetch();
}, CHUNK_WARM_TIMEOUT_MS);

/**
 * One page that renders the session member and nothing else.
 *
 * A probe rather than a shipped page, because the claim under test is the SURFACE's:
 * which session it hands down. Driving it through a real page would make the case
 * fail for that page's own wire instead, and asserting on a recorded callback would
 * let a snapshot read pass — the DOM is what a person sees, so the DOM is asserted.
 */
const SESSION_ECHO_CLASS = "settings-surface-test__session";

function sessionEchoPages(): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "cost",
    owner: "settings-surface-test",
    label: "Cost",
    keywords: [],
    render: (pageContext) => (
      <p className={SESSION_ECHO_CLASS}>{pageContext.retainedSessionId ?? "no session"}</p>
    ),
  });
  return pages;
}

function echoedSession(container: HTMLElement): string | undefined {
  return container.querySelector(`.${SESSION_ECHO_CLASS}`)?.textContent ?? undefined;
}

/** A window parked on a settings address, plus the store that remembers where it has been. */
interface SettingsWindow {
  readonly context: ConsoleSurfaceContext;
  readonly frameStore: FrameStore;
}

/**
 * Open the sessions named, then park on a settings address.
 *
 * The frame store is the REAL one rather than a stub: the retained session is state
 * a route transition writes, so a hand-built object would let this file assert a
 * contract the shipped store does not have — and the projection this surface must
 * NOT read is a getter on that same store, which is what makes the negative control
 * mean something.
 */
function windowAt(
  page: string | undefined,
  openedSessionIds: readonly string[] = [],
): SettingsWindow {
  const frameStore = new FrameStore();
  for (const sessionId of openedSessionIds) {
    frameStore.navigate({ kind: "workspace", sessionId });
  }
  frameStore.navigate({ kind: "settings", page });
  return {
    frameStore,
    context: {
      route: frameStore.getState().route,
      bridge: { source: "fixture" },
      frameStore,
      // The REAL registry rather than a stub: the surface resolves the retained
      // session's store through it, so a hand-built object would let this file
      // assert a resolution the shipped registry does not perform. No session is
      // opened on it here — a settings window that has opened none is the ordinary
      // case, and it is the one this harness renders.
      sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
    } as unknown as ConsoleSurfaceContext,
  };
}

/** The four fields this surface reads, and nothing else. */
function contextFor(page: string | undefined): ConsoleSurfaceContext {
  return windowAt(page).context;
}

/**
 * Render the surface the way a window mounts it.
 *
 * The announcer is part of that mount: a settings page that settles an act says so,
 * and `useAnnounce` throws outside the provider deliberately — so a harness that
 * omitted it would fail inside a page and report a missing live region as a broken
 * settings pane.
 *
 * Omitting `pages` renders the shipped composition; passing one renders over the page
 * set the case chose. The two arms are the same surface — the shipped arm reaches it
 * through the registrar, which is the only way the closed-over set is reachable at all.
 *
 * AND IT SETTLES, because the shipped arm is loader-backed. The registrar hands the
 * board an `import()` rather than a component, so what the first commit renders is the
 * surface's reserved frame and the pages arrive a macrotask later. The wait is the
 * console's own boundary rather than a counted number of turns, for the reason
 * `core/settle.test-support.ts` records: a chain that grows one link deeper stops being
 * waited for, and the case then reports the absence of a rail that was still in flight.
 */
async function renderSurface(
  context: ConsoleSurfaceContext,
  pages?: SettingsPageRegistry,
): Promise<ReturnType<typeof render>> {
  const surface =
    pages === undefined ? (
      (await shippedSurfaceRender.fetch())(context)
    ) : (
      <SettingsSurface context={context} pages={pages} />
    );
  const rendered = render(<LiveAnnouncerProvider>{surface}</LiveAnnouncerProvider>);
  // Even with the module already in hand, the lazy component suspends on its first
  // render and resumes on the resolved promise, so the body lands one boundary later.
  await settle();
  return rendered;
}

function railLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-settings__section")].map(
    (element) => element.textContent ?? "",
  );
}

describe("settings rail — every section, always", () => {
  it("renders one entry per declared section", async () => {
    // The claim is about a SET, so the case drives the set. A rail assembled from
    // the registry instead would shrink to whatever has been built, which is the
    // "never hides an entry because its wire is unavailable" rule inverted.
    const { container } = await renderSurface(contextFor(undefined));
    expect(railLabels(container)).toHaveLength(SETTINGS_SECTION_IDS.length);
  });

  it("marks the section the address names, and only that one", async () => {
    const { container } = await renderSurface(contextFor("keyboard"));
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Keyboard");
  });

  it("negative control: an address naming no section marks nothing", async () => {
    // Without this, the case above would pass over a rail that marked its first
    // entry whenever nothing else was selected — which would make `#/settings`
    // look like a section had been chosen.
    const { container } = await renderSurface(contextFor(undefined));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

  it("navigates rather than holding the selection in a local", async () => {
    // The open section lives in the route. A local would make a rail click and a
    // deep link two different acts, and the back button would stop working.
    const settingsWindow = windowAt(undefined);
    const { container } = await renderSurface(settingsWindow.context);
    const entry = container.querySelector(".meridian-settings__section");
    (entry as HTMLButtonElement | null)?.click();
    expect(settingsWindow.frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: SETTINGS_SECTION_IDS[0],
    });
  });
});

describe("settings pane — the three ways there is no page", () => {
  it("invites a choice when the address names none", async () => {
    const { container } = await renderSurface(contextFor(undefined));
    expect(container.textContent ?? "").toContain("Choose a section.");
  });

  it("names an address it does not recognise back to the reader", async () => {
    const { container } = await renderSurface(contextFor("not-a-section"));
    const text = container.textContent ?? "";
    expect(text).toContain("not-a-section");
    expect(text).toContain("does not name a section");
  });

  it("says a section's page is reserved rather than drawing an empty pane", async () => {
    // An EMPTY registry rather than the shipped one. The claim is the pane's — a
    // section whose page nobody registered says so — and pinning it to whichever
    // section happens to be unbuilt this week made it fail the moment that
    // section's lane landed, which is a stale test rather than a real regression.
    const { container } = await renderSurface(contextFor("keyboard"), new SettingsPageRegistry());
    expect(container.textContent ?? "").toContain("has not been built yet");
  });

  it("renders a registered page instead of the reservation", async () => {
    // Negative control for the case above: it would pass over a pane that rendered
    // the reservation for every section, registered or not. `mcp-servers` carries a
    // page in this build — its body is another plan's, but the PAGE is registered.
    const { container } = await renderSurface(contextFor("mcp-servers"));
    expect(container.textContent ?? "").toContain("MCP server page");
  });
});

describe("settings search — one field above the rail", () => {
  function searchFor(container: HTMLElement, query: string): void {
    const field = container.querySelector(".meridian-settings__search-input");
    const input = field as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    // INSIDE `act`, like the press below it. The dispatch drives a state write through
    // React's own change handler, and outside React's scope that write is applied
    // without the surrounding commit — so an assertion taken next reads the render
    // before it, and React reports the escape on stderr rather than failing.
    act(() => {
      setter?.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("replaces the rail with ranked hits while a query stands", async () => {
    const { container } = await renderSurface(contextFor(undefined));
    searchFor(container, "mcp");
    expect(railLabels(container).length).toBeLessThan(SETTINGS_SECTION_IDS.length);
    expect(container.textContent ?? "").toContain("MCP servers");
  });

  it("names the query and what was searched when nothing matches", async () => {
    const { container } = await renderSurface(contextFor(undefined));
    searchFor(container, "zzzzq");
    const text = container.textContent ?? "";
    expect(text).toContain("zzzzq");
    expect(text).toContain("Every section was searched");
  });

  it("negative control: clearing the query restores every section", async () => {
    // Without this, the first case would pass over a surface that filtered the rail
    // permanently on the first keystroke.
    const { container } = await renderSurface(contextFor(undefined));
    searchFor(container, "mcp");
    searchFor(container, "");
    expect(railLabels(container)).toHaveLength(SETTINGS_SECTION_IDS.length);
  });

  /**
   * Where a hit LANDS the reader.
   *
   * The design asks for three things from a match — that it name where it landed,
   * that it reach the pane, and that it settle there with one brief highlight. The
   * first is the hit row's own text and is covered above; these cases cover the other
   * two. The reach is asserted as FOCUS rather than as a scroll because focus is what
   * this module writes: the viewport following it is the platform's own behaviour, and
   * a case asserting a scroll offset in a layout-free DOM would be asserting nothing.
   */
  function pressHit(container: HTMLElement, label: string): void {
    const hits = [...container.querySelectorAll(".meridian-settings__section--result")];
    const hit = hits.find((element) => (element.textContent ?? "").includes(label));
    if (hit === undefined) {
      throw new Error(`no search hit named ${label}`);
    }
    act(() => {
      (hit as HTMLButtonElement).click();
    });
  }

  it("lands the reader on the page a hit names, and settles it once", async () => {
    const { container } = await renderSurface(contextFor("cost"), sessionEchoPages());
    const page = container.querySelector(".meridian-settings__page");
    expect(page?.className).not.toContain("--settling");

    searchFor(container, "cost");
    pressHit(container, "Cost");

    const heading = container.querySelector(".meridian-settings__page-heading");
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector(".meridian-settings__page")?.className).toContain("--settling");
  });

  it("settles again on a second hit into the section already open", async () => {
    // The case a boolean could not express: the state is already true, so a second
    // press would change nothing downstream and the reader would be told nothing.
    const { container } = await renderSurface(contextFor("cost"), sessionEchoPages());
    searchFor(container, "cost");
    pressHit(container, "Cost");
    const page = container.querySelector(".meridian-settings__page");
    // The animation's end is what clears it, and jsdom runs no animation — so the
    // case fires the event the browser would, and then asserts the second press
    // brings the highlight back.
    act(() => {
      page?.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(container.querySelector(".meridian-settings__page")?.className).not.toContain(
      "--settling",
    );

    pressHit(container, "Cost");
    expect(container.querySelector(".meridian-settings__page")?.className).toContain("--settling");
  });

  it("negative control: opening a section from the rail settles nothing", async () => {
    // Without this, the two cases above would pass over a page that flashed on every
    // arrival — which would say "you landed here" to someone who navigated by hand.
    const { container } = await renderSurface(contextFor("cost"), sessionEchoPages());
    const railEntry = container.querySelector(".meridian-settings__section");
    act(() => {
      (railEntry as HTMLButtonElement).click();
    });
    expect(container.querySelector(".meridian-settings__page")?.className).not.toContain(
      "--settling",
    );
    expect(document.activeElement).not.toBe(
      container.querySelector(".meridian-settings__page-heading"),
    );
  });
});

describe("the session a settings page is handed", () => {
  it("hands down the session this window opened, on an address that names none", async () => {
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = await renderSurface(settingsWindow.context, sessionEchoPages());
    expect(echoedSession(container)).toBe("session-alpha");
    // The negative control on the projection this surface used to read: it is
    // `undefined` on this very address, so a page fed from it could never see a
    // session at all. Asserted here rather than in a case of its own, because the
    // two readings have to be taken of ONE window for the contrast to hold.
    expect(settingsWindow.frameStore.activeSessionId).toBeUndefined();
  });

  it("hands down nothing in a window that has opened no session", async () => {
    const { container } = await renderSurface(windowAt("cost").context, sessionEchoPages());
    expect(echoedSession(container)).toBe("no session");
  });

  it("follows the retained session rather than the value it read at mount", async () => {
    // The subscription is the claim. A getter read during render answers whatever
    // the store held on that pass and notifies nobody afterwards, so this case
    // fails on a snapshot and passes only on a store subscription.
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = await renderSurface(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.navigate({ kind: "workspace", sessionId: "session-beta" });
    });
    expect(echoedSession(container)).toBe("session-beta");
  });

  it("negative control: an unrelated frame change does not rewrite the session", async () => {
    // Without this, the case above would pass over a surface that re-read the store
    // on every notification and reported whatever it found — the palette opening is
    // a frame change that says nothing about which session this window is in.
    const settingsWindow = windowAt("cost", ["session-alpha"]);
    const { container } = await renderSurface(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.setPaletteOpen(true);
    });
    expect(echoedSession(container)).toBe("session-alpha");
  });
});
