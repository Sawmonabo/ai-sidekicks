// What the settings screen enforces: the page list is the closed set of pages its cursor opens,
// an address naming a control lands on it, leaving a page commits the field being edited, and
// a page is handed the retained session, subscribed, and never the route's projection (which is
// `undefined` on every settings address).

import { Collapsible } from "@base-ui/react/collapsible";
import { act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { settingsRoute } from "#renderer/routing/readers.js";
import { SETTINGS_CONTROL_ATTRIBUTE } from "./control/anchor.js";
import type { SettingsControl } from "./types.js";
import { APPEARANCE_CONTROLS } from "./pages/appearance/controls.js";
import { SETTINGS_PAGES, SettingsPageRegistry } from "./pages/registry.js";
import {
  CHUNK_WARM_TIMEOUT_MS,
  renderRoutedSettingsScreen,
  renderSettingsScreen,
  shippedScreenRender,
  windowAt,
} from "./SettingsScreen.test-support.js";

// Warm the settings chunk in a hook so no case pays for it.
beforeAll(async () => {
  await shippedScreenRender();
}, CHUNK_WARM_TIMEOUT_MS);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A registry holding one page, General, drawing `body` and declaring `controls`. */
function generalPageDrawing(
  body: () => React.ReactNode,
  controls: readonly SettingsControl[] = [],
): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({ pageId: "general", keywords: [], note: "", controls, render: body });
  return pages;
}

describe("the page list", () => {
  it("draws the ten pages in order, and the cursor opens the page it lands on, wrapping", async () => {
    const settingsWindow = windowAt("devices");
    const { container } = await renderRoutedSettingsScreen(
      settingsWindow,
      new SettingsPageRegistry(),
    );
    const entries = (): HTMLElement[] => [
      ...container.querySelectorAll<HTMLElement>(".meridian-settings__page-entry"),
    ];
    const openPage = (): unknown => {
      const { route } = settingsWindow.frameStore.getState();
      return route.kind === "settings" ? route.page : route.kind;
    };
    const currentEntry = (): string | null | undefined =>
      entries().find((entry) => entry.getAttribute("aria-current") === "page")?.textContent;
    const press = (key: string): void => {
      const focused = container.ownerDocument.activeElement;
      if (focused === null) {
        throw new Error("nothing holds focus to press a key on");
      }
      fireEvent.keyDown(focused, { key });
    };

    expect(entries().map((entry) => entry.textContent)).toStrictEqual([
      "General",
      "Providers",
      "MCP servers",
      "Projects",
      "Browser",
      "Keyboard",
      "Appearance",
      "Notifications",
      "Runtime",
      "Devices",
    ]);
    expect(currentEntry()).toBe("Devices");
    // One tab stop: the open page's entry.
    expect(entries().filter((entry) => entry.tabIndex === 0)).toStrictEqual([entries()[9]]);

    act(() => {
      entries()[9]?.focus();
    });
    press("ArrowDown");
    expect(openPage()).toBe("general");
    expect(currentEntry()).toBe("General");
    expect(container.ownerDocument.activeElement).toBe(entries()[0]);
    press("ArrowUp");
    expect(openPage()).toBe("devices");
    press("Home");
    expect(openPage()).toBe("general");
    press("ArrowDown");
    expect(openPage()).toBe("providers");
    press("End");
    expect(openPage()).toBe("devices");

    // A press is the same act as a key: it navigates rather than holding the page in a local.
    act(() => {
      entries()[5]?.click();
    });
    expect(openPage()).toBe("keyboard");
    expect(currentEntry()).toBe("Keyboard");
    // The press outranks where the keys left the cursor: the tab stop follows the open page.
    expect(entries().filter((entry) => entry.tabIndex === 0)).toStrictEqual([entries()[5]]);
  });
});

