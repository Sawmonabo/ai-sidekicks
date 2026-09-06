// The browser tier: an invitation waiting is a modal decision, and the keyboard proves
// it.
//
// WHY THIS CANNOT LIVE IN THE UNIT TIER, which is the whole reason the file exists.
// `console-unit` runs happy-dom, which has no focus-trap semantics at all: Tab moves
// nothing, `document.activeElement` is whatever `focus()` last named, and every
// element is focusable whether the page thinks so or not. So a confirmation whose trap
// had silently stopped working — a portal rendered outside the popup, a control the
// trap does not know about, a popup that never took focus — passes every unit case
// that presses Tab, and in a real browser the next Tab walks out of the card and onto
// the session controls behind it.
//
// AND WHY THAT MATTERS HERE RATHER THAN ON ANY DIALOG. What is behind this card is the
// members section of a session this window IS in, with its own controls; what is on it
// is a single-use invitation to a session this window is NOT in. A keyboard that
// crosses between them while the decision is open puts a press meant for one session
// on a control belonging to another — and the accepting control is the one press that
// cannot be taken back.
//
// THE ESCAPE CASE IS HERE FOR THE SAME REASON AND NOT AS A DUPLICATE. The unit tier
// asserts that Escape reaches `onOpenChange`; this asserts that a real browser's
// keydown, dispatched at the document by a person rather than by `fireEvent` at the
// popup, is what reaches it.

import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../console-harness.js";

import { InviteConfirmation } from "../../../src/renderer/src/console/collaboration/invites/InviteConfirmation.js";
import { pendingInviteSnapshot } from "../../../src/renderer/src/console/collaboration/invites/pending-invite.test-support.js";

/** The three controls the card offers before an answer, in tree order. */
const CARD_CONTROL_SELECTORS: readonly string[] = [
  ".meridian-invite-confirmation__dismiss",
  ".meridian-invite-confirmation__confirm",
  ".meridian-invite-confirmation__discard",
];

/** The class the planted control behind the card carries. Never inside the popup. */
const BEHIND_THE_CARD = "session-control-behind-the-card";

/**
 * The card, with one control planted behind it.
 *
 * The control behind is what makes the claim checkable: a trap asserted only over the
 * card's own controls is satisfied by a page with nothing else on it, which is not the
 * page this card opens over.
 */
async function renderCardOverASessionControl(
  onOpenChange: (open: boolean) => void = () => undefined,
): Promise<void> {
  await renderSettled(
    <>
      <button type="button" className={BEHIND_THE_CARD}>
        Leave this session
      </button>
      <InviteConfirmation
        open
        onOpenChange={onOpenChange}
        snapshot={pendingInviteSnapshot()}
        onConfirm={() => undefined}
        onRetry={() => undefined}
        onDiscard={() => undefined}
        onAcknowledge={() => undefined}
      />
    </>,
  );
}

/** Whatever holds the page's focus, as an element. */
function focused(): Element {
  const active = document.activeElement;
  if (active === null) {
    throw new Error("nothing holds the focus");
  }
  return active;
}

function matches(selector: string): boolean {
  return focused().matches(selector);
}

describe("the invite confirmation is modal in a real browser", () => {
  it("opens with the focus on the control that puts it away", async () => {
    // Never the accepting one: the card names `initialFocus` on the dismissal so a
    // stray return key cannot spend a single-use invitation, and only an engine that
    // actually moves the focus can report whether that held.
    await renderCardOverASessionControl();

    expect(matches(CARD_CONTROL_SELECTORS[0] ?? "")).toBe(true);
  });

  it("keeps the keyboard on the card, never on the session behind it", async () => {
    await renderCardOverASessionControl();

    // MORE PRESSES THAN THE CARD HAS CONTROLS, so the sequence wraps at least twice: a
    // trap is a claim about the press AFTER the last control, and a loop that stopped
    // there would never make it. What is collected is where the focus LANDED and not
    // the order it landed in — the order is the dialog library's, and pinning it here
    // would make this case fail on an internal focus guard rather than on the property
    // it is about.
    const landings = new Set<string>();
    for (let press = 0; press < CARD_CONTROL_SELECTORS.length * 3; press += 1) {
      for (const selector of [...CARD_CONTROL_SELECTORS, `.${BEHIND_THE_CARD}`]) {
        if (matches(selector)) {
          landings.add(selector);
        }
      }
      await pressKeys("{Tab}");
    }

    expect(landings.has(`.${BEHIND_THE_CARD}`)).toBe(false);
    expect([...landings].sort()).toStrictEqual([...CARD_CONTROL_SELECTORS].sort());
  });

  it("negative control: that control IS reachable with no invitation waiting", async () => {
    // Without this the case above would pass over a page whose planted control was
    // unreachable for some reason of its own — a disabled attribute, a missing tab
    // stop — rather than because the card was holding the keyboard.
    await renderSettled(
      <button type="button" className={BEHIND_THE_CARD}>
        Leave this session
      </button>,
    );
    await pressKeys("{Tab}");

    expect(matches(`.${BEHIND_THE_CARD}`)).toBe(true);
  });

  it("puts the card away on a real Escape press", async () => {
    let openState = true;
    await renderCardOverASessionControl((open) => {
      openState = open;
    });
    await pressKeys("{Escape}");

    expect(openState).toBe(false);
  });
});
