// Shared scaffolding for the command list suites: one real composer over the real store, fed
// the composer scenario's beats through the registered run projectors.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../../../../fixtures/scenarios/waiting-for-input.js";
import { scenarioLeadAgentId } from "../../../../../../fixtures/data/opening-entries.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { RUN_LIFECYCLE_PROJECTORS } from "@renderer/store/session-events/run-lifecycle-projector.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { MessageComposer } from "../Composer.js";

/** The id of the console command the suites register so the list has an act to offer. */
export const TEST_COMMAND_ID = "composer-discovery-test.act";
/** A fragment of the sentence a press on a non-executable row is answered with. */
export const NOT_RUNNABLE_FRAGMENT = "there is nothing here to run";
/** Command ids a case registered; removed from the registry after each test. */
export const registeredIds: string[] = [];

/** A mounted composer and the handles a case drives it through. */
export interface MountedComposer {
  readonly container: HTMLElement;
  readonly line: HTMLTextAreaElement;
}

/** The scenario's lead, read out of the log rather than restated. */
export function composerLeadAgentId(): string {
  return scenarioLeadAgentId(WAITING_FOR_INPUT_SCENARIO);
}

/** A session store initialized with the composer scenario's beats. */
export function composerSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialize({ cursor: 0, entities: [] });
  store.applyBatch(
    WAITING_FOR_INPUT_SCENARIO.beats.map((beat) => beat.event as ProjectedSessionEvent),
  );
  return store;
}

/** Mount the real composer over the given bridge and return the handles a case needs. */
export async function mountComposer(options: {
  readonly bridge: PlatformBridge;
  readonly focusedPane: PaneAddress | undefined;
}): Promise<MountedComposer> {
  const sessionStore = composerSessionStore();
  const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const frameStore = new WindowStore();
  const route = { kind: "session", sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId } as const;
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <MessageComposer
        sessionStore={sessionStore}
        bridge={options.bridge}
        draftStore={draftStore}
        frameStore={frameStore}
        route={route}
        focusedPane={options.focusedPane}
      />,
    );
    await crossMacrotaskBoundary();
  });
  if (rendered === undefined) {
    throw new Error("the composer did not mount");
  }
  const mounted = rendered;
  const line = mounted.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the composer rendered no message line to watch");
  }
  return {
    container: mounted.container,
    line,
  };
}

/** Type text into the message line and let the input settle. */
export async function typeIntoLine(line: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.input(line, { target: { value: text } });
    await crossMacrotaskBoundary();
  });
}

/** The names of the rows the open list renders. */
export function optionNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('[role="option"] .meridian-command-discovery__name')].map(
    (element) => element.textContent ?? "",
  );
}

/**
 * Step focus into the open list, the way the line's own ArrowDown does. Activation keys are
 * handled by the list, so firing them at the textarea would test the wrong handler.
 */
export async function stepIntoList(mounted: MountedComposer): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.keyDown(mounted.line, { key: "ArrowDown" });
    await crossMacrotaskBoundary();
  });
  const list = mounted.container.querySelector('[role="listbox"]');
  if (!(list instanceof HTMLElement)) {
    throw new Error("the command list rendered no listbox");
  }
  return list;
}

/** Press one key on the focused list and let the act settle. */
export async function pressOnList(list: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(list, { key });
    await crossMacrotaskBoundary();
  });
}

/** The row `aria-activedescendant` names, resolved through the document. */
export function activeRow(container: HTMLElement, list: HTMLElement): HTMLElement | null {
  const activeId = list.getAttribute("aria-activedescendant");
  return activeId === null ? null : container.querySelector(`#${CSS.escape(activeId)}`);
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
});