describe("arriving on a control", () => {
  it("opens the fold holding a control a link names, glides it to the middle and lights it, and a search hit lands on a shipped page's control", async () => {
    const settingsWindow = windowAt("general");
    const pages = generalPageDrawing(
      () => (
        <div className="landing-test__scroller" style={{ overflowY: "auto" }}>
          <Collapsible.Root>
            <Collapsible.Trigger>More</Collapsible.Trigger>
            <Collapsible.Panel hiddenUntilFound>
              <div {...{ [SETTINGS_CONTROL_ATTRIBUTE]: "folded-control" }}>
                <button type="button">Folded control</button>
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      ),
      [{ id: "folded-control", label: "Folded control" }],
    );
    const appearancePage = SETTINGS_PAGES.find((page) => page.pageId === "appearance");
    if (appearancePage === undefined) {
      throw new Error("the Appearance page is not registered");
    }
    pages.register(appearancePage);
    const { container, getByRole } = await renderRoutedSettingsScreen(settingsWindow, pages);
    const scroller = container.querySelector<HTMLElement>(".landing-test__scroller");
    const control = container.querySelector<HTMLElement>(`[${SETTINGS_CONTROL_ATTRIBUTE}]`);
    const foldTrigger = scroller?.querySelector("button") ?? null;
    if (scroller === null || control === null || foldTrigger === null) {
      throw new Error("the test page did not draw");
    }
    // A 400 px view at the top of the window, and the control 1000 px down it, 40 px tall.
    vi.spyOn(scroller, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(scroller, "scrollHeight", "get").mockReturnValue(2000);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 400));
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1000, 0, 40));
    const glide = vi.spyOn(ScrollController.prototype, "glideTo");
    expect(foldTrigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      settingsWindow.frameStore.navigate(settingsRoute("general", "folded-control"));
      await crossMacrotaskBoundary();
    });

    expect(foldTrigger.getAttribute("aria-expanded")).toBe("true");
    // The control's middle, 1020 px down, at the view's middle, 200 px into it.
    expect(glide.mock.calls).toStrictEqual([["settings-control-landing", 820]]);
    expect(control.hasAttribute("data-settings-landed")).toBe(true);
    expect(container.ownerDocument.activeElement?.textContent).toBe("Folded control");

    // The shipped Appearance page anchors the control it declares, so a hit lands on it.
    const searchField = getByRole("combobox", { name: "Search settings" });
    fireEvent.change(searchField, { target: { value: APPEARANCE_CONTROLS.light.label } });
    fireEvent.keyDown(searchField, { key: "Enter" });

    const { route } = settingsWindow.frameStore.getState();
    expect(route).toMatchObject({ kind: "settings", page: "appearance" });
    const lightOption = container.querySelector(
      `[${SETTINGS_CONTROL_ATTRIBUTE}="${APPEARANCE_CONTROLS.light.id}"]`,
    );
    expect(lightOption?.hasAttribute("data-settings-landed")).toBe(true);
    expect(container.ownerDocument.activeElement).toBe(
      lightOption?.querySelector('[role="radio"]'),
    );
  });
});

describe("a control the page draws late", () => {
  it("is landed on once drawn, and the wait ends at the person's first key or press", async () => {
    const lateControl = [{ id: "late-control", label: "Late control" }];
    const pages = generalPageDrawing(() => <ControlDrawnOnRead />, lateControl);
    pages.register({
      pageId: "runtime",
      keywords: [],
      note: "",
      controls: lateControl,
      render: () => <ControlDrawnOnRead />,
    });
    const settingsWindow = windowAt("general");
    const { container, getByRole } = await renderRoutedSettingsScreen(settingsWindow, pages);
    const isLanded = (): boolean =>
      container
        .querySelector(`[${SETTINGS_CONTROL_ATTRIBUTE}]`)
        ?.hasAttribute("data-settings-landed") === true;
    // Arrive on the control before the page has drawn it, then let the page's read answer.
    const arriveThenRead = async (pageId: "general" | "runtime", personInput?: () => void) => {
      act(() => {
        settingsWindow.frameStore.navigate(settingsRoute(pageId, "late-control"));
      });
      personInput?.();
      await act(async () => {
        getByRole("button", { name: "Read" }).click();
        await crossMacrotaskBoundary();
      });
    };

    await arriveThenRead("general");
    expect(isLanded()).toBe(true);

    await arriveThenRead("runtime", () => {
      fireEvent.keyDown(container.ownerDocument.body, { key: "a" });
    });
    expect(isLanded()).toBe(false);

    await arriveThenRead("general", () => {
      fireEvent.pointerDown(container.ownerDocument.body);
    });
    expect(isLanded()).toBe(false);
  });
});

describe("the search box", () => {
  it("opens the hit the arrows light", async () => {
    const settingsWindow = windowAt("general");
    const pages = generalPageDrawing(
      () => null,
      [
        { id: "first-port", label: "First port" },
        { id: "second-port", label: "Second port" },
      ],
    );
    const { getByRole } = await renderRoutedSettingsScreen(settingsWindow, pages);
    const searchField = getByRole("combobox", { name: "Search settings" });
    fireEvent.change(searchField, { target: { value: "port" } });
    fireEvent.keyDown(searchField, { key: "ArrowDown" });
    fireEvent.keyDown(searchField, { key: "Enter" });
    expect(settingsWindow.frameStore.getState().route).toStrictEqual(
      settingsRoute("general", "second-port"),
    );
  });
});

