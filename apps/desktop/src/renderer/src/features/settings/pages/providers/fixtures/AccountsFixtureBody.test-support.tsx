// Mounting the accounts fixture body over a registry reading built here, and reading it back.
// The registry is built from the contract types, so every state a case reaches is one the wire
// can carry.

import { fireEvent, render } from "@testing-library/react";
import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { NEVER_SETTLES } from "#test/helpers/abandoned-pass.js";
import {
  AccountsFixtureBody,
  type AccountListReading,
  type AccountOperations,
} from "./AccountsFixtureBody.js";
import { listedFixtureAccounts } from "#renderer/lib/provider-binding/account/reading.test-support.js";

/** Provider-published limit identifiers, which the page must never draw. */
export const WIRE_LIMIT_IDS = ["weekly_all", "weekly_opus", "weekly_code"] as const;

const WORK_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const PERSONAL_ACCOUNT_ID = "pa-0002" as ProviderAccountId;
const BATCH_ACCOUNT_ID = "pa-0003" as ProviderAccountId;
const CLAUDE = "claude" as ProviderId;
const CODEX = "codex" as ProviderId;

/** An account the daemon observed and found signed in. */
const WORK_ACCOUNT: ProviderAccount = {
  accountId: WORK_ACCOUNT_ID,
  provider: CLAUDE,
  credentialGeneration: 3,
  observedAccountEmail: "sam@example.com",
  observedAccountPlan: "max",
  billingMode: "subscription",
  isDefault: true,
  healthState: "authenticated",
  healthObservedAt: "2026-01-01T07:00:00.000Z",
  observedAuthMode: "oauthSubscription",
  signedInAt: "2025-12-02T09:00:00.000Z",
  signInNeededAtEstimate: "2026-01-01T09:00:00.000Z",
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** An account whose credential home was absent when last observed. */
const PERSONAL_ACCOUNT: ProviderAccount = {
  accountId: PERSONAL_ACCOUNT_ID,
  provider: CODEX,
  credentialGeneration: 1,
  observedAccountEmail: "sam@example.org",
  observedAccountPlan: "plus",
  billingMode: "metered",
  isDefault: true,
  healthState: "homeMissing",
  healthObservedAt: "2026-01-01T07:00:00.000Z",
  observedAuthMode: null,
  signedInAt: null,
  signInNeededAtEstimate: null,
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** An account whose credential has moved on since its stored quota readings were taken. */
const BATCH_ACCOUNT: ProviderAccount = {
  ...WORK_ACCOUNT,
  accountId: BATCH_ACCOUNT_ID,
  observedAccountEmail: "batch@example.com",
  credentialGeneration: 5,
  billingMode: "metered",
  isDefault: false,
};

/** One limit's stored reading, on a window length several limits share. */
function usageWindow(
  overrides: Partial<ProviderAccountUsageWindow> & { readonly limitId: string },
): ProviderAccountUsageWindow {
  return {
    accountId: WORK_ACCOUNT_ID,
    windowMins: 10080,
    usedPercent: 40,
    resetsAt: "2026-01-05T00:00:00.000Z",
    observedAt: "2026-01-01T09:00:00.000Z",
    observedCredentialGeneration: 3,
    source: "run",
    ...overrides,
  };
}

// The second entry is cast: the generated readiness type carries its remedy's schema reference,
// which no literal satisfies.
const READINESS: readonly ProviderReadiness[] = [
  {
    provider: CLAUDE,
    state: "authenticated",
    resolvedAccountId: WORK_ACCOUNT_ID,
    observedAt: "2026-01-01T07:00:00.000Z",
  },
  {
    provider: CODEX,
    state: "homeMissing",
    resolvedAccountId: PERSONAL_ACCOUNT_ID,
    observedAt: "2026-01-01T07:00:00.000Z",
    remedy: {
      kind: "signIn",
      accountId: PERSONAL_ACCOUNT_ID,
    },
  } as ProviderReadiness,
];

/** A registry that has answered: three accounts, two providers, four stored readings. */
export const ACCOUNT_REGISTRY: AccountListReading = {
  phase: "read",
  accounts: listedFixtureAccounts([WORK_ACCOUNT, PERSONAL_ACCOUNT, BATCH_ACCOUNT]),
  readiness: READINESS,
  usageWindows: [
    usageWindow({ limitId: "weekly_all", label: "Weekly, all models", usedPercent: 88 }),
    usageWindow({ limitId: "weekly_opus", label: "Weekly, Opus" }),
    usageWindow({ limitId: "weekly_code" }),
    usageWindow({
      accountId: BATCH_ACCOUNT_ID,
      limitId: "weekly_all",
      label: "Weekly, all models",
      observedCredentialGeneration: 3,
    }),
  ],
  newestSignInCompletion: undefined,
};

/**
 * Mount the fixture body under the two providers every console screen renders inside.
 *
 * A verb the case does not supply never answers.
 */
export function mountAccountsPage(options: {
  readonly registry: AccountListReading;
  readonly operations?: Partial<AccountOperations>;
}): { readonly container: HTMLElement } {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("accounts-fixture-body") });
  const operations: AccountOperations = {
    signIn: () => NEVER_SETTLES,
    cancelSignIn: () => NEVER_SETTLES,
    register: () => NEVER_SETTLES,
    probe: () => NEVER_SETTLES,
    setCurrent: () => NEVER_SETTLES,
    ...options.operations,
  };
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <AccountsFixtureBody
          registry={options.registry}
          requestRegistryRead={() => undefined}
          operations={operations}
        />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  return { container };
}

/** Every `Sign in` control the readiness list is currently offering. */
export function startControls(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Sign in",
  );
}

/** Press the first of them, the way a person reaching the remedy does. */
export function pressFirstStartControl(container: HTMLElement): void {
  const [control] = startControls(container);
  if (control === undefined) {
    throw new Error("the readiness list offered no sign-in control to press");
  }
  fireEvent.click(control);
}

/** The address a running sign-in draws in its read-only field, or `undefined` while none runs. */
export function signInAddressOf(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLInputElement>('input[aria-label="Sign-in address"]')?.value;
}
