import { Menu } from "@base-ui/react/menu";

import { SESSION_PIN_TIERS, type SessionPinTier } from "./rows/session-rows.js";

/**
 * How each tier reads as a destination, and what it is called when a row is already
 * in it.
 *
 * Derived over the closed tier set rather than written as two items, so a third tier
 * arrives in this menu by existing rather than by somebody remembering to add it —
 * and the "already here" wording is what keeps the menu from offering a move that
 * would do nothing.
 */
const TIER_MOVE_LABELS: Readonly<Record<SessionPinTier, string>> = {
  front: "Pin to the front tier",
  back: "Move to the back tier",
};

const TIER_RESTING_LABELS: Readonly<Record<SessionPinTier, string>> = {
  front: "Pinned to the front tier",
  back: "In the back tier",
};

/**
 * One row's context menu: where this session sits, and where it can go.
 *
 * WHY A MENU AND NOT THE TOGGLE IT REPLACES. The single toggle was correct about the
 * ACT — with two tiers, "unpin" and "move to the back tier" are the same move — and
 * wrong about the SURFACE: what a person could see was one word whose meaning
 * depended on a state the row never showed, so "Pin" and "Unpin" were the only
 * evidence of which tier the row was in and the evidence disappeared the moment the
 * pointer left. The menu states where the row IS and offers the move as a separate
 * item, which is the design's own row context menu carrying pin, move-to-tier, and
 * unpin.
 *
 * KEYBOARD-REACHABLE BY CONSTRUCTION. Base UI's menu owns the trigger's
 * `aria-haspopup` / `aria-expanded`, the popup's roles, arrow-key navigation,
 * typeahead, Escape, outside press, and returning focus to the trigger on close. The
 * trigger is revealed on hover and on `:focus-within` through the stylesheet and is
 * never removed from the tab order, because a control a pointer can reach and a
 * keyboard cannot is not a control.
 */
export function SessionRowMenu(props: {
  readonly sessionId: string;
  readonly tier: SessionPinTier;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}): React.JSX.Element {
  const { sessionId, tier } = props;
  return (
    <Menu.Root>
      <Menu.Trigger
        className="meridian-session-row__menu-trigger"
        aria-label={`Where ${sessionId} sits in the list`}
      >
        {tier === "front" ? "Pinned" : "Place"}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="meridian-session-row__menu-positioner" sideOffset={4}>
          <Menu.Popup className="meridian-session-row__menu">
            {/* Where the row is, stated rather than implied by which move is on
                offer. A menu that listed only the move left "which tier am I in"
                answerable solely by reading the label backwards. */}
            <Menu.Item
              className="meridian-session-row__menu-state"
              disabled
              // Rendered as an item so it sits inside the popup's own roles rather
              // than beside them, and disabled because it is a fact and not an act.
            >
              {TIER_RESTING_LABELS[tier]}
            </Menu.Item>
            {SESSION_PIN_TIERS.filter((candidate) => candidate !== tier).map((candidate) => (
              <Menu.Item
                key={candidate}
                className="meridian-session-row__menu-item"
                onClick={() => {
                  props.onSetTier(sessionId, candidate);
                }}
              >
                {TIER_MOVE_LABELS[candidate]}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
