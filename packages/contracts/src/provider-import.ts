// Importing a provider's own existing conversations into the sessions list:
// `session.importPreview`, `session.import`, `session.importSubscribe` and
// `session.importStop`.
//
// An import reads the provider's own session folders when it is started and
// keeps nothing between starts, so a conversation finished a moment ago is in
// the read. It skips every conversation the console already holds and says how
// many it skipped.
//
// ONE IMPORT PER PROVIDER, AND IT OUTLIVES WHATEVER IS WATCHING IT. The import
// belongs to the service, never to the page that started it: a page that closes
// and comes back finds the same import still running. So a second
// `session.import` for a provider whose import is running answers that import's
// own id and starts nothing, which is what keeps two imports of one store from
// ever running side by side. The stream is keyed by provider rather than by
// import id for the same reason: a reloaded page knows the provider and not the
// id. The service keeps each provider's last outcome, with its failed files,
// until that provider's next import, and the stream's first message sends it, so
// the settled line reads the same after a reload or an app restart.
//
// None of this is a session event: an import produces ordinary sessions, and the
// progress of reading a provider's store belongs to no session's log.
import { z } from "zod";

import { countSchema } from "./internal/wire-scalars.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";

/** The daemon-minted id of one import. */
export const PROVIDER_IMPORT_ID_MAX_LEN = 256;
/** A reason the service gives, in its own words. */
export const PROVIDER_IMPORT_REASON_MAX_LEN = 1024;
/** A project's name as the settled line names it. */
export const PROVIDER_IMPORT_PROJECT_NAME_MAX_LEN = 256;
/** How many failures, unreadable files or attached projects one settled line may list. */
export const PROVIDER_IMPORT_LIST_MAX = 10_000;

/** The daemon-minted id of one import. Opaque to every client. */
export type ProviderImportId = string & { readonly __brand: "ProviderImportId" };

/** Parses a {@link ProviderImportId}. */
export const ProviderImportIdSchema: z.ZodType<ProviderImportId, ProviderImportId> = z
  .string()
  .min(1)
  .max(PROVIDER_IMPORT_ID_MAX_LEN)
  .brand<"ProviderImportId">() as unknown as z.ZodType<ProviderImportId, ProviderImportId>;

/** A request naming the provider whose conversations are imported. */
export interface ProviderImportProviderRequest {
  provider: ProviderName;
}

/** Parses a {@link ProviderImportProviderRequest}. */
export const ProviderImportProviderRequestSchema: z.ZodType<
  ProviderImportProviderRequest,
  ProviderImportProviderRequest
> = z.object({ provider: ProviderNameSchema }).strict();

// --------------------------------------------------------------------------
// session.importPreview
// --------------------------------------------------------------------------

/**
 * How many projects this console does not have the import would attach. A
 * count above zero is confirmed in place before the import runs, because
 * attaching a project trusts its folder for both providers.
 */
export interface ProviderImportPreviewResponse {
  provider: ProviderName;
  projectsToAttach: number;
}

/** Parses a {@link ProviderImportPreviewResponse}. */
export const ProviderImportPreviewResponseSchema: z.ZodType<ProviderImportPreviewResponse> = z
  .object({ provider: ProviderNameSchema, projectsToAttach: z.number().int().min(0) })
  .strict();

// --------------------------------------------------------------------------
// session.import
// --------------------------------------------------------------------------

/** The import that is now running for that provider: a new one, or the one already running. */
export interface ProviderImportStartResponse {
  importId: ProviderImportId;
}

/** Parses a {@link ProviderImportStartResponse}. */
export const ProviderImportStartResponseSchema: z.ZodType<ProviderImportStartResponse> = z
  .object({ importId: ProviderImportIdSchema })
  .strict();

// --------------------------------------------------------------------------
// session.importSubscribe
// --------------------------------------------------------------------------

/** One conversation the import could not bring in, and the service's reason. */
export interface ProviderImportFailure {
  source: string;
  reason: string;
}

/**
 * How an import ended.
 *
 * `finished` counts what was imported out of what was read (`total`), what was
 * already here, each failure with its reason, the
 * files that could not be opened, and the projects the import attached.
 * `nothingNew` found nothing to bring in and still says what was already here
 * and what could not be read, so an empty result is never a blank. `stopped`
 * leaves the sessions already read in the list. `refused` carries the service's
 * own words.
 */
export type ProviderImportOutcome =
  | {
      outcome: "finished";
      imported: number;
      total: number;
      alreadyHere: number;
      failures: ProviderImportFailure[];
      unreadableFiles: string[];
      attachedProjects: string[];
    }
  | { outcome: "nothingNew"; alreadyHere: number; unreadableFiles: string[] }
  | { outcome: "stopped" }
  | { outcome: "refused"; reason: string };

