// The walkthrough's three openings, and where it hands a person on.
//
// IT IS NOT A DESTINATION, so nothing here navigates on its own: the two commands and
// the activation signal are the whole of how it opens, and a mounted overlay with
// nothing asked shows no dialog at all. That is the trigger discipline expressed as a
// test — a walkthrough that appeared on mount would be the splash the corpus forbids.
//
// AND AN OPENING LEAVES WITHOUT FINISHING. A provider-only activation closes because
// group B may not be locked, and it closes WITHOUT completing because group A may not
// be finished around it. A walkthrough that closed by dispatching
// `onboarding.complete` would answer the same two questions the lock refused to demand.
//
// WHEN IT MAY BE CLOSED AT ALL is asserted next door in
// `OnboardingOverlay.relay-lock.test.tsx` — the fail-closed relay lock and its three
// readings, split off when the pair took this file past the package's ceiling.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { bridgeAnswering } from "../bridge/fixture/call-plane/bridge.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenario/onboarding.js";
import { consoleCommands } from "../palette/index.js";
import { FrameStore } from "../store/index.js";
import { bridgeWithNoRelayChosen, bridgeWithStepsDone } from "./onboarding-state.test-support.js";
import {
  activateAt,
  mount,
  unregisterOnboardingCommands,
} from "./OnboardingOverlay.test-support.js";
import type { ConsoleRoute } from "../routing/index.js";
import { ONBOARDING_STEPS, RESUME_OPENING } from "./steps/step-model.js";

/**
 * Every route this window is navigated to, off the store's own publishes.
 *
 * Filtered on the route having MOVED, because the same store carries the modal-surface
 * cell this overlay also writes — an unfiltered recorder would report a route per
 * publish and count the dialog opening as a navigation.
 */
function navigationsOf(frameStore: FrameStore): readonly ConsoleRoute[] {
  const routes: ConsoleRoute[] = [];
  frameStore.readable.subscribe((state, previous) => {
    if (state.route !== previous.route) {
      routes.push(state.route);
    }
  });
  return routes;
}

afterEach(unregisterOnboardingCommands);

describe("how the walkthrough opens", () => {
  it("shows nothing at all until something asks for it", async () => {
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    expect(document.body.textContent).not.toContain("Set up this node");
  });

  it("contributes both entry points to the palette", async () => {
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    expect(consoleCommands.has("onboarding.open")).toBe(true);
    expect(consoleCommands.has("onboarding.setUpProviders")).toBe(true);
  });

  it("opens at the providers step when a refused run raises the activation", async () => {
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    await activateAt("providers");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Set up this node");
    expect(text).toContain("Providers");
    // The step it opened at, rather than whichever step is first.
    expect(text).toContain("offered and never required");
  });
});

describe("leaving a provider-only activation", () => {
  it("closes without recording this node as set up", async () => {
    // Group A is wholly unanswered on this node. The dialog must let a person out —
    // the case above — and must not take their leaving as an answer: nothing reaches
    // `onboarding.complete`, and the footer's own control says which answers are
    // outstanding rather than offering to finish over them.
    const base = bridgeWithNoRelayChosen();
    let completions = 0;
    const counted: ConsoleBridge = {
      ...base,
      growth: {
        ...base.growth,
        onboardingComplete: async (request) => {
          completions += 1;
          return base.growth.onboardingComplete(request);
        },
      },
    };
    await mount(counted);
    await activateAt("providers");

    const finish = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Finish setting up",
    );
    expect(finish).toBeDefined();
    expect(finish?.disabled).toBe(true);

    const close = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Close",
    );
    expect(close).toBeDefined();
    await act(async () => {
      finish?.click();
      close?.click();
      await crossMacrotaskBoundary();
    });

    expect(completions).toBe(0);
    expect(document.body.textContent).not.toContain("Set up this node");
  });
});

/**
 * The same node with one provider holding no account at all.
 *
 * ONE ARM REPLACED AND THE REST OF THE WORLD LEFT ALONE, through the fixture's own
 * daemon arm: the shipped scenario's two readiness rows are `authenticated` and
 * `sign_in`, and neither carries the remedy this case is about. Replacing the reply
 * rather than editing the scenario keeps every other read — the state read the rail
 * folds, the relay options, the clock — exactly what every other case in this file
 * gets, and keeps the register arm out of the captures the shipped scenario feeds.
 *
 * EXACTLY ONE ROW CARRIES IT, so the control the case presses is unambiguous: a
 * second register row would put two identically-labelled controls on screen and the
 * case would be asserting about whichever one the query happened to reach first.
 */
