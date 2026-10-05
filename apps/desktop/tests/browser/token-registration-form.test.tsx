// The browser tier: one settings claim a real engine decides and happy-dom cannot. The
// provider-account token field is never React state: it is read from a ref inside the submit
// handler and cleared in the same block. An uncontrolled input's value is the engine's, so
// whether the clear is what a person's browser holds is a question about its editing pipeline,
// which typing here goes through. A unit-tier copy of these cases would pass over the shape
// they refuse.

import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { userEvent } from "vitest/browser";

import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider-account";
import type { ProviderAccountRegisterResponse } from "@ai-sidekicks/contracts/provider-account-sign-in";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { TokenRegistrationForm } from "@renderer/features/settings/pages/providers/fixtures/components/TokenRegistrationForm.js";

/** A secret no fixture, scenario, or component copy could produce by accident. */
const TYPED_TOKEN = "zzq-never-echoed-token-8213";

/** The reply a registration gets: the account, and no token member at all. */
const REGISTERED: ProviderAccountRegisterResponse = {
  account: {
    accountId: "pa-0001" as ProviderAccountId,
    provider: "codex",
    displayLabel: "A machine account",
    credentialGeneration: 1,
    billingMode: "metered",
    isDefault: false,
    healthState: "indeterminate",
    healthObservedAt: null,
    observedAuthMode: null,
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
  },
};

/** A register call that answers with that reply, so the outcome line is drawn. */
const registerAnswering = (): Promise<ProviderAccountRegisterResponse> =>
  Promise.resolve(REGISTERED);

describe("browser — the provider-account token field is write-only in the engine", () => {
  /**
   * The registration form over a register call that answers, mounted as a window mounts it and
   * opened by its `Paste a token instead` press.
   */
  async function renderRegistrationForm(): Promise<HTMLElement> {
    const { container } = render(
      <LiveAnnouncerProvider>
        <TokenRegistrationForm register={registerAnswering} accounts={[]} />
      </LiveAnnouncerProvider>,
    );
    document.body.append(container);
    const open = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Paste a token instead",
    );
    if (open === undefined) {
      throw new Error("the registration form rendered no Paste a token instead press");
    }
    await act(async () => {
      await userEvent.click(open);
    });
    return container;
  }

  /** The token input, by the label the form gives it rather than by position. */
  function tokenFieldIn(container: HTMLElement): HTMLInputElement {
    const label = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === "Paste the token you minted at the provider.",
    );
    const field = label === undefined ? null : container.querySelector(`#${label.htmlFor}`);
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the registration form rendered no token field");
    }
    return field;
  }

  /** Fill the form the way a person does, then press its submit. */
  async function typeAndSubmit(
    container: HTMLElement,
    typedLabel = "A machine account",
  ): Promise<void> {
    const label = container.querySelector<HTMLInputElement>('input[type="text"]');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (label === null || submit === null) {
      throw new Error("the registration form rendered no name field or no submit");
    }
    // A real label is typed because the field is `required` and this engine refuses to submit
    // an empty required control. It runs inside `act` because these are real events, whose state
    // settles after the promise resolves.
    await act(async () => {
      await userEvent.fill(label, typedLabel);
      await userEvent.fill(tokenFieldIn(container), TYPED_TOKEN);
      await userEvent.click(submit);
      await crossMacrotaskBoundary();
    });
  }

  it("masks the value at the field rather than anywhere above it", async () => {
    const container = await renderRegistrationForm();
    const field = tokenFieldIn(container);
    expect(field.type).toBe("password");
    // Autofill would put the value back on a later mount, the one way a write-only field
    // acquires a value nobody typed into it.
    expect(field.autocomplete).toBe("off");
  });

  it("holds nothing after the submit that sent it", async () => {
    const container = await renderRegistrationForm();
    await typeAndSubmit(container);

    // The engine's own value after its editing pipeline ran: the handler read the ref, put it on
    // the request and cleared the input in the same block.
    expect(tokenFieldIn(container).value).toBe("");
    // The attribute is the other half: a `value` written into the markup would survive a
    // re-render even with the property cleared.
    expect(tokenFieldIn(container).getAttribute("value")).toBeNull();
  });

  it("puts the typed secret nowhere in the document after the submit", async () => {
    const container = await renderRegistrationForm();
    await typeAndSubmit(container);

    // Serialized markup first, the shape a crash report or a devtools copy captures.
    expect(document.body.innerHTML).not.toContain(TYPED_TOKEN);
    // Then every live value property, which serialization does not carry: an input's value is
    // engine state, not markup.
    for (const field of document.body.querySelectorAll("input, textarea, select")) {
      expect((field as HTMLInputElement).value).not.toContain(TYPED_TOKEN);
    }
    // And the rendered text, where an outcome line would echo it.
    expect(document.body.textContent ?? "").not.toContain(TYPED_TOKEN);
  });

  it("negative control: the typed value did reach the field before the submit", async () => {
    // Without this the cases above would pass over a form whose token input never received
    // anything.
    const container = await renderRegistrationForm();
    const field = tokenFieldIn(container);
    await act(async () => {
      await userEvent.fill(field, TYPED_TOKEN);
      await crossMacrotaskBoundary();
    });
    expect(field.value).toBe(TYPED_TOKEN);
  });
});
