// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Importing a provider's own conversations into the sessions list.

import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { PlacedPath, WslPlace } from "../place.js";
import type { ProviderId } from "./id.js";

/** The longest import id. */
export const PROVIDER_IMPORT_ID_MAX_LEN = 256 as const;

/** The longest reason text. */
export const PROVIDER_IMPORT_REASON_MAX_LEN = 1024 as const;

/** The longest project name in a settled line. */
export const PROVIDER_IMPORT_PROJECT_NAME_MAX_LEN = 256 as const;

/** The most failures, unreadable files or attached projects one settled line may list. */
export const PROVIDER_IMPORT_LIST_MAX = 10000 as const;

/**
 * The daemon-minted id of one import, opaque to every client.
 */
export type ProviderImportId = string & { readonly __brand: "ProviderImportId" };
/**
 * How an import ended. `nothingNew` still reports what was already here and what could not be
 * read, so an empty result is never blank; `stopped` leaves the sessions already read in the list.
 */
export type ProviderImportOutcome =
  | {
      outcome: "finished";
      /**
       * The conversations imported.
       */
      imported: number;
      /**
       * The conversations read.
       */
      total: number;
      /**
       * The conversations already here.
       */
      alreadyHere: number;
      /**
       * Each conversation not brought in, with its reason.
       *
       * @maxItems 10000
       */
      failures: ProviderImportFailure[];
      /**
       * The files that could not be opened, each with the distribution it is in.
       *
       * @maxItems 10000
       */
      unreadableFiles: PlacedPath[];
      /**
       * The projects the import attached.
       *
       * @maxItems 10000
       */
      attachedProjects: string[];
    }
  | {
      outcome: "nothingNew";
      /**
       * The conversations already here.
       */
      alreadyHere: number;
      /**
       * The files that could not be opened, each with the distribution it is in.
       *
       * @maxItems 10000
       */
      unreadableFiles: PlacedPath[];
    }
  | {
      outcome: "stopped";
    }
  | {
      outcome: "refused";
      /**
       * The service's own words.
       */
      reason: string;
    };
/**
 * One message on a provider's import stream: the running import's count of conversations read so
 * far, or how the last import ended.
 */
export type ProviderImportProgress =
  | {
      kind: "progress";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The import.
       */
      importId: ProviderImportId;
      /**
       * The conversations read so far.
       */
      read: number;
    }
  | {
      kind: "settled";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The import.
       */
      importId: ProviderImportId;
      /**
       * How it ended.
       */
      settlement: ProviderImportOutcome;
    };

/**
 * A request naming the provider whose conversations are imported.
 */
export interface SessionImportRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
}
/**
 * How many projects the app does not have the import would attach. A count above zero is
 * confirmed before the import runs, because attaching a project trusts its folder.
 */
export interface SessionImportPreviewResponse {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The projects the import would attach.
   */
  projectsToAttach: number;
}
/**
 * The import now running for that provider: a new one, or the one already running.
 */
export interface SessionImportStartResponse {
  /**
   * The import.
   */
  importId: ProviderImportId;
}
/**
 * One conversation the import could not bring in, and the service's reason.
 */
export interface ProviderImportFailure {
  /**
   * The conversation's file.
   */
  source: string;
  /**
   * The distribution the file is in, its path in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * Why it was not brought in.
   */
  reason: string;
}
/**
 * Stop one import. The conversations already read stay in the sessions list, and the stopped
 * outcome arrives on the provider's stream; stopping a settled import changes nothing.
 */
export interface SessionImportStopRequest {
  /**
   * The import.
   */
  importId: ProviderImportId;
}

/** The methods of {@link SESSION_IMPORT_METHOD_DESCRIPTORS}, each with its kind. */
export interface SessionImportMethodDescriptors {
  readonly "session.import.preview": {
    readonly method: "session.import.preview";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "session.import.start": {
    readonly method: "session.import.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.import.subscribe": {
    readonly method: "session.import.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "session.import.stop": {
    readonly method: "session.import.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link SESSION_IMPORT_METHOD_DESCRIPTORS}. */
export interface SessionImportMethodTypes {
  readonly "session.import.preview": {
    readonly params: SessionImportRequest;
    readonly result: SessionImportPreviewResponse;
  };
  readonly "session.import.start": {
    readonly params: SessionImportRequest;
    readonly result: SessionImportStartResponse;
  };
  readonly "session.import.subscribe": {
    readonly params: SessionImportRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ProviderImportProgress;
  };
  readonly "session.import.stop": {
    readonly params: SessionImportStopRequest;
    readonly result: EmptyPayload;
  };
}
/** The four import methods: their names, how each answers, and their shapes. */
export const SESSION_IMPORT_METHOD_DESCRIPTORS: SessionImportMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.import.preview": /* @__PURE__ */ Object.freeze({
      method: "session.import.preview",
      procedureType: "query",
      mutating: false,
    }),
    "session.import.start": /* @__PURE__ */ Object.freeze({
      method: "session.import.start",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.import.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.import.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "session.import.stop": /* @__PURE__ */ Object.freeze({
      method: "session.import.stop",
      procedureType: "mutation",
      mutating: true,
    }),
  });