describe("leaving a settings page", () => {
  it("commits the field being edited, when another settings page opens and when Settings closes", async () => {
    const committed: string[] = [];
    const commit = (value: string): void => {
      committed.push(value);
    };
    const settingsWindow = windowAt("general");
    const pages = generalPageDrawing(() => (
      <FieldCommittingOnBlur label="General field" onCommit={commit} />
    ));
    pages.register({
      pageId: "runtime",
      keywords: [],
      note: "",
      render: () => <FieldCommittingOnBlur label="Runtime field" onCommit={commit} />,
    });
    const { getByLabelText } = await renderRoutedSettingsScreen(settingsWindow, pages);

    const generalField = getByLabelText("General field");
    act(() => {
      generalField.focus();
    });
    fireEvent.change(generalField, { target: { value: "general edit" } });
    // Back, Forward or a link opening another page takes this one away like a close does.
    act(() => {
      settingsWindow.frameStore.navigate(settingsRoute("runtime", undefined));
    });
    expect(generalField.isConnected).toBe(false);
    expect(committed).toStrictEqual(["general edit"]);

    const runtimeField = getByLabelText("Runtime field");
    act(() => {
      runtimeField.focus();
    });
    fireEvent.change(runtimeField, { target: { value: "runtime edit" } });
    act(() => {
      settingsWindow.frameStore.navigate({ kind: "sessions" });
    });

    // The screen is gone, as it is when Settings closes, and the edit reached its commit first.
    expect(runtimeField.isConnected).toBe(false);
    expect(committed).toStrictEqual(["general edit", "runtime edit"]);
  });
});

describe("the session a settings page is handed", () => {
  /** A page that renders only the retained session id it was handed. */
  function sessionEchoPages(): SettingsPageRegistry {
    const pages = new SettingsPageRegistry();
    pages.register({
      pageId: "runtime",
      keywords: [],
      note: "",
      render: (pageContext) => (
        <p className={SESSION_ECHO_CLASS}>{pageContext.retainedSessionId ?? "no session"}</p>
      ),
    });
    return pages;
  }

  function echoedSession(container: HTMLElement): string | undefined {
    return container.querySelector(`.${SESSION_ECHO_CLASS}`)?.textContent ?? undefined;
  }

  it("hands down the session this window opened, on an address that names none", async () => {
    const settingsWindow = windowAt("runtime", ["session-alpha"]);
    const { container } = await renderSettingsScreen(settingsWindow.context, sessionEchoPages());
    expect(echoedSession(container)).toBe("session-alpha");
    // The route projection is `undefined` on this address, so a page fed from it would never
    // see a session; both readings are taken of one window for the contrast.
    expect(settingsWindow.frameStore.activeSessionId).toBeUndefined();
  });

  it("follows the retained session rather than the value it read at mount", async () => {
    // Fails on a snapshot read at mount; passes only on a store subscription.
    const settingsWindow = windowAt("runtime", ["session-alpha"]);
    const { container } = await renderSettingsScreen(settingsWindow.context, sessionEchoPages());
    act(() => {
      settingsWindow.frameStore.navigate({ kind: "session", sessionId: "session-beta" });
    });
    expect(echoedSession(container)).toBe("session-beta");
  });
});

/**
 * Class of the probe page's echo of the retained session id.
 *
 * The probe is a page that renders only that id: the claim is the screen's handoff, not a
 * real page's wire, and the DOM is asserted because it is what a person sees.
 */
const SESSION_ECHO_CLASS = "settings-screen-test__session";

/** A field that commits what was typed when it loses focus, as a settings field does. */
function FieldCommittingOnBlur(props: {
  readonly label: string;
  readonly onCommit: (value: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label={props.label}
      value={value}
      onChange={(changeEvent) => {
        setValue(changeEvent.target.value);
      }}
      onBlur={() => {
        props.onCommit(value);
      }}
    />
  );
}

/** A control drawn only once its read answers, which the case stands in for with `Read`. */
function ControlDrawnOnRead(): React.JSX.Element {
  const [isDrawn, setIsDrawn] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setIsDrawn(true);
        }}
      >
        Read
      </button>
      {isDrawn ? (
        <div {...{ [SETTINGS_CONTROL_ATTRIBUTE]: "late-control" }}>
          <button type="button">Late control</button>
        </div>
      ) : null}
    </>
  );
}
