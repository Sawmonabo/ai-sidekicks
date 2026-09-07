// The fixture shell that stands in for the provider-account body.
//
// WHAT A SHELL IS HERE, AND WHAT IT IS NOT. The seat next door declares who owns this
// body, what the mount owes it, and where the shell dies. This module is the third of
// those: a `define`-gated stand-in that reads the SAME registered wire the owning body
// will read, renders every state that wire can answer with, and is deleted whole in the
// PR that fills the slot. It authors no rule the body would inherit — no eligibility,
// no health verdict, no remedy — so what it leaves behind when it goes is nothing.
//
// AND IT IS NOT A PLACEHOLDER. Every figure on this page came off `providerAccount.list`
// and every one of them is rendered as it arrived. What the shell exists for is that
// the states of that reply — an account nothing has ever observed, a reading months
// old, a readiness entry carrying a sign-in remedy, three quota limits sharing one
// window — were reachable from nowhere at all while this slot rendered its reservation,
// which means nobody had drawn them.

import type { ProviderAccount } from "@ai-sidekicks/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useConsoleClock, type ConsoleBridge } from "../../../../bridge/index.js";
import { Nothing } from "../../../../primitives/index.js";
import { usePushDrivenRead } from "../../../../seats/index.js";
import { AccountDetail } from "./AccountDetail.js";
import { AccountRow } from "./AccountRow.js";
import { createAccountRegistryRead } from "./accounts-reading.js";
import { foldAccountQuotaRows, readinessForProvider } from "./quota-rows.js";
import { QuotaTable } from "./QuotaTable.js";
import { ReadinessRow } from "./ReadinessRow.js";
import { SignInCard } from "./SignInCard.js";
import {
  IDLE_SIGN_IN_FLOW,
  cancelSignIn,
  startSignIn,
  type SignInFlowState,
} from "./signin-flow.js";
import { TokenRegistrationForm } from "./TokenRegistrationForm.js";

export function AccountsShell(props: { readonly bridge: ConsoleBridge }): ReactNode {
  const { bridge } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise, so a story
  // advances this read's coalescing window exactly when it advances everything else's —
  // and so an observation's age is measured on the clock the scenario is driving.
  const clock = useConsoleClock();
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  const [signInFlow, setSignInFlow] = useState<SignInFlowState>(IDLE_SIGN_IN_FLOW);
  const registryRead = useMemo(
    () => createAccountRegistryRead({ bridge, clock }),
    [bridge, clock, openingOrdinal],
  );
  useEffect(() => {
    registryRead.start();
    return () => {
      registryRead.dispose();
    };
  }, [registryRead]);
  useEffect(() => {
    const onWindowFocus = (): void => {
      registryRead.refresh("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [registryRead]);
  // A SEPARATE EFFECT rather than a second listener inside the one above, because the
  // two release differently: the focus listener is the window's and the reconnect
  // subscription is the transport's, and one cleanup releasing both would be a single
  // identity for two lifetimes.
  useEffect(
    () =>
      bridge.transportReconnect.subscribe(() => {
        registryRead.refresh("reconnect");
      }),
    [bridge, registryRead],
  );

  const state = usePushDrivenRead(registryRead);
  if (state.kind === "not-loaded") {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading this machine’s account registry."
      />
    );
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={state.refusal.code}
        detail={state.refusal.detail}
        action={
          <button
            type="button"
            className="meridian-settings-page__action"
            onClick={() => {
              setOpeningOrdinal((held) => held + 1);
            }}
          >
            Try again
          </button>
        }
      />
    );
  }
  const registry = state.value;
  const selected =
    registry.accounts.find((account) => account.accountId === selectedAccountId) ??
    registry.accounts[0];

  return (
    <>
      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Readiness</h3>
        <ul className="meridian-settings-page__list">
          {registry.readiness.map((readiness) => (
            <ReadinessRow
              key={readiness.provider}
              readiness={readiness}
              onStartSignIn={(accountId) => {
                setSignInFlow({ kind: "starting" });
                void startSignIn(bridge, accountId).then(setSignInFlow);
              }}
            />
          ))}
        </ul>
        <SignInCard
          flow={signInFlow}
          onCancel={() => {
            if (signInFlow.kind !== "live") {
              return;
            }
            const { attempt } = signInFlow;
            setSignInFlow({ kind: "cancelling", attempt });
            void cancelSignIn(bridge, attempt).then((settled) => {
              setSignInFlow(settled);
              // A flow that ended tells us nothing about the account, so the page asks
              // the registry rather than assuming — which is the whole of what
              // "completion is not a verdict" means in practice.
              registryRead.refresh("terminal-event");
            });
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
            {readinessForProvider(registry, selected.provider) === undefined ? (
              <p className="meridian-settings-page__aside">
                The registry answered with no readiness entry for this account’s provider.
              </p>
            ) : null}
          </section>

          <section className="meridian-settings-page__block">
            <h3 className="meridian-settings-page__block-title">Quota — {selected.billingMode}</h3>
            <QuotaTable rows={foldAccountQuotaRows(selected, registry.usageWindows)} />
          </section>
        </>
      )}

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Register an account</h3>
        <TokenRegistrationForm bridge={bridge} />
      </section>
    </>
  );
}
