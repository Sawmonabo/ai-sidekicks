// The provider-account shell: the states the account registry can be in — an account
// nothing has ever observed, a reading months old, a readiness entry carrying a sign-in
// remedy, three quota limits sharing one window — drawn from the reading and the calls
// it is handed. It authors no rule: no eligibility, no health verdict, no remedy.
//
// The sign-in plane is one flow, not one per row: this machine runs one brokered
// sign-in at a time, so every start control is disabled, with its reason, while one is
// running. `signin-plane.ts` owns that rule. The registry's completion report is what
// releases a flow the node ended on its own, correlated by attempt id.

import "./accounts-fixture-body.css";

import type { ProviderAccount } from "@ai-sidekicks/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { useConsoleClock } from "@renderer/console/bridge/BridgeProvider.js";
import { type ProviderQuotaReadout } from "../provider-account-readout.js";
import { Nothing } from "@renderer/console/primitives/index.js";
import { AccountDetail } from "./components/AccountDetail.js";
import { AccountRow } from "./components/AccountRow.js";
import { accountQuotaRowsFrom, readinessForProvider } from "./quota-rows.js";
import { QuotaTable } from "./components/QuotaTable.js";
import { ReadinessRow } from "./components/ReadinessRow.js";
import {
  cancelSignIn,
  startSignIn,
  type ProviderAccountLoginCall,
  type ProviderAccountLoginCancelCall,
  type ProviderAccountRegisterCall,
} from "./sign-in-flow.js";
import { SignInCard } from "./components/SignInCard.js";
import { SignInPlane, signInHeldSentence, signInPlaneHolder } from "./sign-in-flow-tracker.js";
import { TokenRegistrationForm } from "./components/TokenRegistrationForm.js";

/** The daemon verbs the shell drives. Held stable by the caller. */
export interface AccountsShellOperations {
  readonly login: ProviderAccountLoginCall;
  readonly cancelLogin: ProviderAccountLoginCancelCall;
  readonly register: ProviderAccountRegisterCall;
}

/**
 * What the shell renders the account list from: the registry's accounts, readiness
 * projection and quota rows, and whether the first read has landed.
 */
export interface AccountRegistryReading extends Pick<
  ProviderQuotaReadout,
  "accounts" | "readiness" | "usageWindows" | "newestLoginCompletion"
> {
  readonly phase: "reading" | "read";
}

/**
 * The provider-account shell: the registry, the sign-in flow and the token registration
 * form, drawn from the reading and the verbs it is handed.
 */
export function AccountsShell(props: {
  readonly registry: AccountRegistryReading;
  /** Asks for a fresh registry read once a sign-in flow has ended. Held stable by the caller. */
  readonly requestRegistryRead: () => void;
  readonly operations: AccountsShellOperations;
}): ReactNode {
  const { registry, requestRegistryRead, operations } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise, so an
  // observation's age is measured on the clock the scenario is driving.
  const clock = useConsoleClock();
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  // Built in a memo and disposed in an effect, so a memo React discards costs an object
  // rather than a call in flight.
  const signInPlane = useMemo(
    () =>
      new SignInPlane({
        startSignIn: async (accountId) => await startSignIn(operations.login, accountId),
        cancelSignIn: async (attempt) => await cancelSignIn(operations.cancelLogin, attempt),
        // A flow ending says nothing about the account, so the registry is read again.
        onFlowSettled: requestRegistryRead,
      }),
    [operations, requestRegistryRead],
  );
  useEffect(
    () => () => {
      signInPlane.dispose();
    },
    [signInPlane],
  );
  const signIn = useSyncExternalStore(
    (onStoreChange: () => void) => signInPlane.subscribe(onStoreChange),
    () => signInPlane.snapshot(),
    () => signInPlane.snapshot(),
  );
  // The registry's completion report ends a flow the node finished on its own. Keyed on
  // the attempt id so a re-render over the same completion re-runs nothing.
  const completedAttemptId = registry.newestLoginCompletion?.attemptId;
  useEffect(() => {
    if (completedAttemptId !== undefined) {
      signInPlane.noteLoginCompleted(completedAttemptId);
    }
  }, [completedAttemptId, signInPlane]);

  if (registry.phase === "reading") {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading this machine’s account registry."
      />
    );
  }
  const selected =
    registry.accounts.find((account) => account.accountId === selectedAccountId) ??
    registry.accounts[0];
  const holdingAccountId = signInPlaneHolder(signIn);
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
                  : signInHeldSentence({
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
                signInPlane.start(accountId);
              }}
            />
          ))}
        </ul>
        <SignInCard
          flow={signIn.flow}
          onCancel={() => {
            signInPlane.cancel();
          }}
        />
      </section>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Accounts</h3>
        {registry.accounts.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
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