function bridgeWhereCodexHoldsNoAccount(): ConsoleBridge {
  return bridgeAnswering(
    async (call, passThrough) =>
      call.method === "providerAccount.list"
        ? {
            accounts: [],
            usageWindows: [],
            readiness: [
              { provider: "claude", state: "authenticated" },
              {
                provider: "codex",
                state: "no_account",
                remedy: { kind: "register", provider: "codex" },
              },
            ],
          }
        : passThrough(),
    ONBOARDING_SCENARIO,
  ).bridge;
}

describe("the way out to the account registry", () => {
  it("navigates to the section the control names rather than to bare settings", async () => {
    // `#/settings` with no page renders the rail's "Choose a section" and nothing
    // else, so a control promising the registry would land a person one search short
    // of it. The route names the section the provider-accounts page registers under.
    const frameStore = new FrameStore();
    const routes = navigationsOf(frameStore);
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }), frameStore);
    await activateAt("providers");

    const openRegistry = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Open the account registry",
    );
    expect(openRegistry).toBeDefined();
    await act(async () => {
      openRegistry?.click();
      await crossMacrotaskBoundary();
    });

    expect(routes).toStrictEqual([{ kind: "settings", page: "accounts" }]);
  });

  it("carries the provider when the control pressed was a row's own", async () => {
    // The row's control and the step's differ in one respect and it is the whole
    // reason the row has one: the address names the provider the reader came from,
    // so the page can say what registering it is for and what the first run does
    // without it. A handler that dropped the argument would land on the identical
    // page as the case above and this is what reports it.
    const frameStore = new FrameStore();
    const routes = navigationsOf(frameStore);
    await mount(bridgeWhereCodexHoldsNoAccount(), frameStore);
    await activateAt("providers");

    const openForCodex = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Open the registry to add an account",
    );
    expect(openForCodex).toBeDefined();
    await act(async () => {
      openForCodex?.click();
      await crossMacrotaskBoundary();
    });

    expect(routes).toStrictEqual([{ kind: "settings", page: "accounts", selection: "codex" }]);
  });
});

describe("the window behind an open walkthrough", () => {
  it("publishes that a modal surface has the window, and clears it on close", async () => {
    // `modal="trap-focus"` traps focus and leaves inerting the app root to the shell,
    // and `console-view-family-isolation` keeps the frame from naming this family — so
    // without this publish the rail and the whole route surface stayed reachable to
    // anyone moving through the document behind an open walkthrough.
    const frameStore = new FrameStore();
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }), frameStore);
    expect(frameStore.getState().isModalSurfaceOpen).toBe(false);

    await activateAt("providers");
    expect(frameStore.getState().isModalSurfaceOpen).toBe(true);

    const close = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Close",
    );
    await act(async () => {
      close?.click();
      await crossMacrotaskBoundary();
    });
    expect(frameStore.getState().isModalSurfaceOpen).toBe(false);
  });
});

describe("the collaboration entry point", () => {
  it("resumes at the step the daemon says is unresolved rather than at the first", async () => {
    // The command's `run` fires before this window has necessarily read anything —
    // the flow's window triggers mount inside the walkthrough — so a step chosen there
    // came from a snapshot reporting nothing done, and every press opened at `relay`
    // however far along the node was. It raises the INTENT now.
    await mount(bridgeWithStepsDone("relay"));
    const open = consoleCommands.get("onboarding.open");
    expect(open).toBeDefined();
    await act(async () => {
      open?.run();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    const title = document.querySelector(".meridian-onboarding__title");
    expect(title?.textContent).toBe(ONBOARDING_STEPS.telemetry.label);
  });

  it("is still the group-A opening, so an unmade relay choice holds it shut", async () => {
    // The lock reads which group an activation opens, and a resume opening is the
    // collaboration one — the flow the non-dismissible rule is written for. Deciding it
    // from the sentinel rather than after the read is what keeps the lock answerable on
    // the frame the dialog opens on.
    await mount(bridgeWithNoRelayChosen());
    await activateAt(RESUME_OPENING);
    expect(document.body.textContent).toContain("Choose a relay to continue");
  });
});

describe("Not now, on the provider step", () => {
  it("closes the activation and records nothing", async () => {
    // The provider group persists nothing. The control used to dispatch
    // `onboarding.stepSkip`, which wrote the provider step into the daemon's own
    // completed set.
    const base = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    let skipsRecorded = 0;
    const counted: ConsoleBridge = {
      ...base,
      growth: {
        ...base.growth,
        onboardingStepSkip: async (request) => {
          skipsRecorded += 1;
          return base.growth.onboardingStepSkip(request);
        },
      },
    };
    await mount(counted);
    await activateAt("providers");

    const dismiss = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Not now",
    );
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss?.click();
      await crossMacrotaskBoundary();
    });

    expect(skipsRecorded).toBe(0);
    expect(document.body.textContent).not.toContain("Set up this node");
  });
});
