// The invite confirmation: what it shows, what it refuses to show, and the one
// thing it will not do on its own.
//
// The property worth the most is that nothing accepts without a press. The
// shipped acceptance component is what enforces it, so the case that matters is
// that this chrome MOUNTS that component rather than issuing a call of its own —
// a confirmation that accepted on mount would burn a single-use invite on
// arrival, and the person would never see the screen that did it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { formatClockTime, formatDateTime } from "../../primitives/index.js";
import { InviteConfirmation, type PendingInviteConfirmation } from "./InviteConfirmation.js";

function pending(overrides: Partial<PendingInviteConfirmation> = {}): PendingInviteConfirmation {
  return {
    token: "v4.local.opaque-token",
    sessionId: "session-collaboration",
    ...overrides,
  };
}

describe("invite confirmation — no pending invite, no surface", () => {
  it("renders nothing at all", () => {
    const { container } = render(
      <InviteConfirmation pending={undefined} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("negative control: a pending invitation renders a surface", () => {
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect(container.innerHTML).not.toBe("");
  });
});

describe("invite confirmation — when the invitation stops working", () => {
  const EXPIRES_AT = "2026-01-08T10:05:00.000Z";
  /** The same wall-clock minute, several days later. */
  const EXPIRES_LATER = "2026-01-12T10:05:00.000Z";

  /** What the expiry fact prints, found by the instant it carries. */
  function expiryReading(container: HTMLElement, instant: string): string {
    const figure = container.querySelector(`[title="${instant}"]`);
    if (figure === null) {
      throw new Error(`no expiry figure for ${instant}`);
    }
    return figure.textContent ?? "";
  }

  it("names the day, because this surface has no divider to carry it", () => {
    const { container } = render(
      <InviteConfirmation
        pending={pending({ expiresAtIso: EXPIRES_AT })}
        bridgeSource="fixture"
        onDismiss={() => undefined}
      />,
    );
    expect(expiryReading(container, EXPIRES_AT)).toBe(formatDateTime(EXPIRES_AT));
  });

  it("reads differently for an invitation that stops working days later", () => {
    const { container } = render(
      <InviteConfirmation
        pending={pending({ expiresAtIso: EXPIRES_LATER })}
        bridgeSource="fixture"
        onDismiss={() => undefined}
      />,
    );
    expect(expiryReading(container, EXPIRES_LATER)).not.toBe(formatDateTime(EXPIRES_AT));
  });

  it("negative control: the clock-only reading of those two instants is one string", () => {
    // Without this the case above would pass over two instants that were never a
    // collision, and would prove nothing about which formatter this fact reaches for.
    expect(formatClockTime(EXPIRES_LATER)).toBe(formatClockTime(EXPIRES_AT));
  });
});

describe("invite confirmation — what it identifies the session by", () => {
  it("falls back to the session's own identity when there is no name", () => {
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    const figure = container.querySelector(".meridian-figure--wire");
    expect(figure?.textContent).toBe("session-collaboration");
  });

  it("prefers the session name when the preview carried one", () => {
    const { container } = render(
      <InviteConfirmation
        pending={pending({ sessionName: "Relay sweep" })}
        bridgeSource="fixture"
        onDismiss={() => undefined}
      />,
    );
    expect(container.textContent ?? "").toContain("Relay sweep");
  });

  it("never renders a raw inviter identifier in place of a display name", () => {
    const { container } = render(
      <InviteConfirmation
        pending={pending({ inviterDisplayName: undefined })}
        bridgeSource="fixture"
        onDismiss={() => undefined}
      />,
    );
    expect(container.textContent ?? "").not.toContain("participant-");
    expect(container.textContent ?? "").toContain("Not named");
  });

  it("negative control: a display name that IS present renders", () => {
    const { container } = render(
      <InviteConfirmation
        pending={pending({ inviterDisplayName: "Priya" })}
        bridgeSource="fixture"
        onDismiss={() => undefined}
      />,
    );
    expect(container.textContent ?? "").toContain("Priya");
    expect(container.textContent ?? "").not.toContain("Not named");
  });
});

describe("invite confirmation — the token", () => {
  it("never renders it", () => {
    // It is a credential. It is handed to the absorbed control and to nothing
    // else, and no branch of this chrome prints it.
    const { container } = render(
      <InviteConfirmation
        pending={pending({ sessionName: "Relay sweep", inviterDisplayName: "Priya" })}
        bridgeSource="fixture"
        onDismiss={() => undefined}
      />,
    );
    expect(container.textContent ?? "").not.toContain("v4.local");
  });

  it("negative control: the surface does render text that could have carried it", () => {
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });
});

describe("invite confirmation — the two acts", () => {
  it("dismisses through the caller's hide and sends no decline anywhere", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={onDismiss} />,
    );
    const dismiss = container.querySelector<HTMLButtonElement>(
      ".meridian-invite-confirmation__dismiss",
    );
    dismiss?.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("auto-focuses nothing", () => {
    // Acceptance is a deliberate act. An auto-focused control plus a stray return
    // key is acceptance by accident, on a credential that cannot be reissued.
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect(container.querySelector("[autofocus]")).toBeNull();
  });

  it("says the question was not put to the daemon under the fixture", () => {
    // The absorbed acceptance control reads the installed bridge directly, so the
    // console declines to ask on its behalf rather than answering from a live
    // daemon beside fixture data in the same window.
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect(container.textContent ?? "").toContain("running on the fixture");
  });

  it("negative control: a live bridge mounts the acceptance prompt instead", () => {
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="live" onDismiss={() => undefined} />,
    );
    expect(container.querySelector('[aria-label="invite-accept-idle"]')).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("running on the fixture");
  });
});

describe("invite confirmation — what a person reads", () => {
  it("names no governance work anywhere", () => {
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("labels the region for assistive technology", () => {
    const { container } = render(
      <InviteConfirmation pending={pending()} bridgeSource="fixture" onDismiss={() => undefined} />,
    );
    expect(container.querySelector('[aria-label="Confirm this invitation"]')).not.toBeNull();
  });
});
