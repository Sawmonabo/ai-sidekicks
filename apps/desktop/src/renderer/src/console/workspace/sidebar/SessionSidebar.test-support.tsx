// What both sidebar suites mount, in one place.
//
// The harness is the sidebar wired to the REAL persistence hook, which is how the
// workspace mounts it: a harness that held the state itself would drive a stand-in
// for the module under test, which is the one shape a test may never take. Two copies
// of that wiring would be two sidebars, and a case in one file could pass against a
// mount the other file's cases never make.

import { act, render, waitFor } from "@testing-library/react";
import { expect } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario.js";
import { UiStateStore } from "../../persistence/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  type SidebarSectionId,
} from "../../seats/index.js";
import { memoryStore, sessionStore } from "../Workspace.test-support.js";
import { MountedSidebarSeat } from "./sidebar-commands.js";
import { useSidebarLayout } from "./sidebar-state.js";
import { SessionSidebar } from "./SessionSidebar.js";

export const SESSION_ID = "session-sidebar";

const SCENARIO: ConsoleScenario = {
  id: "sidebar",
  label: "Sidebar",
  purpose: "Drives the session sidebar's composition.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [],
  replies: [],
};

export interface HarnessProps {
  readonly uiStateStore: UiStateStore;
  readonly registry: SidebarSectionRegistry;
  readonly commandSeat: MountedSidebarSeat;
  readonly bridge: ConsoleBridge;
  /**
   * ONE store for the mount, built by the caller.
   *
   * Built here it would be a fresh store on every pass, which is a store construction in
   * a render body and, worse for these cases, a container identity that changes every
   * time — so a memo keyed on it would recompute whatever its other dependencies said,
   * and the case below could not tell a subscribed sidebar from an unsubscribed one.
   */
  readonly sessionStore: SessionStore;
}

/**
 * The sidebar wired to the real persistence hook, which is how the workspace mounts it.
 *
 * The hook is what restores and saves, so a harness that held the state itself would
 * drive a stand-in for the module under test — the one shape a test may never take.
 */
export function MountedSidebar(props: HarnessProps): React.JSX.Element {
  const sidebar = useSidebarLayout({
    uiStateStore: props.uiStateStore,
    sessionId: SESSION_ID,
    onSaveRefused: () => undefined,
  });
  return (
    <SessionSidebar
      sessionStore={props.sessionStore}
      bridge={props.bridge}
      openPane={() => undefined}
      layout={sidebar.layout}
      snapshot={sidebar.snapshot}
      registry={props.registry}
      commandSeat={props.commandSeat}
    />
  );
}

export interface RenderedSidebar {
  readonly container: HTMLElement;
  readonly uiStateStore: UiStateStore;
  readonly registry: SidebarSectionRegistry;
  readonly commandSeat: MountedSidebarSeat;
  readonly store: SessionStore;
  readonly unmount: () => void;
  readonly remount: () => void;
}

export function renderSidebar(
  uiStateStore: UiStateStore = memoryStore(),
  registry: SidebarSectionRegistry = new SidebarSectionRegistry(),
  store: SessionStore = sessionStore(SESSION_ID),
): RenderedSidebar {
  const commandSeat = new MountedSidebarSeat();
  const bridge = createFixtureBridge({ scenario: SCENARIO });
  const element = (
    <LiveAnnouncerProvider>
      <MountedSidebar
        uiStateStore={uiStateStore}
        registry={registry}
        commandSeat={commandSeat}
        bridge={bridge}
        sessionStore={store}
      />
    </LiveAnnouncerProvider>
  );
  const view = render(element);
  return {
    container: view.container,
    uiStateStore,
    registry,
    commandSeat,
    store,
    unmount: view.unmount,
    remount: () => {
      view.unmount();
      view.rerender(element);
    },
  };
}

export function headers(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[data-sidebar-section]")];
}

export function headerFor(container: HTMLElement, sectionId: SidebarSectionId): HTMLButtonElement {
  const header = headers(container).find(
    (candidate) => candidate.getAttribute("data-sidebar-section") === sectionId,
  );
  expect(header).not.toBeUndefined();
  return header as HTMLButtonElement;
}

export function press(header: HTMLButtonElement): void {
  act(() => {
    header.click();
  });
}

export function openSectionIds(container: HTMLElement): string[] {
  return headers(container)
    .filter((header) => header.getAttribute("aria-expanded") === "true")
    .map((header) => header.getAttribute("data-sidebar-section") ?? "");
}

/** Settle the restore, which is the first render every case below depends on. */
export async function settled(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(headers(container)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });
}
