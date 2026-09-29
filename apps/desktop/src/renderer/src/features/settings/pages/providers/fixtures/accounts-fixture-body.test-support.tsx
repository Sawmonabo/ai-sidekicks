// Mounting the accounts shell over a registry reading built here, and reading it back.
//
// Hoisted because three suites drive this page — what the registry reading renders, and
// what the sign-in plane does while a flow is running or after it has ended — and all
// three need the same registry, the same mount and the same readers over the rendered
// list. The registry is built from the contract types, so every state a case reaches is
// one the wire can carry.

import { fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

import { DesktopBridgeProvider } from "@renderer/console/bridge/BridgeProvider.js";
import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { unscriptedScenario } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { NEVER_SETTLES } from "@test/helpers/abandoned-pass.js";
import {
  AccountsShell,
  type AccountRegistryReading,
  type AccountsShellOperations,
} from "./AccountsFixtureBody.js";

/** A mounted shell, and the handles a case needs to change what it is handed. */
export interface MountedShell {
  readonly container: HTMLElement;
  /** Re-render the same mount with another registry reading. */
  readonly showRegistry: (registry: AccountRegistryReading) => void;
  /** Called each time the shell asks for a fresh registry read. */
  readonly requestRegistryRead: ReturnType<typeof vi.fn<() => void>>;
}

const WORK_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const PERSONAL_ACCOUNT_ID = "pa-0002" as ProviderAccountId;
const BATCH_ACCOUNT_ID = "pa-0003" as ProviderAccountId;

/** Provider-published limit identifiers, which the page must never draw. */
export const WIRE_LIMIT_IDS = ["weekly_all", "weekly_opus", "weekly_code"] as const;

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
export const ACCOUNT_REGISTRY: AccountRegistryReading = {
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

/** A registry whose first read has not landed. */
export const UNREAD_ACCOUNT_REGISTRY: AccountRegistryReading = {
  phase: "reading",
  accounts: [],
  readiness: [],
  usageWindows: [],
  newestLoginCompletion: undefined,
};

/** The registry, reporting the brokered attempt with this id finished. */
export function registryReportingCompleted(attemptId: string): AccountRegistryReading {
  return {
    ...ACCOUNT_REGISTRY,
    newestLoginCompletion: {
      kind: "login_completed",
      attemptId,
      accountId: PERSONAL_ACCOUNT_ID,
      outcome: "succeeded",
    },
  };
}

/**
 * Mount the shell under the two providers every console surface renders inside.
 *
 * A verb the case does not supply never answers. The operations object is created once so
 * a re-render does not rebuild the sign-in plane.
 */
export function mountShell(options: {
  readonly registry: AccountRegistryReading;
  readonly operations?: Partial<AccountsShellOperations>;
}): MountedShell {
  const bridge = createFixtureBridge({ scenario: unscriptedScenario("accounts-shell") });
  const operations: AccountsShellOperations = {
    login: () => NEVER_SETTLES,
    cancelLogin: () => NEVER_SETTLES,
    register: () => NEVER_SETTLES,
    ...options.operations,
  };
  const requestRegistryRead = vi.fn<() => void>();
  const tree = (registry: AccountRegistryReading): React.JSX.Element => (
    <DesktopBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <AccountsShell
          registry={registry}
          requestRegistryRead={requestRegistryRead}
          operations={operations}
        />
      </LiveAnnouncerProvider>
    </DesktopBridgeProvider>
  );
  const { container, rerender } = render(tree(options.registry));
  return {
    container,
    requestRegistryRead,
    showRegistry: (registry) => {
      rerender(tree(registry));
    },
  };
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

/** Open one account's detail the way a person does — by pressing its row. */
export function selectAccount(container: HTMLElement, displayLabel: string): void {
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".meridian-accounts__row")];
  const row = rows.find((button) => (button.textContent ?? "").includes(displayLabel));
  if (row === undefined) {
    throw new Error(`the registry rendered no account row labeled ${displayLabel}`);
  }
  fireEvent.click(row);
}
