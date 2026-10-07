// The refusal is never suppressed, and the handoff never becomes an act.

import type {
  ProviderAccountId,
  ProviderLoginExpiredRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refuse } from "#renderer/lib/refusal/contract.js";
import { ACCOUNT_PLANE_REMEDY_SENTENCES } from "#renderer/lib/provider-accounts/sentences.js";
import { AccountPlaneRefusal } from "./AccountPlaneRefusal.js";

afterEach(() => {
  cleanup();
});

function renderRefusal(
  code: string,
  carriedRemedy?: ProviderLoginExpiredRemedy,
): { readonly container: HTMLElement; readonly openPage: ReturnType<typeof vi.fn> } {
  const openPage = vi.fn();
  const { container } = render(
    <AccountPlaneRefusal
      refusal={refuse("provider-account", code, "The daemon's own sentence, unchanged.")}
      provider="claude"
      carriedRemedy={carriedRemedy}
      openPage={openPage}
    />,
  );
  return { container, openPage };
}

describe("an account-plane refusal on a console screen", () => {
  it("renders the daemon's code and sentence before anything it adds", () => {
    const { container } = renderRefusal("provideraccount.not_registered");
    const text = container.textContent ?? "";
    expect(text.indexOf("provideraccount.not_registered")).toBeLessThan(
      text.indexOf("Sign in to run work on this provider."),
    );
    expect(text).toContain("The daemon's own sentence, unchanged.");
  });

  it("offers one navigation, and moving is all pressing it does", () => {
    const { container, openPage } = renderRefusal("provideraccount.no_default");
    const actions = container.querySelectorAll<HTMLButtonElement>(
      ".meridian-account-handoff__action",
    );
    expect(actions).toHaveLength(1);
    actions[0]?.click();
    expect(openPage.mock.calls).toStrictEqual([["providers"]]);
  });

  it("offers a refused account move the remedy that account carries, and none without it", () => {
    const tokenAccount = renderRefusal("provideraccount.not_authenticated", {
      kind: "paste_token",
      accountId: "pa-0001" as ProviderAccountId,
    });
    const tokenText = tokenAccount.container.textContent ?? "";
    expect(tokenText).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.paste_token("claude"));
    expect(tokenText).not.toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.sign_in("claude"));
    cleanup();
    const uncarried = renderRefusal("provideraccount.not_authenticated");
    expect(uncarried.container.querySelector(".meridian-account-handoff")).toBeNull();
  });
});
