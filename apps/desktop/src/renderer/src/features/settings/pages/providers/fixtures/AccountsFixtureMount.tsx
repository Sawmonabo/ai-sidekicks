// The accounts fixture body over this window's bridge. The registry read, the sign-in, its
// cancellation and the token registration go through `callDaemon`, so each reply is parsed
// against the method's registered shape, and the registry's tail, opened before the first read,
// is the signal to read it again.
//
// Every frame asks for a fresh read; the one frame folded here is a finished sign-in, kept as
// the newest so the body can end a flow the service finished on its own. The registry's own
// fold over the tail belongs to the provider account service, which this page does not use yet.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { ProviderAccountListResponse } from "@ai-sidekicks/contracts";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import type { Clock } from "@renderer/lib/clock.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { PROVIDER_ACCOUNT_NOTICE_STREAM } from "@renderer/services/daemon/session-event-streams.js";
import {
  loginCompletionIn,
  type ProviderLoginCompletion,
} from "@renderer/services/provider-accounts/provider-account-deliveries.js";
import { unwrapDaemonReply } from "@renderer/services/daemon/unwrap-daemon-reply.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { openObservedSubscription } from "@renderer/services/transport/observed-subscription.js";
import { usePushDrivenRead } from "@renderer/store/reads/hooks/usePushDrivenRead.js";
import { PushDrivenRead } from "@renderer/store/reads/push-driven-read.js";
import {
  AccountsFixtureBody,
  type AccountListReading,
  type AccountOperations,
} from "./AccountsFixtureBody.js";

/** Names the registry read in a refusal, so a failure says which read failed. */
const ACCOUNT_REGISTRY_READ_ORIGIN = "provider-accounts";

/** What the body is handed before the first read has landed. */
const UNREAD_REGISTRY: AccountListReading = {
  phase: "reading",
  accounts: [],
  readiness: [],
  usageWindows: [],
  newestLoginCompletion: undefined,
};

/** The accounts fixture body, its reads and verbs answered by the daemon this window reaches. */
export function AccountsFixtureMount(): ReactNode {
  const bridge = usePlatformBridge();
  // The scenario's frozen clock under the fixture, the real one otherwise.
  const clock = useClock();
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  const [newestLoginCompletion, setNewestLoginCompletion] = useState<
    ProviderLoginCompletion | undefined
  >(undefined);
  // The bridge is a dependency because the clock forwards to the current bridge, and the ordinal
  // because a person asking again after a refused read opens a fresh one.
  const registryRead = useMemo(
    () => createAccountRegistryRead(bridge, clock, setNewestLoginCompletion),
    [bridge, clock, openingOrdinal],
  );
  useEffect(() => {
    registryRead.start();
    return () => {
      registryRead.dispose();
    };
  }, [registryRead]);
  const requestRegistryRead = useCallback(() => {
    registryRead.refresh("terminal-event");
  }, [registryRead]);
  const operations = useMemo(() => accountOperationsOver(bridge), [bridge]);

  const state = usePushDrivenRead(registryRead);
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title={state.refusal.code}
        detail={state.refusal.detail}
        action={
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
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
  const registry: AccountListReading =
    state.kind === "not-loaded"
      ? UNREAD_REGISTRY
      : { phase: "read", ...state.value, newestLoginCompletion };
  return (
    <AccountsFixtureBody
      registry={registry}
      requestRegistryRead={requestRegistryRead}
      operations={operations}
    />
  );
}

/**
 * The registry read, constructed by the mount that owns its lifetime and disposed with it. A
 * frame the registered union does not admit still asks for a read, as the read is what the page
 * draws; it folds nothing.
 */
function createAccountRegistryRead(
  bridge: PlatformBridge,
  clock: Clock,
  onLoginCompleted: (completion: ProviderLoginCompletion) => void,
): PushDrivenRead<ProviderAccountListResponse> {
  return new PushDrivenRead<ProviderAccountListResponse>({
    clock,
    origin: ACCOUNT_REGISTRY_READ_ORIGIN,
    read: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.list", {}, { signal })),
    subscribe: (onChange) =>
      openObservedSubscription(bridge.transportReconnect, () =>
        bridge.daemon.subscribe(PROVIDER_ACCOUNT_NOTICE_STREAM, {}, (frame) => {
          const completion = loginCompletionIn(frame);
          if (completion !== undefined) {
            onLoginCompleted(completion);
          }
          onChange();
        }),
      ),
  });
}

/** The three verbs the body drives, over one bridge; a refused reply rejects with the refusal. */
function accountOperationsOver(bridge: PlatformBridge): AccountOperations {
  return {
    login: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.login", request)),
    cancelLogin: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.loginCancel", request)),
    register: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.register", request)),
  };
}
