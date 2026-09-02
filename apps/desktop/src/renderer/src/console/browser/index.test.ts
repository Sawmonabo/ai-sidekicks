// The browser family's registration terms, and the fixture it is registered against.
//
// Two claims, and neither is about what the pane looks like — that is
// `panes/browser/BrowserPane.test.tsx`'s. Here: the deck holds the pane on the terms
// the descriptor states, and the scenario the fixture plays calls no method the
// corpus has not registered. The second is the one worth a test rather than a
// review: a fabricated method string in a fixture is invisible until the day the
// real one lands and disagrees with it.
//
// WHAT THIS FILE NO LONGER CLAIMS, AND WHO CLAIMS IT NOW. It carried a hand-copied
// list of the event kinds this fixture may script and its own beat-ordering check.
// Both are legs of `bridge/scenarios/wire-truth.ts`, the single predicate every
// scenario on the seat board is measured through, and it reads the compiled
// `SESSION_EVENT_CATEGORY_BY_TYPE` census rather than a copy — which matters, because
// the copy had already gone stale once, carrying `participant.joined`, a name the
// taxonomy does not register at all. The call names below survive because nothing
// else censuses them: wire truth walks the replies for duplicates and spendable
// latency and never asks what a call is named.

import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO, BROWSER_SCENARIO_ID } from "../bridge/scenarios/browser.js";
import { ConsolePaneRegistry } from "../seats/index.js";
import { registerBrowserPanes } from "./index.js";

/**
 * The daemon methods this fixture is allowed to call.
 *
 * Both are registered reads `first-run.ts` already scripts. The browser namespace is
 * on `Plan-023 §Console growth slate` and is deliberately absent, which is what this
 * list exists to hold the fixture to: a scenario answering `browser.act` would read
 * as scripted behaviour and be a promise the wire has not made.
 */
const REGISTERED_CALL_NAMES: readonly string[] = ["session.list", "agent.list"];

describe("browser family — claiming the deck's browser pane", () => {
  it("claims the browser kind on terms the deck can hold it by", () => {
    const registry = new ConsolePaneRegistry();
    registerBrowserPanes(registry);
    const descriptor = registry.descriptorFor("browser");
    expect(descriptor?.kind).toBe("browser");
    expect(descriptor?.owner).toBe("browser");
    // Kind and owner are the whole registration: whether the kind may be torn off
    // is the window model's answer, and `seats/pane-kinds.test.ts` holds it.
  });

  it("composes into the registry it is handed, never a module-scope one", () => {
    const claimed = new ConsolePaneRegistry();
    const untouched = new ConsolePaneRegistry();
    registerBrowserPanes(claimed);
    expect(claimed.registeredPaneKinds()).toStrictEqual(["browser"]);
    expect(untouched.registeredPaneKinds()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerBrowserPanes(registry);
      registerBrowserPanes(registry);
    }).not.toThrow();
  });

  it("negative control: a second owner claiming the kind is refused, not swapped", () => {
    // Without this, every case above would pass over a registry whose duplicate
    // policy was "last writer wins" — and which body mounted would then depend on
    // module evaluation order rather than on anyone's decision.
    const registry = new ConsolePaneRegistry();
    registerBrowserPanes(registry);
    expect(() => {
      registry.register({
        kind: "browser",
        owner: "some-other-family",
        render: () => null,
      });
    }).toThrow();
  });
});

describe("browser scenario — scripted only against registered methods", () => {
  it("is the scenario the seat board names", () => {
    expect(BROWSER_SCENARIO.id).toBe(BROWSER_SCENARIO_ID);
    // Non-empty, or every quantified case below is a claim about nothing.
    expect(BROWSER_SCENARIO.beats.length).toBeGreaterThan(0);
    expect(BROWSER_SCENARIO.replies.length).toBeGreaterThan(0);
  });

  it("calls no method the corpus has not registered", () => {
    for (const reply of BROWSER_SCENARIO.replies) {
      expect(REGISTERED_CALL_NAMES).toContain(reply.call);
    }
  });

  it("negative control: an unregistered browser wire would be caught", () => {
    // The case above would pass over an allow-list that contained everything. This
    // is the exact string the browser pane wants and does not have.
    expect(REGISTERED_CALL_NAMES).not.toContain("browser.act");
  });
});
