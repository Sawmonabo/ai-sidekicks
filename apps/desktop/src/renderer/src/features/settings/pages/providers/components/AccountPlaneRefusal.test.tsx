// The refusal is never suppressed, and the handoff never becomes an act.

import type {
  ProviderAccountId,
  ProviderLoginExpiredRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refuse } from "#renderer/lib/refusal/contract.js";
import { ACCOUNT_PLANE_REMEDY_SENTENCES } from "#renderer/lib/provider-accounts/sentences.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { AccountPlaneRefusal } from "./AccountPlaneRefusal.js";

const DAEMON_SENTENCE = "The daemon's own sentence, unchanged.";

afterEach(() => {
  cleanup();
});

function renderRefusal(
  code: string,
  carriedRemedy?: ProviderLoginExpiredRemedy,
): {
  /** The refusal as drawn, apart from the announcer's regions. */
  readonly shown: HTMLElement;
  /** What the announcer's assertive lane says. */
  readonly announced: () => string;
  readonly openPage: ReturnType<typeof vi.fn>;
} {
  const openPage = vi.fn();
  const { container } = render(
    <div className="account-plane-refusal-under-test">
      <AccountPlaneRefusal
        refusal={refuse("provider-account", code, DAEMON_SENTENCE)}
        provider="claude"
        carriedRemedy={carriedRemedy}
        openPage={openPage}
      />
    </div>,
    { wrapper: LiveAnnouncerProvider },
  );
  const shown = container.querySelector<HTMLElement>(".account-plane-refusal-under-test");
  if (shown === null) {
    throw new Error("the refusal was not drawn");
  }
  return { shown, announced: () => liveRegionText(container, "assertive"), openPage };
}

describe("an account-plane refusal on a console screen", () => {
  it("renders the daemon's sentence before anything it adds, and reads both out in that order", () => {
    const { shown, announced } = renderRefusal("provideraccount.not_registered");
    const remedy = "Sign in to run work on this provider.";
    const text = shown.textContent;
    expect(text.indexOf(DAEMON_SENTENCE)).toBe(0);
    expect(text.indexOf(DAEMON_SENTENCE)).toBeLessThan(text.indexOf(remedy));
    // The remedy is read out as drawn, after the reason; the button beside it is not.
    const drawnRemedy = shown.querySelector(".meridian-account-handoff__sentence")?.textContent;
    expect(drawnRemedy).toContain(remedy);
    expect(announced()).toBe(`${DAEMON_SENTENCE} ${drawnRemedy ?? ""}`);
  });

  it("offers one navigation, and moving is all pressing it does", () => {
    const { shown, openPage } = renderRefusal("provideraccount.no_default");
    const actions = shown.querySelectorAll<HTMLButtonElement>(".meridian-account-handoff__action");
    expect(actions).toHaveLength(1);
    actions[0]?.click();
    expect(openPage.mock.calls).toStrictEqual([["providers"]]);
  });

  it("offers a refused account move the remedy that account carries, and none without it", () => {
    const tokenAccount = renderRefusal("provideraccount.not_authenticated", {
      kind: "paste_token",
      accountId: "pa-0001" as ProviderAccountId,
    });
    const tokenText = tokenAccount.shown.textContent;
    expect(tokenText).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.paste_token("claude"));
    expect(tokenText).not.toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.sign_in("claude"));
    cleanup();
    const uncarried = renderRefusal("provideraccount.not_authenticated");
    expect(uncarried.shown.querySelector(".meridian-account-handoff")).toBeNull();
    expect(uncarried.announced()).toBe(DAEMON_SENTENCE);
  });
});
