// The provider step renders six states, one remedy per arm, and no staleness badge.
//
// THE VOCABULARY CASES DRIVE THE CONTRACT'S OWN ARRAY rather than a hand-listed
// copy: a test restating the six readiness states would be a second closed set, and
// the first one to go stale when a seventh lands.
//
// THE REMEDY IS DISPLAY TEXT. The two remedies whose act is a mutating registry verb
// have no control here at all — a button that registered an account or set a default
// from this step would be a second place the registry is written from — so the case
// below counts the controls a `register` row offers, and it is none.
//
// AND `observedAt` IS RENDERED AS WHAT IT IS. The contract carries no read-path age
// test and no stale arm, so a badge computed from a clock would be this console
// inventing a freshness policy and applying it to somebody else's reading.

import { PROVIDER_READINESS_STATES, type ProviderReadiness } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderReadinessStep } from "./ProviderReadinessStep.js";
import { READINESS_STATE_LABELS, READINESS_STATE_NOTES } from "./provider-readiness-copy.js";
import type { ProviderReadinessReading } from "./provider-readiness.js";

const ACCOUNT_ID = "019b78c9-0a80-7c31-8110-cca0117a3302" as NonNullable<
  ProviderReadiness["resolvedAccountId"]
>;

function renderStep(reading: ProviderReadinessReading): HTMLElement {
  const { container } = render(
    <ProviderReadinessStep
      reading={reading}
      actionFor={() => ({ kind: "idle" })}
      onSignIn={() => undefined}
      onRecheck={() => undefined}
      onOpenAccountRegistry={() => undefined}
      onSkip={() => undefined}
    />,
  );
  return container;
}

function readingWith(entries: readonly ProviderReadiness[]): ProviderReadinessReading {
  return { kind: "read", entries, accounts: [] };
}

describe("the readiness vocabulary", () => {
  it("says something distinct about every state the contract declares", () => {
    // Vacuity guard: an empty contract array would make the loop assert nothing.
    expect(PROVIDER_READINESS_STATES.length).toBe(6);
    const notes = new Set<string>();
    for (const state of PROVIDER_READINESS_STATES) {
      const text = renderStep(readingWith([{ provider: "claude", state }])).textContent ?? "";
      expect(text).toContain(READINESS_STATE_LABELS[state]);
      expect(text).toContain(READINESS_STATE_NOTES[state]);
      notes.add(READINESS_STATE_NOTES[state]);
    }
    // Six states, six sentences: a shared sentence would make two different facts
    // read identically on screen.
    expect(notes.size).toBe(6);
  });

  it("reports a provider as ready on the authenticated arm and on no other", () => {
    for (const state of PROVIDER_READINESS_STATES) {
      const text = renderStep(readingWith([{ provider: "codex", state }])).textContent ?? "";
      expect(text.includes("Ready. A run can start"), state).toBe(state === "authenticated");
    }
  });
});

describe("the remedy", () => {
  it("renders the register remedy as text and offers no control for it", () => {
    const container = renderStep(
      readingWith([
        {
          provider: "claude",
          state: "no_account",
          remedy: { kind: "register", provider: "claude" },
        },
      ]),
    );
    expect(container.textContent).toContain("Register an account for this provider");
    // Only the step's own two controls — the registry and the skip — and nothing on
    // the row, because registration is a mutating registry verb.
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("offers the sign-in control only where the daemon composed that remedy", () => {
    const container = renderStep(
      readingWith([
        {
          provider: "codex",
          state: "reauth_required",
          resolvedAccountId: ACCOUNT_ID,
          observedAt: "2026-01-01T08:40:00.000Z",
          remedy: {
            kind: "sign_in",
            accountId: ACCOUNT_ID,
            signInInvocation: "codex login",
            credentialHomePath: "/homes/codex/personal",
          },
        },
      ]),
    );
    const labels = [...container.querySelectorAll("button")].map((one) => one.textContent);
    expect(labels).toContain("Sign in to this provider");
    expect(labels).toContain("Check again");
  });

  it("offers no re-check where readiness resolved no account to probe", () => {
    const container = renderStep(
      readingWith([
        {
          provider: "claude",
          state: "no_account",
          remedy: { kind: "register", provider: "claude" },
        },
      ]),
    );
    const labels = [...container.querySelectorAll("button")].map((one) => one.textContent);
    expect(labels).not.toContain("Check again");
  });
});

describe("what the step never renders", () => {
  it("shows the observation moment verbatim and adds no freshness word", () => {
    const text =
      renderStep(
        readingWith([
          {
            provider: "claude",
            state: "authenticated",
            resolvedAccountId: ACCOUNT_ID,
            observedAt: "2026-01-01T08:55:00.000Z",
          },
        ]),
      ).textContent ?? "";
    expect(text).toContain("2026-01-01T08:55:00.000Z");
    for (const word of ["stale", "Stale", "ago", "out of date", "expired"]) {
      expect(text, word).not.toContain(word);
    }
  });

  it("has no field anywhere a provider credential could be typed", () => {
    const container = renderStep(
      readingWith([
        {
          provider: "codex",
          state: "reauth_required",
          resolvedAccountId: ACCOUNT_ID,
          remedy: {
            kind: "sign_in",
            accountId: ACCOUNT_ID,
            signInInvocation: "codex login",
            credentialHomePath: "/homes/codex/personal",
          },
        },
      ]),
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("the absences", () => {
  it("separates a read in flight from a read that failed", () => {
    expect(renderStep({ kind: "reading" }).textContent).toContain("Reading what this node can run");
    const refused = renderStep({
      kind: "unreadable",
      refusal: { code: "runtimenode.permission_denied", detail: "No.", origin: "daemon" },
    });
    expect(refused.textContent).toContain("runtimenode.permission_denied");
  });

  it("says a node that selects no provider selects none, rather than showing nothing", () => {
    expect(renderStep(readingWith([])).textContent).toContain("No providers are selected");
  });
});
