// The browser family's registration terms, and the fixture it is registered against.
//
// Two claims, and neither is about what the pane looks like — that is
// `panes/browser/BrowserPane.test.tsx`'s. Here: the deck holds the pane on the
// terms the descriptor states, and the scenario the fixture plays names no wire the
// corpus has not registered. The second is the one worth a test rather than a
// review: a fabricated method string or event type in a fixture is invisible until
// the day the real one lands and disagrees with it.

import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO, BROWSER_SCENARIO_ID } from "../bridge/scenarios/browser.js";
import { ConsolePaneRegistry } from "../workspace/index.js";
import { registerBrowserPanes } from "./index.js";

/**
 * Event kinds and call names this fixture is allowed to script.
 *
 * Every entry is registered somewhere in the corpus today: the four session and run
 * lifecycle types in `Spec-006`'s taxonomy, and the two opening reads `first-run.ts`
 * already scripts. The browser namespace is on `Plan-023 §Console growth slate` and
 * is deliberately absent, which is what this list exists to hold it to.
 */
const REGISTERED_EVENT_KINDS: readonly string[] = [
  "session.created",
  "participant.joined",
  "agent.attached",
  "run.queued",
  "run.running",
];

const REGISTERED_CALL_NAMES: readonly string[] = ["session.list", "agent.list"];

describe("browser family — claiming the deck's browser pane", () => {
  it("claims the browser kind on terms the deck can hold it by", () => {
    const registry = new ConsolePaneRegistry();
    registerBrowserPanes(registry);
    const descriptor = registry.descriptorFor("browser");
    expect(descriptor?.kind).toBe("browser");
    expect(descriptor?.owner).toBe("browser");
    // Not a default and not provisional: the pane's eventual body is a
    // main-process view, and no mechanism moves one between windows.
    expect(descriptor?.openInWindow).toBe(false);
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
        openInWindow: true,
      });
    }).toThrow();
  });
});

describe("browser scenario — scripted only against registered wires", () => {
  it("is the scenario the seat board names", () => {
    expect(BROWSER_SCENARIO.id).toBe(BROWSER_SCENARIO_ID);
    // Non-empty, or every quantified case below is a claim about nothing.
    expect(BROWSER_SCENARIO.beats.length).toBeGreaterThan(0);
    expect(BROWSER_SCENARIO.replies.length).toBeGreaterThan(0);
  });

  it("scripts no event kind and no call the corpus has not registered", () => {
    for (const beat of BROWSER_SCENARIO.beats) {
      expect(REGISTERED_EVENT_KINDS).toContain(beat.event.kind);
    }
    for (const reply of BROWSER_SCENARIO.replies) {
      expect(REGISTERED_CALL_NAMES).toContain(reply.call);
    }
  });

  it("delivers its beats in sequence order, at non-decreasing ticks", () => {
    const sequences = BROWSER_SCENARIO.beats.map((beat) => beat.event.sequence);
    expect(sequences).toStrictEqual([...sequences].sort((left, right) => left - right));
    const ticks = BROWSER_SCENARIO.beats.map((beat) => beat.atMs);
    expect(ticks).toStrictEqual([...ticks].sort((left, right) => left - right));
  });

  it("negative control: an unregistered browser wire would be caught", () => {
    // The two cases above would pass over allow-lists that contained everything.
    // These are the exact strings the browser pane wants and does not have.
    expect(REGISTERED_EVENT_KINDS).not.toContain("browser.page_opened");
    expect(REGISTERED_CALL_NAMES).not.toContain("browser.act");
  });
});
