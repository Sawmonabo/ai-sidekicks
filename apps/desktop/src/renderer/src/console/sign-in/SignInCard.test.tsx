// Every sign-in state renders something, and the fallback renders no field.
//
// THE STATES ARE THE FLOW'S AND THE RENDERING IS THIS CARD'S, so what these cases
// pin is the second: which state is a card body, which is an absence, and which kind
// of absence it is. "We asked and were told no" is an error and "this build has no
// ceremony" is _not checked_ — collapsing them would tell a person their passkey was
// rejected by a build that never had one.
//
// AND THE DEVICE GRANT COLLECTS NOTHING. There is no input anywhere in this family:
// a form that took a code would be this window handling a credential the main process
// confines. The negative case below is what keeps that true as the card grows.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SignInCard } from "./SignInCard.js";
import type { SignInState } from "./sign-in-flow.js";

const HANDOFF = { verificationUri: "http://127.0.0.1:8419/callback", userCode: "JQPD-4KTM" };

const STATES: readonly SignInState[] = [
  { kind: "signed-out" },
  { kind: "passkey-in-flight" },
  { kind: "handing-off", probeResult: "no-prf", handoff: HANDOFF },
  { kind: "awaiting-callback", handoff: HANDOFF },
  { kind: "signed-in", custody: "durable" },
  { kind: "signed-in", custody: "memory-only" },
  { kind: "refused", reason: "cancelled" },
  {
    kind: "unavailable",
    refusal: { code: "ceremony-unreadable", detail: "Nothing answered.", origin: "sign-in" },
  },
];

function renderState(state: SignInState): HTMLElement {
  const { container } = render(
    <SignInCard
      state={state}
      isBusy={false}
      onSignIn={() => undefined}
      onRegisterAnother={() => undefined}
      onOpenBrowser={() => undefined}
      onDismissRefusal={() => undefined}
    />,
  );
  return container;
}

describe("every state renders", () => {
  it.each(STATES.map((state) => [state.kind, state] as const))(
    "renders a body for %s",
    (_kind, state) => {
      const text = renderState(state).textContent ?? "";
      expect(text).toContain("Sign in");
      expect(text.length).toBeGreaterThan(20);
    },
  );
});

describe("what each state actually says", () => {
  it("offers the passkey action and the honest local-session note when signed out", () => {
    const text = renderState({ kind: "signed-out" }).textContent ?? "";
    expect(text).toContain("A session on this machine needs no account");
    expect(text).toContain("Sign in with a passkey");
  });

  it("says what the probe found before it hands a person to a browser", () => {
    const text =
      renderState({ kind: "handing-off", probeResult: "no-prf", handoff: HANDOFF }).textContent ??
      "";
    expect(text).toContain("does not support the extension");
    expect(text).toContain("JQPD-4KTM");
    expect(text).toContain("Open the browser");
  });

  it("states the memory-only consequence at the moment it is minted", () => {
    const text = renderState({ kind: "signed-in", custody: "memory-only" }).textContent ?? "";
    expect(text).toContain("keystore is unavailable");
  });

  it("separates a refusal from a build with no ceremony", () => {
    expect(renderState({ kind: "refused", reason: "cancelled" }).textContent).toContain(
      "The passkey prompt was dismissed",
    );
    const unavailable = renderState({
      kind: "unavailable",
      refusal: { code: "ceremony-unreadable", detail: "Nothing answered.", origin: "sign-in" },
    });
    expect(unavailable.textContent).toContain("ceremony-unreadable");
  });
});

describe("what the card never grows", () => {
  it.each(STATES.map((state) => [state.kind, state] as const))(
    "renders no input, textarea, or form in %s",
    (_kind, state) => {
      const container = renderState(state);
      expect(container.querySelector("input")).toBeNull();
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector("form")).toBeNull();
    },
  );

  it("offers exactly one control while the browser hand-off is waiting to start", () => {
    const container = renderState({
      kind: "handing-off",
      probeResult: "no-authenticator",
      handoff: HANDOFF,
    });
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});
