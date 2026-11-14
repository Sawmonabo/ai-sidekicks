// The Providers page: the states the account registry can be in (an account
// nothing has observed, a months-old reading, a readiness entry carrying a sign-in remedy,
// three quota limits sharing one window), drawn from the reading and the calls it is handed. It
// authors no rule: no eligibility, no health verdict, no remedy.
//
// The sign-in is one flow, not one per row: this machine runs one brokered sign-in at a time, so
// every start control is disabled, with its reason, while one runs.
// `features/settings/pages/providers/sign-in/tracker.ts` owns that rule, and the
// registry's completion report releases a flow the service ended on its own, correlated by attempt
// id.

import "./ProvidersPage.css";

import type { ProviderReadiness } from "@ai-sidekicks/contracts/provider/account/record";
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import {
  useProviderSections,
  useProviderSectionsReading,
} from "#renderer/store/providers/hooks/useProviderSections.js";
import type { ListedProviderAccount } from "#renderer/lib/provider-accounts/listing.js";
import { type ProviderAccountReadout } from "./account-readout.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { PartialRead } from "#renderer/components/PartialRead/PartialRead.js";
import { ACCOUNT_LIST_READ_WORDS } from "#renderer/lib/provider-accounts/sentences.js";
import { AccountDetail } from "./components/Account/AccountDetail.js";
import { AccountRow } from "./components/Account/AccountRow.js";
import { accountQuotaRowsFrom, readinessForProvider } from "./quota-rows.js";
import { QuotaTable } from "./components/QuotaTable.js";
import { ReadinessRow } from "./components/ReadinessRow.js";
import type { SecretsPlace } from "./secrets-place.js";
import {
  startProviderSignIn,
  type ProviderAccountSignInCall,
  type ProviderAccountSignInCancelCall,
  type ProviderAccountProbeCall,
  type ProviderAccountSetCurrentCall,
  type ProviderAccountRegisterCall,
} from "./sign-in/flow.js";
import { AccountCheckNow } from "./components/Account/AccountCheckNow.js";
import { AccountDefaultControl } from "./components/Account/AccountDefaultControl.js";
import { useAccountDefaultMove } from "./hooks/useAccountDefaultMove.js";
import { ProviderSignInCard } from "./components/ProviderSignInCard.js";
import {
  ProviderSignInFlowTracker,
  describeRunningProviderSignIn,
  findRunningProviderSignInAccountId,
} from "./sign-in/tracker.js";
import { TokenRegistrationForm } from "./components/Token/TokenRegistrationForm.js";

/** The daemon verbs the page drives. Held stable by the caller. */
export interface AccountOperations {
  readonly signIn: ProviderAccountSignInCall;
  readonly cancelSignIn: ProviderAccountSignInCancelCall;
  readonly register: ProviderAccountRegisterCall;
  readonly probe: ProviderAccountProbeCall;
  readonly setCurrent: ProviderAccountSetCurrentCall;
}

/**
 * The account list once its first read has landed: the registry's accounts, readiness projection
 * and quota rows, and where the service keeps a pasted token.
 */
export interface ReadAccountList extends Pick<
  ProviderAccountReadout,
  "accounts" | "readiness" | "usageWindows" | "newestSignInCompletion"
> {
  readonly phase: "read";
  /** `undefined` while the service's status names no place, read or refused. */
  readonly secretsPlace: SecretsPlace | undefined;
}

/** What the page renders the account list from: nothing read yet, or the list. */
export type AccountListReading = { readonly phase: "reading" } | ReadAccountList;

/**
 * The Providers page: the registry, the sign-in flow and the token registration
 * form, drawn from the reading and the verbs it is handed.
 */
