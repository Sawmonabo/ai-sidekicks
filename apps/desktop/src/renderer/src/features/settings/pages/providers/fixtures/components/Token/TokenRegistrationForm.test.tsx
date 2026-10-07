// Where the registration form answers a refusal: a name another account of the provider has is
// answered under the `Name` field in the form's own words, whether the form's check or the service
// refused it; every other refusal keeps the slot under the form.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE,
  PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE,
  type ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts/provider/account/sign-in";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "#renderer/components/LiveAnnouncer/caps.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { account } from "#renderer/lib/provider-binding/account/reading.test-support.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { settle } from "#test/helpers/settle.js";
import { TokenRegistrationForm } from "./TokenRegistrationForm.js";

afterEach(() => {
  cleanup();
});

/** A register call the service refuses with `code`, in its own words. */
function registerRefusedWith(code: string): () => Promise<ProviderAccountRegisterResponse> {
  return () => Promise.reject(new RefusalError(refuse("daemon", code, "The service's own words.")));
}

/** Open the form, fill both fields and submit, then let the refusal land. */
async function submitRefusedWith(code: string): Promise<HTMLInputElement> {
  const { getByRole, getByLabelText } = render(
    <TokenRegistrationForm register={registerRefusedWith(code)} provider="codex" accounts={[]} />,
    { wrapper: LiveAnnouncerProvider },
  );
  fireEvent.click(getByRole("button", { name: "Paste a token instead" }));
  const nameField = getByLabelText("Name");
  if (!(nameField instanceof HTMLInputElement)) {
    throw new Error("the registration form drew no Name field");
  }
  fireEvent.change(nameField, { target: { value: "Metered" } });
  fireEvent.change(getByLabelText("Paste the token you minted at the provider."), {
    target: { value: "a-token" },
  });
  fireEvent.submit(nameField.form ?? nameField);
  await settle();
  return nameField;
}

/** The line the `Name` field is described by, or `undefined` where it carries none. */
function lineUnderName(nameField: HTMLInputElement): string | undefined {
  const describedBy = nameField.getAttribute("aria-describedby");
  return describedBy === null
    ? undefined
    : (nameField.ownerDocument.getElementById(describedBy)?.textContent ?? undefined);
}

describe("TokenRegistrationForm — a refused name", () => {
  it("answers the service's taken-name refusal under the Name field in the form's words", async () => {
    const nameField = await submitRefusedWith(PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE);
    expect(lineUnderName(nameField)).toBe("Another Codex account already has this name.");
    expect(liveRegionText(nameField.ownerDocument.body, "assertive")).toBe(
      "Another Codex account already has this name.",
    );
    expect(nameField.getAttribute("aria-invalid")).toBe("true");
    expect(nameField.form?.textContent).not.toContain("The service's own words.");
  });

  it("negative control: a refused token stays in the slot under the form, not under Name", async () => {
    const nameField = await submitRefusedWith(PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE);
    expect(lineUnderName(nameField)).toBeUndefined();
    expect(nameField.form?.textContent).toContain("The provider did not accept that token.");
  });
});

describe("TokenRegistrationForm — a refusal pressed into twice", () => {
  it("says the form's own taken-name refusal again on the second press", () => {
    // The form's check answers in the same pass, so the line stays drawn with the same words
    // between the presses; only the press can tell the announcer it is a new refusal.
    const clock = new ManualClock(0);
    const { getByRole, getByLabelText, container } = render(
      <LiveAnnouncerProvider clock={clock}>
        <TokenRegistrationForm
          register={registerRefusedWith(PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE)}
          provider="codex"
          accounts={[account({ provider: "codex", displayLabel: "Metered" })]}
        />
      </LiveAnnouncerProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Paste a token instead" }));
    const nameField = getByLabelText("Name");
    if (!(nameField instanceof HTMLInputElement) || nameField.form === null) {
      throw new Error("the registration form drew no Name field");
    }
    const form = nameField.form;
    fireEvent.change(nameField, { target: { value: "Metered" } });
    const press = (): void => {
      fireEvent.submit(form);
    };
    const said: string[] = [];

    press();
    said.push(liveRegionText(container, "assertive"));
    act(() => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
    });
    said.push(liveRegionText(container, "assertive"));
    press();
    said.push(liveRegionText(container, "assertive"));

    const taken = "Another Codex account already has this name.";
    expect(said).toStrictEqual([taken, "", taken]);
  });
});
