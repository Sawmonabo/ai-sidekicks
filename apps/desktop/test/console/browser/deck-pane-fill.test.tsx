// Whether a pane fills the slot the deck gives it, in the arrangement the deck
// actually uses.
//
// THE RULE, AND WHY IT HAD NO CASE. `seats/pane-chrome.css`' `.meridian-pane` is a
// column flex container with `min-height: 0` and no `flex` and no `height`, so its
// used `flex` is the initial `0 1 auto`. Under a GRID parent that is harmless — a grid
// item stretches to its area — and under a COLUMN FLEX parent it is decisive: `0` grow
// means the section never takes its slot and is sized by its content instead. The deck
// is a column flex chain (`workspace/deck/deck.css`), so every pane the deck mounts was
// content-sized, while `terminal-pane-box.test.tsx` — the one case that measures a pane
// against a slot — builds its harness as a grid and says so in its own comment. Both
// paths ship; only the grid one was covered.
//
// WHAT IT COST, AND WHAT IT DID NOT. A pane sized by its content hands the ledger's
// scroll surface a box a fraction of the deck's height, and the virtualizer ranges
// against that box — measured here at 200 px of a 600 px slot. It is deliberately NOT
// the endurance tier's 149 px viewport: that reading survives this repair, because the
// composer takes 463 px of that window and the ledger's share is what is left. Two
// defects on one chain, and crediting this one with the other's symptom would have
// retired the wrong one. At the limit — a first commit with no rows yet — the same
// chain settles at zero and stays there, which is the fixed point
// `viewport-first-commit.test.tsx` describes and cannot itself reach, because it mounts
// a viewport rather than a pane.
//
// THE SUBJECT IS A PANE KIND, NOT THIS PANE KIND. `.meridian-pane` is one sheet for
// every kind, so the rule is about the frame and the terminal pane is only the cheapest
// body to hang it on — it is the kind that already publishes a context builder beside
// it. A ledger pane would measure the same section under the same rule.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { TerminalPane } from "../../../src/renderer/src/console/terminal/pane/TerminalPane.js";
import { terminalPaneContext } from "../../../src/renderer/src/console/terminal/pane/TerminalPane.test-support.js";
// Two family doors, imported for their side effect: `apps/desktop/AGENTS.md` puts a
// family's stylesheet behind its own barrel, and this tier is about what those
// stylesheets compute to. The workspace door carries `deck.css`, which is the half of
// the arrangement under test that is not the pane's own.
import "../../../src/renderer/src/console/terminal/index.js";
import "../../../src/renderer/src/console/workspace/index.js";
import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";

/** The deck's own height. Every assertion below is against this one number. */
const DECK_HEIGHT_PX = 600;

/**
 * How `react-resizable-panels` lays its group out.
 *
 * Written here rather than taken from the library because the library writes it
 * INLINE at runtime and this tier is measuring CSS: `workspace/workspace.css` records
 * that the group's `display`, `flex-direction` and `overflow` are the library's, and
 * the only property of that arrangement this case depends on is that the group is a
 * ROW — which is what makes the pane slot inside it stretch vertically.
 */
const RESIZABLE_GROUP_LAYOUT = { display: "flex", flexDirection: "row" } as const;

interface MountedDeckPane {
  readonly slot: HTMLElement;
  readonly pane: HTMLElement;
}

async function mountPaneInDeckSlot(): Promise<MountedDeckPane> {
  installMeridianTokens(document);
  const bridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  const { container } = await renderSettled(
    <div className="meridian-deck" style={{ height: `${String(DECK_HEIGHT_PX)}px` }}>
      <div className="meridian-deck__group" style={RESIZABLE_GROUP_LAYOUT}>
        <div className="meridian-deck__pane">
          <TerminalPane {...terminalPaneContext(undefined, bridge)} />
        </div>
      </div>
    </div>,
  );
  const slot = container.querySelector(".meridian-deck__pane");
  const pane = container.querySelector(".meridian-pane");
  if (!(slot instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
    throw new Error("the pane did not mount into a deck slot");
  }
  return { slot, pane };
}

/** The same pane under the arrangement that always worked, for the control below. */
async function mountPaneInGridSlot(): Promise<MountedDeckPane> {
  installMeridianTokens(document);
  const bridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  const { container } = await renderSettled(
    <div style={{ display: "grid", height: `${String(DECK_HEIGHT_PX)}px` }}>
      <TerminalPane {...terminalPaneContext(undefined, bridge)} />
    </div>,
  );
  const slot = container.firstElementChild;
  const pane = container.querySelector(".meridian-pane");
  if (!(slot instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
    throw new Error("the pane did not mount into a grid slot");
  }
  return { slot, pane };
}

describe("browser — a pane fills the slot the deck gives it", () => {
  it("takes the whole slot height in the deck's column-flex arrangement", async () => {
    const { slot, pane } = await mountPaneInDeckSlot();

    expect(slot.getBoundingClientRect().height).toBe(DECK_HEIGHT_PX);
    expect(
      pane.getBoundingClientRect().height,
      "the pane is sized by its content rather than by its slot, so every box below it — the ledger's scroll surface included — is measuring against a height the deck never gave it",
    ).toBe(DECK_HEIGHT_PX);
  });

  it("still fills a grid slot, which is the arrangement that already worked", async () => {
    // The control that keeps the rule about GROWING rather than about a height: a
    // pane handed `height: 100%` would satisfy the case above and would break here
    // the moment a slot stopped being the full height of its own parent. It also
    // pins that the flex path's repair leaves the grid path exactly where it was —
    // `flex` is inert on a grid item, so this case must not move.
    const { slot, pane } = await mountPaneInGridSlot();

    expect(slot.getBoundingClientRect().height).toBe(DECK_HEIGHT_PX);
    expect(pane.getBoundingClientRect().height).toBe(DECK_HEIGHT_PX);
  });

  it("negative control: a pane in a column-flex box with no height hugs its content", async () => {
    // Without this the two cases above would pass over a `.meridian-pane` that had
    // simply been given a height, and the claim being made is the opposite one: the
    // pane takes what its slot HAS, and a slot with nothing to give leaves it at its
    // content. This is also the shape the defect wore — the deck's slot did have a
    // height, and the pane was reading it as though it did not.
    installMeridianTokens(document);
    const bridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
    const { container } = await renderSettled(
      <div style={{ display: "flex", flexDirection: "column" }}>
        <TerminalPane {...terminalPaneContext(undefined, bridge)} />
      </div>,
    );
    const pane = container.querySelector(".meridian-pane");
    if (!(pane instanceof HTMLElement)) {
      throw new Error("the pane did not mount");
    }

    expect(pane.getBoundingClientRect().height).toBeLessThan(DECK_HEIGHT_PX);
  });
});
