// The sidebar frame's harness, shared by its two spec files.
//
// ONE HOST AND ONE RENDER HELPER, and they are here rather than duplicated because the
// two suites assert about the same composed column from two directions — what it shows
// and what it does — and a second copy of the host is a second answer to "has the frame
// re-rendered", which is the question the subscription below settles.
//
// EVERY CASE COMPOSES ITS OWN REGISTRY. The frame takes one as a prop for exactly this
// reason — a module-scope registry would make an assertion about an absence true or
// false on test ORDER, which is the one way a claim about a hole can pass for the wrong
// reason.
//
// AND EVERY CASE OWNS ITS OWN MODEL, through the same subscription the workspace makes.
// The width and the collapse belong to the workspace's split, so the frame is handed a
// model rather than minting one, and a host that skipped the subscription would render
// one frame and never again.

import { render } from "@testing-library/react";
import { useSyncExternalStore, type ReactElement } from "react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenario/composer/composer.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { SidebarSectionRegistry } from "../../seats/index.js";
import { Sidebar } from "./Sidebar.js";
import { MountedSidebarSeat } from "./commands/sidebar-command-seat.js";
import { SidebarModel } from "./model/sidebar-model.js";

export const SECTION_OWNER = "sidebar-frame-test";

export interface RenderedSidebar {
  readonly sidebar: HTMLElement;
  readonly model: SidebarModel;
  readonly seat: MountedSidebarSeat;
  readonly announcements: HTMLElement;
  /** Re-read the column, which is replaced wholesale when it collapses to its rail. */
  column(): HTMLElement;
}

export function renderSidebar(
  registry: SidebarSectionRegistry = new SidebarSectionRegistry(),
  model: SidebarModel = new SidebarModel(),
): RenderedSidebar {
  const seat = new MountedSidebarSeat();
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const { container } = render(
    <LiveAnnouncerProvider>
      <SidebarHost
        model={model}
        registry={registry}
        seat={seat}
        bridge={bridge}
        sessionStore={new SessionStore({ sessionId: "session-sidebar" })}
        frameStore={new FrameStore()}
      />
    </LiveAnnouncerProvider>,
  );
  const column = (): HTMLElement => {
    const element = container.querySelector(".meridian-sidebar");
    if (!(element instanceof HTMLElement)) {
      throw new Error("the sidebar rendered no nav element");
    }
    return element;
  };
  const announcements = container.querySelector('[aria-live="polite"]');
  if (!(announcements instanceof HTMLElement)) {
    throw new Error("the announcer rendered no polite region");
  }
  return { sidebar: column(), model, seat, announcements, column };
}

export function disclosures(sidebar: HTMLElement): readonly HTMLButtonElement[] {
  return [...sidebar.querySelectorAll("button.meridian-sidebar__disclosure")].filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement,
  );
}

export function filterField(sidebar: HTMLElement): HTMLInputElement {
  const field = sidebar.querySelector(".meridian-sidebar__filter-field");
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("the sidebar rendered no filter field");
  }
  return field;
}

/** The frame plus the one subscription its owner makes, and nothing else. */
function SidebarHost(props: {
  readonly model: SidebarModel;
  readonly registry: SidebarSectionRegistry;
  readonly seat: MountedSidebarSeat;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly frameStore: FrameStore;
}): ReactElement {
  const snapshot = useSyncExternalStore(
    (listener) => props.model.subscribe(listener),
    () => props.model.snapshot,
  );
  return (
    <Sidebar
      sessionStore={props.sessionStore}
      bridge={props.bridge}
      frameStore={props.frameStore}
      openPane={() => undefined}
      model={props.model}
      snapshot={snapshot}
      sectionRegistry={props.registry}
      commandSeat={props.seat}
    />
  );
}
