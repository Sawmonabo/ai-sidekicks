// The browser-terminal family's surfaces, mounted once for the two tiers that
// look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier both need the same three surfaces this family ships, and a
// per-tier copy of the mount would be two chances to compose them differently and
// then read the results as if they were comparable. That is `console-harness.tsx`'s
// own reason for existing, one level down: the harness owns HOW the console is
// mounted, and this module owns WHAT of this family is mounted into it.
//
// THE BODIES COME OUT OF THE DECK'S REGISTRY, NOT OUT OF AN IMPORT. Both panes are
// resolved through `ConsolePaneRegistry` after the two families register into it,
// so a tier renders the body the deck would mount rather than a component that
// happens to sit beside it — and the families' stylesheets arrive on the same edge
// their barrels already own, which is what makes the captured pixels the ones a
// person would see.
//
// THE TERMINAL IS DRIVEN BY THE SCENARIO, NOT BY A HAND-BUILT LOG. `TERMINAL_SCENARIO`
// ends on a `taken`, which is the state its own header says a baseline should pin —
// the pane's busiest frame rather than its emptiest. So the store here is fed the
// scenario's beats verbatim and the held lease is the fixture's, not this file's.

import { waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";

import { renderSettled } from "./console-harness.js";

import { registerBrowserPanes } from "../../src/renderer/src/console/browser/index.js";
import { BrowserCaptureCard } from "../../src/renderer/src/console/browser/CaptureCard.js";
import { TERMINAL_SCENARIO } from "../../src/renderer/src/console/bridge/scenarios/terminal.js";
import { BROWSER_SCENARIO } from "../../src/renderer/src/console/bridge/scenarios/browser.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../src/renderer/src/console/bridge/index.js";
import { DraftStore, UiStateStore } from "../../src/renderer/src/console/persistence/index.js";
import {
  FrameStore,
  SessionStore,
  type ConsoleSessionEvent,
} from "../../src/renderer/src/console/store/index.js";
import { registerTerminalPanes } from "../../src/renderer/src/console/terminal/index.js";
import {
  ConsolePaneRegistry,
  type ConsolePaneContext,
  type PaneKind,
} from "../../src/renderer/src/console/workspace/index.js";

/**
 * A registry carrying exactly this family's two claims.
 *
 * Built per call rather than shared: the registry is owner-scoped state, and two
 * tiers holding one instance would make the second tier's mount depend on whether
 * the first had run.
 */
function familyPaneRegistry(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registerBrowserPanes(registry);
  registerTerminalPanes(registry);
  return registry;
}

/**
 * The pane body the deck holds for a kind, as a component, or a throw.
 *
 * A throw rather than an optional return, so a family that stopped registering its
 * kind fails here — where the message names the kind — instead of rendering nothing
 * and letting a tier compare an empty box against a baseline.
 *
 * The descriptor's `render` is handed back for React to MOUNT rather than called
 * here. Both bodies are function components holding hooks, and a plain call outside
 * a render would run those hooks against no dispatcher — the deck mounts them, so a
 * tier that wants the deck's own body has to mount it the same way.
 */
function paneBodyComponent(kind: PaneKind): FunctionComponent<ConsolePaneContext> {
  const descriptor = familyPaneRegistry().descriptorFor(kind);
  if (descriptor === undefined) {
    throw new Error(`no console pane is registered for the \`${kind}\` kind`);
  }
  return descriptor.render;
}

/** The deck context a pane is mounted with, minus the parts each caller supplies. */
function paneContext(
  overrides: Pick<ConsolePaneContext, "kind" | "paneId" | "bridge" | "sessionStore">,
): ConsolePaneContext {
  return {
    entity: undefined,
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore(),
    focusHue: undefined,
    ...overrides,
  };
}

/**
 * A store holding every beat the terminal scenario scripts.
 *
 * The whole log rather than a prefix: the scenario reaches all five transition
 * reasons and ends held, so the pane folded off it carries a named holder and a
 * full transition ledger — the surface these tiers are for.
 */
function terminalSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: TERMINAL_SCENARIO.sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  store.applyBatch(TERMINAL_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent));
  return store;
}

