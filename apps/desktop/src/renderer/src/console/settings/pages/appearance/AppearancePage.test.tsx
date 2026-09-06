// The appearance page projects the applied scheme, chooses through the frame's own
// registered commands, and reports whether this window will remember the choice.
//
// The store block is asked at mount, so every render here goes through one helper
// that settles it. A bare `render` would leave the health reply landing after the
// case had finished, which is a warning in one case and a state update on an
// unmounted tree in the next.

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppearancePage, registerAppearancePage } from "./AppearancePage.js";
import { consoleCommands } from "../../../palette/index.js";
import { SCHEME_ATTRIBUTE } from "../../../tokens/index.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";
import {
  consoleTestUiStateStore,
  settingsPageContextWith,
} from "../../settings-page-mount.test-support.js";
import { MemoryPersistenceAdapter, type UiStateStore } from "../../../persistence/index.js";
import { settle } from "../../../core/settle.test-support.js";
import { formatByteQuantity } from "../../../primitives/index.js";

/**
 * Mount the page over a store, and let its one read land before anything is asserted.
 *
 * The bridge is `undefined as never` and the claim is deliberate: this page reads no
 * wire at all, so a fixture bridge here would be a collaborator nothing calls, and a
 * case that later DID reach one would fail loudly rather than quietly answering out
 * of a fixture nobody meant to consult.
 */
async function renderAppearancePage(
  uiStateStore: UiStateStore = consoleTestUiStateStore(),
): Promise<HTMLElement> {
  const context = settingsPageContextWith(undefined as never, undefined, undefined, uiStateStore);
  const { container } = render(<AppearancePage context={context} />);
  await settle();
  return container;
}

/** The three acts the frame registers per window, as this test's stand-ins record them. */
const SCHEME_COMMAND_IDS = [
  "frame.useSystemScheme",
  "frame.useLightScheme",
  "frame.useDarkScheme",
] as const;

/**
 * Register the three scheme commands against the REAL registry the page invokes.
 *
 * The page is driven through the registry rather than through an injected callback
 * on purpose, so the test registers the same ids the frame does and records which
 * one ran. What is stubbed is the ACT — a window-local closure over a store this
 * test has no frame for — never the registry, which is the module under test's
 * collaborator and is the real one.
 */
function registerRecordingSchemeCommands(chosen: string[]): () => void {
  for (const commandId of SCHEME_COMMAND_IDS) {
    consoleCommands.register({
      id: commandId,
      title: commandId,
      group: "Appearance",
      run: () => {
        chosen.push(commandId);
      },
    });
  }
  return () => {
    for (const commandId of SCHEME_COMMAND_IDS) {
      consoleCommands.unregister(commandId);
    }
  };
}

afterEach(() => {
  document.documentElement.removeAttribute(SCHEME_ATTRIBUTE);
});

/** The store block's own text, so a case never matches a word from the page around it. */
function storeBlockTextIn(container: HTMLElement): string {
  return (
    container.querySelector<HTMLElement>('section[aria-label="What this window remembers"]')
      ?.textContent ?? ""
  );
}

/** The two gauge figures, in the order the block draws them: in use, then allowed. */
function gaugeFiguresIn(container: HTMLElement): string[] {
  return [
    ...(container
      .querySelector<HTMLElement>('section[aria-label="What this window remembers"]')
      ?.querySelectorAll<HTMLElement>(".meridian-figure--wire") ?? []),
  ].map((element) => element.textContent ?? "");
}