export function ProvidersPage(props: {
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
          await startProviderSignIn(operations.signIn, accountId),
        cancelProviderSignIn: async (attempt) => {
          await operations.cancelSignIn({ attemptId: attempt.attemptId });
        },
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
  // The registry's completion report ends a flow the service finished on its own. A repeat of a
  // report already noted finds no flow holding that attempt and changes nothing.
  const completion = registry.phase === "read" ? registry.newestSignInCompletion : undefined;
  useEffect(() => {
    if (completion !== undefined) {
      providerSignInFlowTracker.noteSignInCompleted(completion);
    }
  }, [completion, providerSignInFlowTracker]);
  const { move: defaultMove, setAsDefault } = useAccountDefaultMove(
    operations.setCurrent,
    requestRegistryRead,
  );

  const providerSections = useProviderSections();
  const providerSectionsReading = useProviderSectionsReading();
  if (registry.phase === "reading") {
    return (
      <LoadingNotice clock={clock} placement="block" title={ACCOUNT_LIST_READ_WORDS.reading} />
    );
  }
  const selected =
    registry.accounts.find((account) => account.accountId === selectedAccountId) ??
    registry.accounts[0];
  const holdingAccountId = findRunningProviderSignInAccountId(signIn);
  const holdingAccountLabel =
    holdingAccountId === undefined
      ? undefined
      : registry.accounts.find((account) => account.accountId === holdingAccountId)?.label;

  return (
    <>
      <PartialRead states={[providerSectionsReading]} subject="providers" />
      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__section-head">Readiness</h3>
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
              remedyAccount={findRemedyAccount(registry.accounts, readiness)}
              register={operations.register}
              requestRegistryRead={requestRegistryRead}
              probe={operations.probe}
              secretsPlace={registry.secretsPlace}
            />
          ))}
        </ul>
        <ProviderSignInCard
          flow={signIn.flow}
          onCancel={() => {
            providerSignInFlowTracker.cancel();
          }}
          onSignInAgain={() => {
            providerSignInFlowTracker.signInAgain();
          }}
        />
      </section>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__section-head">Accounts</h3>
        {registry.accounts.length === 0 ? (
          <Nothing
            kind="empty"
            placement="block"
            title="No provider accounts yet."
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
                onSelect={(chosen: ListedProviderAccount) => {
                  setSelectedAccountId(chosen.accountId);
                  // Pressing the row does exactly what `Set as default` does.
                  if (!chosen.isDefault) {
                    setAsDefault(chosen.accountId);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {selected === undefined ? null : (
        <>
          <section className="meridian-settings-page__block" aria-label={selected.label}>
            <p className="meridian-accounts__identity">{selected.label}</p>
            <AccountDetail account={selected} />
            <AccountDefaultControl
              account={selected}
              move={defaultMove}
              onSetAsDefault={setAsDefault}
            />
            <AccountCheckNow
              key={selected.accountId}
              accountId={selected.accountId}
              probe={operations.probe}
              onChecked={requestRegistryRead}
            />
            {readinessForProvider(registry.readiness, selected.provider) === undefined ? (
              <p className="meridian-settings-page__aside">
                The registry answered with no readiness entry for this account’s provider.
              </p>
            ) : null}
          </section>

          <section className="meridian-settings-page__block">
            <h3 className="meridian-settings-page__section-head">Usage</h3>
            <QuotaTable rows={accountQuotaRowsFrom(registry, selected)} />
          </section>
        </>
      )}

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__section-head">Register an account</h3>
        {providerSections.map((section) => (
          <Fragment key={section.provider}>
            <h4 className="meridian-settings-page__section-head">{section.name}</h4>
            <TokenRegistrationForm
              register={operations.register}
              provider={section.provider}
              accounts={registry.accounts}
              secretsPlace={registry.secretsPlace}
            />
          </Fragment>
        ))}
      </section>
    </>
  );
}

/** The account a readiness entry's remedy names, where it names one the registry carries. */
function findRemedyAccount(
  accounts: readonly ListedProviderAccount[],
  readiness: ProviderReadiness,
): ListedProviderAccount | undefined {
  if (readiness.state === "authenticated") {
    return undefined;
  }
  const { remedy } = readiness;
  if (!("accountId" in remedy)) {
    return undefined;
  }
  return accounts.find((account) => account.accountId === remedy.accountId);
}
