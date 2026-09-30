// Mounting the accounts fixture body over a registry reading built here, and reading it back.
// The registry is built from the contract types, so every state a case reaches is one the wire
// can carry.

import { fireEvent, render } from "@testing-library/react";
import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { NEVER_SETTLES } from "@test/helpers/abandoned-pass.js";
import {
  AccountsFixtureBody,
  type AccountListReading,
  type AccountOperations,
} from "./AccountsFixtureBody.js";

const WORK_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const PERSONAL_ACCOUNT_ID = "pa-0002" as ProviderAccountId;
const BATCH_ACCOUNT_ID = "pa-0003" as ProviderAccountId;

/** An account the daemon observed and found signed in. */
const WORK_ACCOUNT: ProviderAccount = {
  accountId: WORK_ACCOUNT_ID,
  provider: "claude",
  displayLabel: "Claude — work",
  credentialGeneration: 3,
  billingMode: "subscription",
  isDefault: true,
  healthState: "authenticated",
  healthObservedAt: "2026-01-01T07:00:00.000Z",
  observedAuthMode: "oauth_subscription",
  loggedInAt: "2025-12-02T09:00:00.000Z",
  expectedReloginAtEstimate: "2026-01-01T09:00:00.000Z",
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** An account nothing has ever observed. */
const PERSONAL_ACCOUNT: ProviderAccount = {
  accountId: PERSONAL_ACCOUNT_ID,
  provider: "codex",
  displayLabel: "Codex — personal",
  credentialGeneration: 1,
  billingMode: "metered",
  isDefault: true,
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
};

/** An account whose credential has moved on since its stored quota readings were taken. */
const BATCH_ACCOUNT: ProviderAccount = {
  ...WORK_ACCOUNT,
  accountId: BATCH_ACCOUNT_ID,
  displayLabel: "Claude — batch runs",
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

const READINESS: readonly ProviderReadiness[] = [
  {
    provider: "claude",
    state: "authenticated",
    resolvedAccountId: WORK_ACCOUNT_ID,
    observedAt: "2026-01-01T07:00:00.000Z",
  },
  {
    provider: "codex",
    state: "indeterminate",
    resolvedAccountId: PERSONAL_ACCOUNT_ID,
    remedy: {
      kind: "sign_in",
      accountId: PERSONAL_ACCOUNT_ID,
      signInInvocation: "codex login",
      credentialHomePath: "/home/person/.sidekicks/homes/pa-0002",
    },
  },
];

/** A registry that has answered: three accounts, two providers, four stored readings. */
export const ACCOUNT_REGISTRY: AccountListReading = {
  phase: "read",
  accounts: [WORK_ACCOUNT, PERSONAL_ACCOUNT, BATCH_ACCOUNT],
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
  newestLoginCompletion: undefined,
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
    login: () => NEVER_SETTLES,
    cancelLogin: () => NEVER_SETTLES,
    register: () => NEVER_SETTLES,
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

/** Every start-sign-in control the readiness list is currently offering. */
export function startControls(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    /start sign-in/iu.test(button.textContent ?? ""),
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
