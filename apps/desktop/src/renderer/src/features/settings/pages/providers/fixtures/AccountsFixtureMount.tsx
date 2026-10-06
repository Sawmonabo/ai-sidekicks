// The accounts fixture body over this window's bridge. The registry read, the sign-in, its
// cancellation, the token registration, the account check and the default move go through
// `callDaemon`, so each reply is parsed against the method's registered shape. The registry's
// tail, opened before the first read, reaches the account fold through
// `ProviderAccountDeliveries`: each read's snapshot is loaded into the fold with the tail held
// across it, and the body draws the fold's accounts and quota rows, the read's readiness, and
// the newest sign-in the tail reported finished.

import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";

import type { ProviderAccountListResponse } from "@ai-sidekicks/contracts/provider/account/record";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type { Clock } from "#renderer/lib/clock.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { PROVIDER_ACCOUNT_NOTICE_STREAM } from "#shared/daemon/streams.js";
import { ProviderAccountDeliveries } from "#renderer/services/provider-accounts/deliveries.js";
import { unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { openReopeningSubscription } from "#renderer/services/transport/reopening-subscription.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import { ProviderAccountFold } from "#renderer/store/provider-accounts/fold.js";
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
  // The fold moves in place, so a frame that moved it is published by drawing again.
  const [, publishFoldChange] = useReducer((changeCount: number) => changeCount + 1, 0);
  // The bridge is a dependency because the clock forwards to the current bridge, and the ordinal
  // because a person asking again after a refused read opens a fresh one.
  const { registryRead, fold, deliveries } = useMemo(
    () => createAccountRegistry(bridge, clock, publishFoldChange),
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
          <TryAgainButton
            onPress={() => {
              setOpeningOrdinal((held) => held + 1);
            }}
          />
        }
      />
    );
  }
  const registry: AccountListReading =
    state.kind === "not-loaded"
      ? UNREAD_REGISTRY
      : {
          phase: "read",
          accounts: fold.accounts(),
          readiness: state.value.readiness,
          usageWindows: fold.usageWindows(),
          newestLoginCompletion: deliveries.newestLoginCompletion,
        };
  return (
    <AccountsFixtureBody
      registry={registry}
      requestRegistryRead={requestRegistryRead}
      operations={operations}
    />
  );
}

/** The registry read, the fold its snapshots and tail frames land in, and the tail's deliveries. */
interface AccountRegistry {
  readonly registryRead: PushDrivenRead<ProviderAccountListResponse>;
  readonly fold: ProviderAccountFold;
  readonly deliveries: ProviderAccountDeliveries;
}

/**
 * The registry, constructed by the mount that owns its lifetime and disposed with it. A read
 * holds the tail from before it is sent until its snapshot is loaded, so a frame that crossed it
 * lands on top of the snapshot rather than under it. A superseded read loads nothing and leaves
 * its held frames to the read that replaced it; a refused one still applies them.
 */
function createAccountRegistry(
  bridge: PlatformBridge,
  clock: Clock,
  publishFoldChange: () => void,
): AccountRegistry {
  const fold = new ProviderAccountFold();
  // A frame that moved the fold is drawn at once and asks for a fresh read, since the readiness
  // projection is read-time; a hold that overflowed asks for a read that supersedes the one in
  // flight.
  const deliveries = new ProviderAccountDeliveries(fold, {
    onChanged: () => {
      publishFoldChange();
      registryRead.refresh("terminal-event");
    },
    onSupersededRead: () => {
      registryRead.refresh("terminal-event");
    },
  });
  const registryRead = new PushDrivenRead<ProviderAccountListResponse>({
    clock,
    origin: ACCOUNT_REGISTRY_READ_ORIGIN,
    read: async (signal) => {
      deliveries.beginHold();
      let registry: ProviderAccountListResponse;
      try {
        registry = unwrapDaemonReply(
          await callDaemon(bridge, "providerAccount.list", {}, { signal }),
        );
      } catch (error) {
        if (!signal.aborted) {
          deliveries.releaseHold();
        }
        throw error;
      }
      if (!signal.aborted) {
        loadRegistrySnapshot(fold, deliveries, registry);
        deliveries.releaseHold();
      }
      return registry;
    },
    // A tail opened again after it ended reads again, since a change in the gap went unheard.
    subscribe: (onChange) =>
      openReopeningSubscription({
        signal: bridge.transportReconnect,
        subject: PROVIDER_ACCOUNT_NOTICE_STREAM,
        open: (deliver, onEnded) =>
          bridge.daemon.subscribe(PROVIDER_ACCOUNT_NOTICE_STREAM, {}, deliver, onEnded),
        onFrame: (frame) => {
          deliveries.deliver(frame);
        },
        onReopened: onChange,
      }),
  });
  return { registryRead, fold, deliveries };
}

/**
 * Make the fold hold what one registry snapshot says: an account the snapshot no longer carries
 * is forgotten with its readings, every carried account is written whole, and every reading is
 * merged under the fold's own supersession rule.
 */
function loadRegistrySnapshot(
  fold: ProviderAccountFold,
  deliveries: ProviderAccountDeliveries,
  registry: ProviderAccountListResponse,
): void {
  const carried = new Set(registry.accounts.map((account) => account.accountId));
  for (const account of fold.accounts()) {
    if (!carried.has(account.accountId)) {
      fold.forgetAccount(account.accountId);
    }
  }
  for (const account of registry.accounts) {
    fold.putAccount(account);
  }
  for (const usageWindow of registry.usageWindows) {
    deliveries.mergeUsageWindow(usageWindow);
  }
}

/** The five verbs the body drives, over one bridge; a refused reply rejects with the refusal. */
function accountOperationsOver(bridge: PlatformBridge): AccountOperations {
  return {
    login: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.login", request)),
    cancelLogin: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.loginCancel", request)),
    register: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.register", request)),
    probe: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.probe", request)),
    setCurrent: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.setCurrent", request)),
  };
}