/**
 * How long the emulator's chunk may take to arrive.
 *
 * Above Testing Library's one-second default because the FIRST mount in a file pays
 * for the whole `@xterm/xterm` chunk — the library, five addons, and its stylesheet
 * — compiled on demand by the dev server, while every later one reads the loader's
 * memo. A tier that timed out on the cold mount and passed on the warm ones would be
 * red on machine load rather than on the console.
 */
const EMULATOR_CHUNK_TIMEOUT_MS = 20_000;

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/**
 * Find the one element a surface renders itself as.
 *
 * Scoped by role and name rather than by class, because that is the pair a person
 * using assistive technology navigates by — a surface that lost its accessible name
 * would still match a class selector and would still be captured as if nothing had
 * changed.
 */
function requireRegion(container: HTMLElement, accessibleName: string): HTMLElement {
  const region = container.querySelector(`[aria-label="${accessibleName}"]`);
  if (!(region instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree is labelled \`${accessibleName}\``);
  }
  return region;
}

/** The browser pane, mounted with its navigation subscription settled. */
export async function mountBrowserPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  const BrowserPaneBody = paneBodyComponent("browser");
  const { container } = await renderSettled(
    <BrowserPaneBody
      {...paneContext({
        kind: "browser",
        paneId: "pane-browser-surface",
        bridge,
        sessionStore: undefined,
      })}
    />,
  );
  return { element: requireRegion(container, "Browser"), bridge };
}

/**
 * The terminal pane, mounted and waited on until the emulator's chunk has landed.
 *
 * The wait is the whole difference between a surface and a skeleton: the emulator
 * is reached across an `import()`, so a tier that read the tree straight after the
 * mount would be looking at the `not-loaded` absence rather than at the grid, and
 * would compare it against a baseline of the grid on the next run that was warm.
 */
export async function mountTerminalPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  const TerminalPaneBody = paneBodyComponent("terminal");
  const { container } = await renderSettled(
    <TerminalPaneBody
      {...paneContext({
        kind: "terminal",
        paneId: "pane-terminal-surface",
        bridge,
        sessionStore: terminalSessionStore(),
      })}
    />,
  );
  const region = requireRegion(container, "Terminal");
  // Deliberately NOT inside `act`. The chunk resolves in a promise React knows
  // nothing about, and an `act` scope holds the resulting commit back until it
  // exits — so a wait for the mounted grid placed inside one waits for a render
  // that its own scope is preventing. `waitFor` already wraps its polling in the
  // async act the library installs.
  await waitFor(
    () => {
      if (region.querySelector(".meridian-terminal-host__surface") === null) {
        throw new Error("the terminal emulator has not mounted yet");
      }
    },
    { timeout: EMULATOR_CHUNK_TIMEOUT_MS },
  );
  return { element: region, bridge };
}

/**
 * One stored capture, as the browser overflow renders it.
 *
 * A `stored` ingest rather than an in-flight one: the in-flight arm carries a meter
 * whose fill is a function of two numbers, and pinning a moving bar as a baseline
 * would make the tier red on timing rather than on design. The preview control is
 * present and the reveal control is not, which is the pair 12.6 names — a preview is
 * an explicit fetch, and the reveal takes no path.
 */
export async function mountBrowserCaptureCard(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  const { container } = await renderSettled(
    <BrowserCaptureCard
      captureName="checkout-step-two.png"
      scope="viewport"
      mediaType="image/png"
      ingest={{
        status: "stored",
        artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
        byteLength: 148_512,
      }}
      onOpenPreview={() => {
        // The control is present because a fetch route exists in this composition;
        // what it opens is the caller's, and a tier opens nothing.
      }}
    />,
  );
  return { element: requireRegion(container, "Capture checkout-step-two.png"), bridge };
}
