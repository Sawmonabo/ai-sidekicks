// The provider-account fixture body: the states the account registry can be in (an account
// nothing has observed, a months-old reading, a readiness entry carrying a sign-in remedy,
// three quota limits sharing one window), drawn from the reading and the calls it is handed. It
// authors no rule: no eligibility, no health verdict, no remedy.
//
// The sign-in is one flow, not one per row: this machine runs one brokered sign-in at a time,
// so every start control is disabled, with its reason, while one runs.
// `provider-sign-in-flow-tracker.ts` owns that rule, and the registry's completion report
// releases a flow the service ended on its own, correlated by attempt id.

import "./accounts-fixture-body.css";

import type { ProviderAccount } from "@ai-sidekicks/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { type ProviderAccountReadout } from "../provider-account-readout.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { AccountDetail } from "./components/AccountDetail.js";
import { AccountRow } from "./components/AccountRow.js";
import { accountQuotaRowsFrom, readinessForProvider } from "./quota-rows.js";
import { QuotaTable } from "./components/QuotaTable.js";
import { ReadinessRow } from "./components/ReadinessRow.js";
import {
  cancelProviderSignIn,
  startProviderSignIn,
  type ProviderAccountLoginCall,
  type ProviderAccountLoginCancelCall,
  type ProviderAccountRegisterCall,
} from "./provider-sign-in-flow.js";
import { ProviderSignInCard } from "./components/ProviderSignInCard.js";
import {
  ProviderSignInFlowTracker,
  describeRunningProviderSignIn,
  findRunningProviderSignInAccountId,
} from "./provider-sign-in-flow-tracker.js";
import { TokenRegistrationForm } from "./components/TokenRegistrationForm.js";

/** The daemon verbs the fixture body drives. Held stable by the caller. */
export interface AccountOperations {
  readonly login: ProviderAccountLoginCall;
  readonly cancelLogin: ProviderAccountLoginCancelCall;
  readonly register: ProviderAccountRegisterCall;
}

/**
 * What the fixture body renders the account list from: the registry's accounts, readiness
 * projection and quota rows, and whether the first read has landed.
 */
export interface AccountListReading extends Pick<
  ProviderAccountReadout,
  "accounts" | "readiness" | "usageWindows" | "newestLoginCompletion"
> {
  readonly phase: "reading" | "read";
}

/**
 * The provider-account fixture body: the registry, the sign-in flow and the token registration
 * form, drawn from the reading and the verbs it is handed.
 */
export function AccountsFixtureBody(props: {
  readonly registry: AccountListReading;
  /** Asks for a fresh registry read once a sign-in flow has ended. Held stable by the caller. */
  readonly requestRegistryRead: () => void;
  readonly operations: AccountOperations;
}): ReactNode {
  const { registry, requestRegistryRead, operations } = props;
  // The scenario's frozen clock under the fixture, so an observation's age is measured on the
  // clock the scenario drives.
  const clock = useClock();
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  // Built in a memo and disposed in an effect, so a discarded memo costs an object and not a
  // call in flight.
  const providerSignInFlowTracker = useMemo(
    () =>
      new ProviderSignInFlowTracker({
        startProviderSignIn: async (accountId) =>
          await startProviderSignIn(operations.login, accountId),
        cancelProviderSignIn: async (attempt) =>
          await cancelProviderSignIn(operations.cancelLogin, attempt),
        // A flow ending says nothing about the account, so the registry is read again.
        onFlowSettled: requestRegistryRead,
      }),
    [operations, requestRegistryRead],
  );
  useEffect(
    () => () => {
      providerSignInFlowTracker.dispose();
    },
    [providerSignInFlowTracker],
  );
  const signIn = useSyncExternalStore(
    (onStoreChange: () => void) => providerSignInFlowTracker.subscribe(onStoreChange),
    () => providerSignInFlowTracker.snapshot(),
    () => providerSignInFlowTracker.snapshot(),
  );
  // The registry's completion report ends a flow the service finished on its own; keyed on the
  // attempt id so a re-render over the same completion re-runs nothing.
  const completedAttemptId = registry.newestLoginCompletion?.attemptId;
  useEffect(() => {
    if (completedAttemptId !== undefined) {
      providerSignInFlowTracker.noteLoginCompleted(completedAttemptId);
    }
  }, [completedAttemptId, providerSignInFlowTracker]);

  if (registry.phase === "reading") {
    return (
      <Nothing
        kind="not-loaded"
        placement="block"
        title="Reading this machine’s account registry."
      />
    );
  }
  const selected =
    registry.accounts.find((account) => account.accountId === selectedAccountId) ??
    registry.accounts[0];
  const holdingAccountId = findRunningProviderSignInAccountId(signIn);
  const holdingAccountLabel =
    holdingAccountId === undefined
      ? undefined
      : (registry.accounts.find((account) => account.accountId === holdingAccountId)
          ?.displayLabel ?? holdingAccountId);

  return (
    <>
      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Readiness</h3>
        <ul className="meridian-settings-page__list">
          {registry.readiness.map((readiness) => (
            <ReadinessRow
              key={readiness.provider}
              readiness={readiness}
              startBlockedReason={
                holdingAccountId === undefined
                  ? undefined
                  : describeRunningProviderSignIn({
                      isTheSameAccount: holdingAccountId === readiness.resolvedAccountId,
                      holdingAccountLabel,
                    })
              }
              startRefusal={
                readiness.resolvedAccountId === undefined
                  ? undefined
                  : signIn.refusalByAccountId.get(readiness.resolvedAccountId)
              }
              onStartSignIn={(accountId) => {
                providerSignInFlowTracker.start(accountId);
              }}
            />
          ))}
        </ul>
        <ProviderSignInCard
          flow={signIn.flow}
          onCancel={() => {
            providerSignInFlowTracker.cancel();
          }}
        />
      </section>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Accounts</h3>
        {registry.accounts.length === 0 ? (
          <Nothing
            kind="empty"
            placement="block"
            title="This machine has no provider accounts."
            detail="A run will refuse until one is registered. Register one below."
          />
        ) : (
          <ul className="meridian-accounts__rows">
            {registry.accounts.map((account) => (
              <AccountRow
                key={account.accountId}
                account={account}
                selected={account.accountId === selected?.accountId}
                nowMilliseconds={clock.now()}
                onSelect={(chosen: ProviderAccount) => {
                  setSelectedAccountId(chosen.accountId);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {selected === undefined ? null : (
        <>
          <section className="meridian-settings-page__block">
            <h3 className="meridian-settings-page__block-title">{selected.displayLabel}</h3>
            <AccountDetail account={selected} />
            {readinessForProvider(registry.readiness, selected.provider) === undefined ? (
              <p className="meridian-settings-page__aside">
                The registry answered with no readiness entry for this account’s provider.
              </p>
            ) : null}
          </section>

          <section className="meridian-settings-page__block">
            <h3 className="meridian-settings-page__block-title">Quota — {selected.billingMode}</h3>
            <QuotaTable rows={accountQuotaRowsFrom(registry, selected)} />
          </section>
        </>
      )}

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Register an account</h3>
        <TokenRegistrationForm register={operations.register} />
      </section>
    </>
  );
}
