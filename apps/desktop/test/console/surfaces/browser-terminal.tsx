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
// ends on its host going silent under a lease that had just been taken, which is the
// frame its own header says a baseline should pin: 8.8's degraded state, standing
// over the whole transition ledger. So the store here is fed the scenario's beats
// verbatim and the degraded reading is the fixture's, not this file's.

import { waitFor, within } from "@testing-library/react";
import type { FunctionComponent } from "react";

import { renderSettled } from "../console-harness.js";

import { registerBrowserPanes } from "../../../src/renderer/src/console/browser/index.js";
import { BrowserCaptureCard } from "../../../src/renderer/src/console/browser/cards/CaptureCard.js";
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";
import { fixtureSessionSnapshot } from "../../../src/renderer/src/console/bridge/fixture/fixture-session-snapshot.js";
import { BROWSER_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/browser.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import { releaseQueuedPaneFrames } from "../../../src/renderer/src/console/browser/pane/BrowserPane.test-support.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../src/renderer/src/console/core/index.js";
import { DraftStore, UiStateStore } from "../../../src/renderer/src/console/persistence/index.js";
import {
  FrameStore,
  SessionStore,
  type ConsoleSessionEvent,
} from "../../../src/renderer/src/console/store/index.js";
import { registerTerminalPanes } from "../../../src/renderer/src/console/terminal/index.js";
import {
  type ConsolePaneContext,
  type PaneKind,
} from "../../../src/renderer/src/console/seats/index.js";
import { resolvedPaneBody } from "./pane-body-resolution.js";

/**
 * The browser or terminal pane body the deck holds for a kind, loaded.
 *
 * The resolution — build a family-scoped registry, preload, read the descriptor, throw
 * by name — lives once in `test/console/surfaces/pane-body-resolution.ts`; what stays here is
 * which registrars this file's mounts compose against, and the component TYPE each
 * mount below hands React.
 */
async function paneBodyComponent(kind: PaneKind): Promise<FunctionComponent<ConsolePaneContext>> {
  return await resolvedPaneBody(kind, (registry) => {
    registerBrowserPanes(registry);
    registerTerminalPanes(registry);
  });
}

/**
 * What a pane is BOUND to, minus the address that says which pane it is.
 *
 * `ConsolePaneAddress` is a kind-scoped union, so the address cannot come from a
 * shared helper: an object typed over every kind at once narrows to none of them,
 * and a helper that returned one would be claiming this context could serve an
 * artifact pane as readily as a browser. The `kind` therefore stays at each mount
 * below, where the body being mounted is also named, and this function supplies only
 * the binding — which is the same for both.
 *
 * `Omit` over the whole context rather than a hand-listed set: the binding is
 * exactly the members every arm of the union shares, so a member added to it lands
 * here and a member added to one arm's address does not.
 */
function paneBinding(
  overrides: Pick<ConsolePaneContext, "paneId" | "bridge" | "sessionStore">,
): Omit<ConsolePaneContext, "kind"> {
  return {
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    linkedSourcePaneId: undefined,
    focusHue: undefined,
    ...overrides,
  };
}

/**
 * A store holding every beat the terminal scenario scripts.
 *
 * The whole log rather than a prefix: the scenario reaches all five transition
 * reasons and then loses the host holding the lease, so the pane folded off it
 * carries the degraded reading over a full transition ledger — the surface these
 * tiers are for.
 */
function terminalSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: TERMINAL_SCENARIO.sessionId });
  // The scenario's own roster, which is what the composition root initialises a store
  // from. An empty base state is not a cheaper version of it: the console registers no
  // `membership.*` projector, so the roster arrives only here — and a lease surface
  // that gates its claim control on the caller's role then reads no role at all and
  // renders the absence for it, over a pane pinned for a different reason entirely.
  store.initialise(fixtureSessionSnapshot(TERMINAL_SCENARIO, TERMINAL_SCENARIO.sessionId));
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
 * changed. Through `getByRole` rather than an `[aria-label]` selector, because both
 * panes are named by `seats/ConsolePaneChrome` through `aria-labelledby` now and an
 * attribute selector cannot see a name a reference computes.
 */
function requireNamedSurface(
  container: HTMLElement,
  role: "region" | "article",
  accessibleName: string,
): HTMLElement {
  return within(container).getByRole(role, { name: accessibleName });
}

/**
 * What the chrome calls a pane of `kind` mounted over `sessionId`.
 *
 * The trail and not the kind's own word: `ConsolePaneChrome` names a pane by every
 * scope its address carries and then by what the pane is, so two terminals in one
 * deck are told apart by the session whose shell each holds. Derived here rather
 * than written out twice, so a mount that changes which session it addresses cannot
 * go on looking its own surface up under the old name.
 */
function paneTrailName(sessionId: string | undefined, paneWord: string): string {
  return `${sessionId ?? "No session"} ${paneWord}`;
}

/** The browser pane, mounted with its navigation subscription settled. */
export async function mountBrowserPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  const BrowserPaneBody = await paneBodyComponent("browser");
  const { container } = await renderSettled(
    <BrowserPaneBody
      kind="browser"
      {...paneBinding({ paneId: "pane-browser-surface", bridge, sessionStore: undefined })}
    />,
  );
  await releaseQueuedPaneFrames(bridge);
  return {
    element: requireNamedSurface(container, "region", paneTrailName(undefined, "Browser")),
    bridge,
  };
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
  const TerminalPaneBody = await paneBodyComponent("terminal");
  const { container } = await renderSettled(
    <TerminalPaneBody
      kind="terminal"
      {...paneBinding({
        paneId: "pane-terminal-surface",
        bridge,
        sessionStore: terminalSessionStore(),
      })}
    />,
  );
  const region = requireNamedSurface(
    container,
    "region",
    paneTrailName(TERMINAL_SCENARIO.sessionId, "Terminal"),
  );
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
  return {
    element: requireNamedSurface(container, "article", "Capture checkout-step-two.png"),
    bridge,
  };
}
