// How a case drives the settings surface: the window it is parked in, the mount, and a
// keystroke into its search field.
//
// HOISTED ON THE SECOND SUITE, which is the package's rule. `SettingsSurface.test.tsx`
// holds the four rules the surface is the enforcement of, and
// `SettingsSurface.page-warm.test.tsx` holds when this board's deferred pages are
// fetched — two disjoint claims about one surface, and both need the same window, the
// same mount, and the same way of typing into the field. Written twice they would drift
// the first time either grew a member.

import { render } from "@testing-library/react";

import { settle } from "../core/settle.test-support.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { SettingsSurface } from "./SettingsSurface.js";
import { registerSettingsSurface } from "./index.js";
import { type SettingsPageRegistry } from "./settings-page-registry.js";
import {
  ConsoleSurfaceRegistry,
  type ConsoleSurfaceContext,
  type ConsoleSurfaceDescriptor,
} from "../seats/index.js";

/**
 * The render a window mounts, taken from the shipped registrar itself.
 *
 * Driven THROUGH `registerSettingsSurface` rather than around it. The page set that
 * function composes is closed over and is not a value a suite may reach for, and
 * composing a second one here would be a copy that agrees with the shipped list until
 * someone adds a page to one of them — so claiming the slot and calling back the render
 * it registered is the only reading of "the pages a window renders" that cannot drift.
 * It also makes the slot claim itself a covered fact: a registrar that claimed nothing
 * fails here rather than rendering an empty rail.
 */
export async function shippedSurfaceRender(): Promise<ConsoleSurfaceDescriptor["render"]> {
  const surfaces = new ConsoleSurfaceRegistry();
  registerSettingsSurface(surfaces);
  // The chunk, before the mount — which is what a window does too: the idle warm walks
  // this board after the first frame, and the rail's press warms the destination before
  // the route commits. Awaiting the same `preload` here is what makes the cases that
  // follow assertions about the RAIL rather than about how many turns a dynamic import
  // takes.
  await surfaces.preload("settings");
  const descriptor = surfaces.descriptorFor("settings");
  if (descriptor === undefined) {
    throw new Error("the settings registrar claimed no surface slot");
  }
  return descriptor.render;
}

/** A window parked on a settings address, plus the store that remembers where it has been. */
export interface SettingsWindow {
  readonly context: ConsoleSurfaceContext;
  readonly frameStore: FrameStore;
}

/**
 * Open the sessions named, then park on a settings address.
 *
 * The frame store is the REAL one rather than a stub: the retained session is state a
 * route transition writes, so a hand-built object would let a case assert a contract the
 * shipped store does not have — and the projection this surface must NOT read is a getter
 * on that same store, which is what makes the negative control mean something.
 */
export function windowAt(
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
      // session's store through it, so a hand-built object would let a case assert a
      // resolution the shipped registry does not perform. No session is opened on it
      // here — a settings window that has opened none is the ordinary case, and it is
      // the one this harness renders.
      sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
    } as unknown as ConsoleSurfaceContext,
  };
}

/**
 * Render the surface the way a window mounts it.
 *
 * The announcer is part of that mount: a settings page that settles an act says so, and
 * `useAnnounce` throws outside the provider deliberately — so a harness that omitted it
 * would fail inside a page and report a missing live region as a broken settings pane.
 *
 * Omitting `pages` renders the shipped composition; passing one renders over the page set
 * the case chose. The two arms are the same surface — the shipped arm reaches it through
 * the registrar, which is the only way the closed-over set is reachable at all.
 *
 * AND IT SETTLES, because the shipped arm is loader-backed. The registrar hands the board
 * an `import()` rather than a component, so what the first commit renders is the surface's
 * reserved frame and the pages arrive a macrotask later. The wait is the console's own
 * boundary rather than a counted number of turns, for the reason
 * `core/settle.test-support.ts` records: a chain that grows one link deeper stops being
 * waited for, and the case then reports the absence of a rail that was still in flight.
 */
export async function renderSurface(
  context: ConsoleSurfaceContext,
  pages?: SettingsPageRegistry,
): Promise<ReturnType<typeof render>> {
  const surface =
    pages === undefined ? (
      (await shippedSurfaceRender())(context)
    ) : (
      <SettingsSurface context={context} pages={pages} />
    );
  const rendered = render(<LiveAnnouncerProvider>{surface}</LiveAnnouncerProvider>);
  // Even with the module already in hand, the lazy component suspends on its first render
  // and resumes on the resolved promise, so the body lands one boundary later.
  await settle();
  return rendered;
}

/**
 * Type into the search field the way a person does.
 *
 * The native value setter rather than an assignment, because React reads the input's
 * value through its own descriptor and a plain write is invisible to it.
 */
export function searchFor(container: HTMLElement, query: string): void {
  const field = container.querySelector(".meridian-settings__search-input");
  const input = field as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, query);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
