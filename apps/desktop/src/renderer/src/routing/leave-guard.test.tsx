// Leaving a screen that holds unsaved edits loses them, so every move off it waits on the
// screen's own answer. The cases drive a real `WindowStore`, the one route writer every rail press,
// palette act and chord ends in, and the real hash binding for an address change, against the real
// `window.location.hash`.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { SESSIONS_HASH } from "#test/helpers/mount-app.js";
import { useHashRouteBinding } from "#renderer/app/hooks/useHashRouteBinding.js";
import { useLocationHash } from "#renderer/routing/hooks/useLocationHash.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { routeAgentDefinitionId, routeSkillId, skillRoute } from "./readers.js";
import type { AppRoute } from "./routes.js";

const EDITOR_HASH = "#/sidekicks/definition-alpha";
const EDITOR_ROUTE: AppRoute = {
  kind: "sidekicks",
  definition: "saved",
  definitionId: "definition-alpha",
};
const SETTINGS_HASH = "#/settings";
const SETTINGS_ROUTE: AppRoute = { kind: "settings", page: undefined };

/** A store on the editor with an ask registered whose answer the case gives. */
function guardedEditor(): {
  readonly frameStore: WindowStore;
  readonly ask: () => Promise<boolean>;
  readonly answer: { readonly resolve: (isLeaving: boolean) => void };
} {
  const frameStore = new WindowStore({ initialRoute: EDITOR_ROUTE });
  let resolve: (isLeaving: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const ask = vi.fn(() => promise);
  const answer = { resolve: (isLeaving: boolean) => resolve(isLeaving) };
  frameStore.leaveGuard.register({
    ask,
    isStayingOn: (route) => routeAgentDefinitionId(route) === "definition-alpha",
  });
  return { frameStore, ask, answer };
}

function BoundFrame(props: { readonly frameStore: WindowStore }): React.JSX.Element {
  const hash = useLocationHash(window);
  useHashRouteBinding(props.frameStore, hash, window);
  return <div />;
}

/** Let the queued `hashchange` and every promise before it land; happy-dom raises it on a task. */
async function settleQueuedBrowserTask(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

afterEach(async () => {
  cleanup();
  window.location.hash = SESSIONS_HASH;
  await crossMacrotaskBoundary();
});

describe("leaving a screen that holds unsaved edits", () => {
  it("leaves only on the screen's yes, asking once however often the person presses", async () => {
    const { frameStore, ask, answer } = guardedEditor();

    frameStore.navigate(SETTINGS_ROUTE);
    expect(frameStore.getState().route).toEqual(EDITOR_ROUTE);

    // A second press while the question is open is dropped, not queued or asked again.
    frameStore.navigate({ kind: "sessions" });
    expect(ask).toHaveBeenCalledTimes(1);

    answer.resolve(true);
    await crossMacrotaskBoundary();
    expect(frameStore.getState().route).toEqual(SETTINGS_ROUTE);
  });

  it("stays with the edits on a no, and asks again on the next move", async () => {
    const { frameStore, ask, answer } = guardedEditor();

    frameStore.replaceRoute(SETTINGS_ROUTE);
    answer.resolve(false);
    await crossMacrotaskBoundary();
    expect(frameStore.getState().route).toEqual(EDITOR_ROUTE);

    frameStore.navigate(SETTINGS_ROUTE);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("stays and says so on the window's banner when the screen's ask fails", async () => {
    const frameStore = new WindowStore({ initialRoute: EDITOR_ROUTE });
    frameStore.leaveGuard.register({
      ask: () => Promise.reject(new Error("the dialog did not open")),
      isStayingOn: () => false,
    });

    frameStore.navigate(SETTINGS_ROUTE);
    await crossMacrotaskBoundary();

    expect(frameStore.getState().route).toEqual(EDITOR_ROUTE);
    expect(frameStore.getState().banners).toMatchObject([{ code: "leave-not-asked" }]);
  });

  it("asks nothing for a move the screen stays on, and asks for one inside its destination", () => {
    // A skill folder's editor holds every file's edits, so another file of it keeps them, while
    // the skills list, the same destination, drops them.
    const frameStore = new WindowStore({ initialRoute: skillRoute("skill-1", "notes.md") });
    const ask = vi.fn(() => new Promise<boolean>(() => undefined));
    frameStore.leaveGuard.register({
      ask,
      isStayingOn: (route) => routeSkillId(route) === "skill-1",
    });

    frameStore.navigate(skillRoute("skill-1", "scripts/run.sh"));
    expect(ask).not.toHaveBeenCalled();
    expect(frameStore.getState().route).toEqual(skillRoute("skill-1", "scripts/run.sh"));

    frameStore.navigate({ kind: "skills" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(frameStore.getState().route).toEqual(skillRoute("skill-1", "scripts/run.sh"));
  });

  it("leaves at once, in the same call, with no ask registered or once it is removed", () => {
    const frameStore = new WindowStore({ initialRoute: EDITOR_ROUTE });
    frameStore.navigate(SETTINGS_ROUTE);
    expect(frameStore.getState().route).toEqual(SETTINGS_ROUTE);

    const ask = vi.fn(() => Promise.resolve(false));
    const unregister = frameStore.leaveGuard.register({ ask, isStayingOn: () => false });
    unregister();
    frameStore.navigate(EDITOR_ROUTE);
    expect(ask).not.toHaveBeenCalled();
    expect(frameStore.getState().route).toEqual(EDITOR_ROUTE);
  });

  it("puts an edited address back on a no and keeps the route", async () => {
    window.location.hash = EDITOR_HASH;
    const { frameStore, ask, answer } = guardedEditor();
    await act(async () => {
      render(<BoundFrame frameStore={frameStore} />);
      await crossMacrotaskBoundary();
    });

    window.location.hash = SETTINGS_HASH;
    await settleQueuedBrowserTask();
    // While the question is open the address already names the screen still shown.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(EDITOR_HASH);

    answer.resolve(false);
    await settleQueuedBrowserTask();
    expect(frameStore.getState().route).toEqual(EDITOR_ROUTE);
    expect(window.location.hash).toBe(EDITOR_HASH);
  });

  it("follows an edited address on a yes", async () => {
    window.location.hash = EDITOR_HASH;
    const { frameStore, answer } = guardedEditor();
    await act(async () => {
      render(<BoundFrame frameStore={frameStore} />);
      await crossMacrotaskBoundary();
    });

    window.location.hash = SETTINGS_HASH;
    await settleQueuedBrowserTask();
    answer.resolve(true);
    await settleQueuedBrowserTask();

    expect(frameStore.getState().route).toEqual(SETTINGS_ROUTE);
    expect(window.location.hash).toBe(SETTINGS_HASH);
  });
});
