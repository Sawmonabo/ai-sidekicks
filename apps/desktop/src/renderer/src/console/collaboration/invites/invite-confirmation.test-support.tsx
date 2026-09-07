// The cast both confirmation suites drive the card with.
//
// Hoisted on this package's second-use rule the moment the preview-failure readings
// moved to a file of their own: three helpers — how the card is rendered at all, how
// one control is reached, and what the whole act row says — and two suites that each
// need every one of them. A second `renderCard` is two suites disagreeing about which
// props the card is mounted with, which is exactly the disagreement a portalled dialog
// hides: the second copy renders into a container the first case never queries.

import { render } from "@testing-library/react";

import { InviteConfirmation } from "./InviteConfirmation.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import { pendingInviteSnapshot } from "./pending-invite.test-support.js";

/** What a case may steer about the acts the card is given. */
export interface InviteConfirmationActs {
  readonly open?: boolean;
  readonly onConfirm?: () => void;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
  readonly onAcknowledge?: () => void;
}

/** The card, portalled into the test's own container so a case can query it. */
export function renderCard(
  overrides: Partial<PendingInviteSnapshot> = {},
  acts: InviteConfirmationActs = {},
): HTMLElement {
  const { container } = render(
    <InviteConfirmation
      open={acts.open ?? true}
      snapshot={pendingInviteSnapshot(overrides)}
      onConfirm={acts.onConfirm ?? (() => undefined)}
      onRetry={acts.onRetry ?? (() => undefined)}
      onDismiss={acts.onDismiss ?? (() => undefined)}
      onAcknowledge={acts.onAcknowledge ?? (() => undefined)}
      overlayContainer={document.body}
    />,
  );
  return container.ownerDocument.body;
}

export function control(root: HTMLElement, className: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`.${className}`);
  if (found === null) {
    throw new Error(`no ${className}`);
  }
  return found;
}

/**
 * The controls an outcome report offers, by class name.
 *
 * Asserted as the WHOLE row rather than as the absence of one name: a case that only
 * checked a retry control was gone would pass just as well over a report that had
 * been given a different second control, and over one that offered nothing at all.
 */
export function outcomeActs(root: HTMLElement): readonly string[] {
  return [...root.querySelectorAll(".meridian-invite-outcome__acts button")].map(
    (button) => button.className,
  );
}
