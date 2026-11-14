// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `provider.install.*` and `provider.installUpdate.*` methods: installing and updating a provider's command in one place.

import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { ProviderId } from "./id.js";
import type { ProviderPlaceRequest } from "./settings.js";

/** The longest install failure reason: the installer's last lines, credentials removed. */
export const PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN = 4096 as const;

/** The longest installer command a failed install shows. */
export const PROVIDER_INSTALL_COMMAND_MAX_LEN = 1024 as const;

/**
 * Where one provider's install in one place has got to. The install runs the provider's own
 * installer as the person, keyed by provider and place, and the stream's first message is the
 * last outcome in that place.
 */
export type ProviderInstallProgress =
  | {
      state: "running";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      state: "installed";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      state: "failed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The installer's last lines, credentials removed.
       */
      reason: string;
      /**
       * The installer command, for the person to run.
       */
      command: string;
    };
/**
 * Where one provider's update in one place has got to: `Update` on its row, or the service's own
 * run when the latest-version marker names a build the command does not resolve to. The outcome
 * is read from the version the command resolves to afterwards, and the stream's first message is
 * the last outcome.
 */
export type ProviderInstallUpdateProgress =
  | {
      state: "running";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      state: "updated";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The version it left.
       */
      fromVersion: string;
      /**
       * The version it resolves to.
       */
      toVersion: string;
    }
  | {
      state: "current";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The version it resolves to.
       */
      version: string;
    }
  | {
      state: "notUpdated";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The version it still resolves to.
       */
      version: string;
      /**
       * The update's last lines, credentials removed.
       */
      reason: string;
      /**
       * The update command, for the person to run.
       */
      command: string;
    }
  | {
      state: "needsAdministrator";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The update command, for the person to run.
       */
      command: string;
    };

/** The methods of {@link PROVIDER_INSTALL_METHOD_DESCRIPTORS}, each with its kind. */
export interface ProviderInstallMethodDescriptors {
  readonly "provider.install.start": {
    readonly method: "provider.install.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "provider.install.subscribe": {
    readonly method: "provider.install.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "provider.install.stop": {
    readonly method: "provider.install.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "provider.installUpdate.start": {
    readonly method: "provider.installUpdate.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "provider.installUpdate.subscribe": {
    readonly method: "provider.installUpdate.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link PROVIDER_INSTALL_METHOD_DESCRIPTORS}. */
export interface ProviderInstallMethodTypes {
  readonly "provider.install.start": {
    readonly params: ProviderPlaceRequest;
    readonly result: EmptyPayload;
  };
  readonly "provider.install.subscribe": {
    readonly params: ProviderPlaceRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ProviderInstallProgress;
  };
  readonly "provider.install.stop": {
    readonly params: ProviderPlaceRequest;
    readonly result: EmptyPayload;
  };
  readonly "provider.installUpdate.start": {
    readonly params: ProviderPlaceRequest;
    readonly result: EmptyPayload;
  };
  readonly "provider.installUpdate.subscribe": {
    readonly params: ProviderPlaceRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ProviderInstallUpdateProgress;
  };
}
/**
 * Every `provider.install.*` and `provider.installUpdate.*` method: its name, how it answers,
 * and its shapes.
 */
export const PROVIDER_INSTALL_METHOD_DESCRIPTORS: ProviderInstallMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "provider.install.start": /* @__PURE__ */ Object.freeze({
      method: "provider.install.start",
      procedureType: "mutation",
      mutating: true,
    }),
    "provider.install.subscribe": /* @__PURE__ */ Object.freeze({
      method: "provider.install.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "provider.install.stop": /* @__PURE__ */ Object.freeze({
      method: "provider.install.stop",
      procedureType: "mutation",
      mutating: true,
    }),
    "provider.installUpdate.start": /* @__PURE__ */ Object.freeze({
      method: "provider.installUpdate.start",
      procedureType: "mutation",
      mutating: true,
    }),
    "provider.installUpdate.subscribe": /* @__PURE__ */ Object.freeze({
      method: "provider.installUpdate.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
  });
