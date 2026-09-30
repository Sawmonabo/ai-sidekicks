// The browser tier: one settings claim a real engine decides and happy-dom cannot.
//
// The provider-account token field rests on a behavior the unit tier's DOM does not
// implement: an UNCONTROLLED INPUT'S VALUE IS THE ENGINE'S. The token field is
// deliberately never React state: it is read from a ref inside the submit handler and
// cleared in the same block. Whether that clear is what a person's browser then holds
// is a question about the engine's editing pipeline, and typing here goes through it.
// A unit-tier copy of any case below would go green over the exact shape it exists to
// refuse, which is what puts them here rather than beside their component.

import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { userEvent } from "vitest/browser";

import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

import type { ProviderAccountId, ProviderAccountRegisterResponse } from "@ai-sidekicks/contracts";

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
  /** The registration form over a register call that answers, mounted as a window mounts it. */
  function renderRegistrationForm(): HTMLElement {
    const { container } = render(
      <LiveAnnouncerProvider>
        <TokenRegistrationForm register={registerAnswering} />
      </LiveAnnouncerProvider>,
    );
    document.body.append(container);
    return container;
  }

  /** The token input, by the label the form gives it rather than by position. */
  function tokenFieldIn(container: HTMLElement): HTMLInputElement {
    const label = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === "Non-interactive token",
    );
    const field = label === undefined ? null : container.querySelector(`#${label.htmlFor}`);
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the registration form rendered no non-interactive token field");
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
      throw new Error("the registration form rendered no label field or no submit");
    }
    // A real label is typed because the field is `required`: this engine refuses to
    // submit a form with an empty required control, so a case that skipped it would
    // assert about a submit that never happened.
    // Inside `act`, because these are real events: the state they cause settles after
    // the promise resolves rather than before it, which React reports as an act
    // warning and a case observes as a tree one render behind.
    await act(async () => {
      await userEvent.fill(label, typedLabel);
      await userEvent.fill(tokenFieldIn(container), TYPED_TOKEN);
      await userEvent.click(submit);
      await crossMacrotaskBoundary();
    });
  }

  it("masks the value at the field rather than anywhere above it", () => {
    const container = renderRegistrationForm();
    const field = tokenFieldIn(container);
    expect(field.type).toBe("password");
    // Autofill would put the value back on a later mount, which is the one way a
    // write-only field acquires a value nobody typed into it.
    expect(field.autocomplete).toBe("off");
  });

  it("holds nothing after the submit that sent it", async () => {
    const container = renderRegistrationForm();
    await typeAndSubmit(container);

    // The engine's own value, after its own editing pipeline ran: the handler read the
    // ref, put it on the request, and cleared the input in the same block, so what is
    // left in the field a person is looking at is nothing.
    expect(tokenFieldIn(container).value).toBe("");
    // And the attribute, which is the other half: a `value` written into the markup
    // would survive a re-render even with the property cleared.
    expect(tokenFieldIn(container).getAttribute("value")).toBeNull();
  });

  it("puts the typed secret nowhere in the document after the submit", async () => {
    const container = renderRegistrationForm();
    await typeAndSubmit(container);

    // Serialized markup first — the shape a crash report or a devtools copy captures.
    expect(document.body.innerHTML).not.toContain(TYPED_TOKEN);
    // Then every live value property, which serialization does not carry: an input's
    // current value is engine state rather than markup, so the check above alone would
    // pass over a field that still held it.
    for (const field of document.body.querySelectorAll("input, textarea, select")) {
      expect((field as HTMLInputElement).value).not.toContain(TYPED_TOKEN);
    }
    // And the rendered text, which is where an outcome line would echo it.
    expect(document.body.textContent ?? "").not.toContain(TYPED_TOKEN);
  });

  it("negative control: the typed value did reach the field before the submit", async () => {
    // Without this, the three cases above would pass over a form whose token input
    // never received anything — an absence proving nothing rather than a clear.
    const container = renderRegistrationForm();
    const field = tokenFieldIn(container);
    await act(async () => {
      await userEvent.fill(field, TYPED_TOKEN);
      await crossMacrotaskBoundary();
    });
    expect(field.value).toBe(TYPED_TOKEN);
  });

  // A LABEL OF SPACES IS THE ENGINE'S CASE AND NOT A DOM SHIM'S. `required` is
  // satisfied by any non-empty value, so this browser submits the form and the handler
  // is what has to notice — which is exactly the reading a shimmed DOM cannot make,
  // because it does not run constraint validation on a submit at all.
  it("refuses a label of spaces and keeps the credential the person typed", async () => {
    const container = renderRegistrationForm();
    await typeAndSubmit(container, "   ");

    // Said, rather than silently dropped: before this the handler cleared the token
    // and returned, so the form looked untouched and the person had to retype a
    // credential with no explanation of what went wrong.
    const refusal = container.querySelector(".meridian-settings-page__state--failed");
    expect(refusal).not.toBeNull();
    expect(refusal?.textContent ?? "").toContain("label");
    // And the field still holds what was typed, because nothing was dispatched.
    expect(tokenFieldIn(container).value).toBe(TYPED_TOKEN);
  });

  it("negative control: a real label clears that same field, so retention is the refusal's", async () => {
    // Without this the case above would pass over a form that never cleared the token
    // at all — retention proving nothing rather than a submission that did not happen.
    const container = renderRegistrationForm();
    await typeAndSubmit(container, "A machine account");
    expect(tokenFieldIn(container).value).toBe("");
    expect(container.querySelector(".meridian-settings-page__state--failed")).toBeNull();
  });
});
