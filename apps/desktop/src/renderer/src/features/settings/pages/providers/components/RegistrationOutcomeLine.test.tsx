// A pasted token the keychain would not take reads its cause's own line under one title, and never
// the service's sentence, which names neither the cause nor the way on.

import { PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE } from "@ai-sidekicks/contracts/provider/account/sign-in";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { RegistrationOutcomeLine } from "./RegistrationOutcomeLine.js";

afterEach(() => {
  cleanup();
});

/** What the slot draws for a seal the keychain refused for `cause`. */
function drawnForSealRefusedBy(cause: string): string {
  const refusal: ExtendedRefusal = {
    ...refuse("daemon", PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE, "The service's own words."),
    cause,
  };
  const { container } = render(
    <LiveAnnouncerProvider>
      <RegistrationOutcomeLine outcome={{ kind: "refused", refusal }} secretsPlace="keychain" />
    </LiveAnnouncerProvider>,
  );
  const lines = [...container.querySelectorAll(".meridian-settings-page__state--failed p")];
  return lines.map((line) => line.textContent).join(" / ");
}

describe("RegistrationOutcomeLine — a token the keychain would not take", () => {
  it("draws each cause's line under the title, never the service's words", () => {
    expect(drawnForSealRefusedBy("locked")).toBe(
      "Token not saved / Unlock the keychain, then try again.",
    );
    cleanup();
    expect(drawnForSealRefusedBy("unavailable")).toBe(
      "Token not saved / Secrets cannot be used right now. See Settings › Runtime.",
    );
  });
});