describe("appearance page", () => {
  it("offers exactly the three modes and no fourth control", async () => {
    const container = await renderAppearancePage();
    const optionLabels = [...container.querySelectorAll(".meridian-scheme-choice__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(optionLabels).toStrictEqual(["Follow this machine", "Light", "Dark"]);
  });

  it("shows the applied attribute as the current choice", async () => {
    document.documentElement.setAttribute(SCHEME_ATTRIBUTE, "dark");
    const container = await renderAppearancePage();
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent ?? "").toContain("Dark");
  });

  it("treats an absent attribute as following the machine", async () => {
    // The frame encodes `system` by REMOVING the attribute, so a page that read an
    // absent attribute as "no choice" would show nothing current on a default install.
    const container = await renderAppearancePage();
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked[0]?.textContent ?? "").toContain("Follow this machine");
  });

  it("says so when the document carries a scheme it does not define", async () => {
    document.documentElement.setAttribute(SCHEME_ATTRIBUTE, "sepia");
    const container = await renderAppearancePage();
    expect(container.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(
      [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
        (option) => option.querySelector("[data-checked]") !== null,
      ),
    ).toHaveLength(0);
  });

  it("runs the frame's registered command when a mode is chosen", async () => {
    const chosen: string[] = [];
    const unregister = registerRecordingSchemeCommands(chosen);
    try {
      const container = await renderAppearancePage();
      const darkControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
        .find((option) => (option.textContent ?? "").includes("Dark"))
        ?.querySelector("input");
      await act(async () => {
        (darkControl as HTMLElement | null)?.click();
        await crossMacrotaskBoundary();
      });
      expect(chosen).toStrictEqual(["frame.useDarkScheme"]);
    } finally {
      unregister();
    }
  });

  it("renders a refusal when this window has no such command registered", async () => {
    // The negative control for the arm above: with nothing registered, the page must
    // say the scheme did not change rather than appear to have applied it.
    const container = await renderAppearancePage();
    const lightControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
      .find((option) => (option.textContent ?? "").includes("Light"))
      ?.querySelector("input");
    await act(async () => {
      (lightControl as HTMLElement | null)?.click();
      await crossMacrotaskBoundary();
    });
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    expect(container.textContent ?? "").toContain("scheme-command-unavailable");
  });

  it("says the choice will not survive a restart when the store is this window only", async () => {
    // The scheme block promises the choice is "remembered for the next start". On the
    // adapter the console falls back to, that is false — and this is the only place a
    // person can learn it without restarting and finding the choice gone.
    const container = await renderAppearancePage();
    const text = storeBlockTextIn(container);
    expect(text).toContain("this window only");
    // In the store's OWN sentence, from the one table that owns the reason vocabulary.
    expect(text).toContain("Durable storage was not requested for this window.");
    // And the adapter it is actually on, verbatim rather than paraphrased.
    expect(text).toContain("memory");
  });

  it("names the reason the durable store is not in use, in that reason's own words", async () => {
    const container = await renderAppearancePage(
      consoleTestUiStateStore(new MemoryPersistenceAdapter({ unavailableReason: "open-refused" })),
    );
    expect(storeBlockTextIn(container)).toContain(
      "The browser refused to open the database for this window.",
    );
  });

  it("negative control: it leaves the figure blank where no reading was taken", async () => {
    // A store with no ceiling measures what it holds and measures no ALLOWANCE, so
    // rendering "0 B" under Allowed would present a measurement nobody made.
    const container = await renderAppearancePage();
    const figures = gaugeFiguresIn(container);
    // Through the console's one byte formatter, whose own suite owns how a count
    // reads — what is claimed here is that the block renders THROUGH it and leaves the
    // unmeasured slot blank, not what 0 looks like.
    expect(figures[0]).toBe(formatByteQuantity(0).text);
    expect(figures[1]).toBe("\u2014");
  });

  it("renders both figures once the store has a ceiling to measure against", async () => {
    // The positive control for the arm above: the same two slots, both measured.
    const container = await renderAppearancePage(
      consoleTestUiStateStore(new MemoryPersistenceAdapter({ capacityBytes: 2048 })),
    );
    expect(gaugeFiguresIn(container)).toStrictEqual([
      formatByteQuantity(0).text,
      formatByteQuantity(2048).text,
    ]);
  });

  it("counts a refused write in the store's own refusal code, and only once it happens", async () => {
    // A ceiling of one byte, so the store refuses on its own quota path rather than
    // on the caller's — which is the half of the refusal table that is nobody's
    // defect and therefore fires no tripwire.
    const uiStateStore = consoleTestUiStateStore(
      new MemoryPersistenceAdapter({ capacityBytes: 1 }),
    );
    const before = await renderAppearancePage(uiStateStore);
    expect(storeBlockTextIn(before)).not.toContain("quota-exceeded");
    cleanup();

    // Through the real chokepoint, so what is counted is what a release build counts.
    const result = await uiStateStore.writeGlobal("scheme", "scheme", "dark");
    expect(result.outcome).toBe("refused");
    const after = await renderAppearancePage(uiStateStore);
    expect(storeBlockTextIn(after)).toContain("quota-exceeded");
  });

  it("claims the appearance section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerAppearancePage(registry);
    const descriptor = registry.descriptorFor("appearance");
    expect(descriptor?.label).toBe("Appearance");
    expect(descriptor?.keywords).toContain("theme");
  });
});