/**
 * One message on a provider's import stream: the running import's count of
 * conversations read so far, or how the last import ended.
 */
export type ProviderImportProgress =
  | { kind: "progress"; provider: ProviderName; importId: ProviderImportId; read: number }
  | {
      kind: "settled";
      provider: ProviderName;
      importId: ProviderImportId;
      settlement: ProviderImportOutcome;
    };

const importReasonSchema = wireFreeFormString(PROVIDER_IMPORT_REASON_MAX_LEN, "import reason");
const importPathSchema = wireFreeFormString(FILE_PATH_MAX_LEN, "import source path");

/** Parses a {@link ProviderImportOutcome}. */
export const ProviderImportOutcomeSchema: z.ZodType<ProviderImportOutcome> = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("finished"),
        imported: countSchema,
        total: countSchema,
        alreadyHere: countSchema,
        failures: z
          .array(z.object({ source: importPathSchema, reason: importReasonSchema }).strict())
          .max(PROVIDER_IMPORT_LIST_MAX),
        unreadableFiles: z.array(importPathSchema).max(PROVIDER_IMPORT_LIST_MAX),
        attachedProjects: z
          .array(wireFreeFormString(PROVIDER_IMPORT_PROJECT_NAME_MAX_LEN, "attached project name"))
          .max(PROVIDER_IMPORT_LIST_MAX),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("nothingNew"),
        alreadyHere: countSchema,
        unreadableFiles: z.array(importPathSchema).max(PROVIDER_IMPORT_LIST_MAX),
      })
      .strict(),
    z.object({ outcome: z.literal("stopped") }).strict(),
    z.object({ outcome: z.literal("refused"), reason: importReasonSchema }).strict(),
  ],
);

/** Parses a {@link ProviderImportProgress}. */
export const ProviderImportProgressSchema: z.ZodType<ProviderImportProgress> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("progress"),
        provider: ProviderNameSchema,
        importId: ProviderImportIdSchema,
        read: countSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("settled"),
        provider: ProviderNameSchema,
        importId: ProviderImportIdSchema,
        settlement: ProviderImportOutcomeSchema,
      })
      .strict(),
  ],
);

// --------------------------------------------------------------------------
// session.importStop
// --------------------------------------------------------------------------

/**
 * Stop one import. The conversations already read stay in the sessions list, and
 * the stopped outcome arrives on the provider's stream. Stopping an import that
 * has already settled changes nothing.
 */
export interface ProviderImportStopRequest {
  importId: ProviderImportId;
}

/** Parses a {@link ProviderImportStopRequest}. */
export const ProviderImportStopRequestSchema: z.ZodType<
  ProviderImportStopRequest,
  ProviderImportStopRequest
> = z.object({ importId: ProviderImportIdSchema }).strict();

/** `session.importStop` answers nothing more: the outcome arrives on the stream. */
export type ProviderImportStopResponse = Record<string, never>;

/** Parses a {@link ProviderImportStopResponse}. */
export const ProviderImportStopResponseSchema: z.ZodType<ProviderImportStopResponse> = z
  .object({})
  .strict();

// --------------------------------------------------------------------------
// The method table
// --------------------------------------------------------------------------

export interface SessionImportMethodDescriptors {
  readonly "session.importPreview": MethodDescriptor<
    "session.importPreview",
    ProviderImportProviderRequest,
    ProviderImportPreviewResponse
  >;
  readonly "session.import": MethodDescriptor<
    "session.import",
    ProviderImportProviderRequest,
    ProviderImportStartResponse
  >;
  readonly "session.importSubscribe": SubscriptionMethodDescriptor<
    "session.importSubscribe",
    ProviderImportProviderRequest,
    SubscribeAckResponse,
    ProviderImportProgress
  >;
  readonly "session.importStop": MethodDescriptor<
    "session.importStop",
    ProviderImportStopRequest,
    ProviderImportStopResponse
  >;
}

/** The four import methods: their names, how each answers, and their shapes. */
export const SESSION_IMPORT_METHOD_DESCRIPTORS: SessionImportMethodDescriptors =
  defineMethodDescriptors({
    "session.importPreview": {
      method: "session.importPreview",
      procedureType: "query",
      mutating: false,
      requestSchema: ProviderImportProviderRequestSchema,
      responseSchema: ProviderImportPreviewResponseSchema,
    },
    "session.import": {
      method: "session.import",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderImportProviderRequestSchema,
      responseSchema: ProviderImportStartResponseSchema,
    },
    "session.importSubscribe": {
      method: "session.importSubscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: ProviderImportProviderRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: ProviderImportProgressSchema,
    },
    "session.importStop": {
      method: "session.importStop",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ProviderImportStopRequestSchema,
      responseSchema: ProviderImportStopResponseSchema,
    },
  });
