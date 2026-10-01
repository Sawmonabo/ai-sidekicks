// The reads behind a session's inspector sections, and the one switch the inspector carries: what
// fills the context (the same reading feeds the composer's ring), the memory paths with the
// `Auto memory` switch, and the hooks the provider loaded. Every figure and list is the
// provider's own report for this session, read by the daemon and never computed on the screen.
import { z } from "zod";

import { composedTextSchema, countSchema, percentSchema } from "./internal/wire-scalars.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import { FILE_PATH_MAX_LEN, SessionIdSchema, type SessionId } from "./session.js";
import { SessionAddressedRequestSchema, type SessionAddressedRequest } from "./session-controls.js";

/**
 * Where the session compacts and the slider's range. The top stop is the provider's own
 * compaction point on this window; the bottom stop is the session's fixed start plus a tenth of
 * the window, rounded up, and is `null` on Codex until the first usage report says what the
 * session loads. `sessionOverride` draws the `session` mark: the bound differs from the Settings
 * default.
 */
export interface SessionCompactionBound {
  boundPercent: number;
  topStopPercent: number;
  bottomStopPercent: number | null;
  sessionOverride: boolean;
}
const SessionCompactionBoundSchema: z.ZodType<SessionCompactionBound> = z
  .object({
    boundPercent: percentSchema,
    topStopPercent: percentSchema,
    bottomStopPercent: percentSchema.nullable(),
    sessionOverride: z.boolean(),
  })
  .strict();

const CONTEXT_CATEGORY_KIND_VALUES = ["used", "deferred", "buffer", "free"] as const;

/**
 * How Claude Code marks a bucket: counted as used, deferred (dimmed and left out of the used
 * figure), the compaction buffer, or free space.
 */
export type SessionContextCategoryKind = (typeof CONTEXT_CATEGORY_KIND_VALUES)[number];

/** One named part inside a bucket: a tool, a memory file, an agent or a skill. */
export interface SessionContextPart {
  name: string;
  tokens: number;
}

/** One of Claude Code's buckets, in its own order, with the parts it names. */
export interface SessionContextCategory {
  name: string;
  tokens: number;
  kind: SessionContextCategoryKind;
  parts?: SessionContextPart[] | undefined;
}

/**
 * What fills the context, per provider. Claude Code reports named buckets; Codex reports totals
 * only, the four figures of its token-usage update.
 */
export type SessionContextBreakdown =
  | { provider: "claude"; categories: SessionContextCategory[] }
  | {
      provider: "codex";
      cachedInputTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    };

/** A path the daemon composed, held to the longest path the wire carries. */
const composedPathSchema: z.ZodString = composedTextSchema.max(FILE_PATH_MAX_LEN);

const contextPartSchema = z.object({ name: composedTextSchema, tokens: countSchema }).strict();
const contextCategorySchema = z
  .object({
    name: composedTextSchema,
    tokens: countSchema,
    kind: z.enum(CONTEXT_CATEGORY_KIND_VALUES),
    parts: z.array(contextPartSchema).optional(),
  })
  .strict();
const SessionContextBreakdownSchema: z.ZodType<SessionContextBreakdown> = z.discriminatedUnion(
  "provider",
  [
    z
      .object({ provider: z.literal("claude"), categories: z.array(contextCategorySchema) })
      .strict(),
    z
      .object({
        provider: z.literal("codex"),
        cachedInputTokens: countSchema,
        inputTokens: countSchema,
        outputTokens: countSchema,
        reasoningTokens: countSchema,
      })
      .strict(),
  ],
);

/** The used tokens against the window, and what they are made of. */
export interface SessionContextUsage {
  usedTokens: number;
  usedPercent: number;
  breakdown: SessionContextBreakdown;
}

/**
 * One reading of the session's context, which feeds the ring and the inspector's `Context`
 * section alike so the two never disagree. Every figure is the provider's own, read at creation,
 * on every model change and on each usage report. `usage` is `null` until the provider has
 * reported one, which on Codex is the first turn's report.
 */
export interface SessionContextReading {
  sessionId: SessionId;
  windowTokens: number;
  compaction: SessionCompactionBound;
  usage: SessionContextUsage | null;
}
/** Parses a {@link SessionContextReading}. */
export const SessionContextReadingSchema: z.ZodType<SessionContextReading> = z
  .object({
    sessionId: SessionIdSchema,
    windowTokens: z.number().int().positive(),
    compaction: SessionCompactionBoundSchema,
    usage: z
      .object({
        usedTokens: countSchema,
        usedPercent: percentSchema,
        breakdown: SessionContextBreakdownSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

/** One memory file or folder the provider reported for this session. */
export interface SessionMemoryEntry {
  path: string;
  kind: "file" | "folder";
}

/**
 * The inspector's `Memory` section: the account home the memory lives under, the `Auto memory`
 * switch and the memory paths. `enabledAtNextStart` is present while a change waits for the
 * provider's next start, which is how Claude Code applies the switch.
 */
export interface SessionMemoryReadResponse {
  sessionId: SessionId;
  home: string;
  autoMemory: { enabled: boolean; enabledAtNextStart?: boolean | undefined };
  entries: SessionMemoryEntry[];
}
/** Parses a {@link SessionMemoryReadResponse}. */
export const SessionMemoryReadResponseSchema: z.ZodType<SessionMemoryReadResponse> = z
  .object({
    sessionId: SessionIdSchema,
    home: composedPathSchema,
    autoMemory: z
      .object({ enabled: z.boolean(), enabledAtNextStart: z.boolean().optional() })
      .strict(),
    entries: z.array(
      z.object({ path: composedPathSchema, kind: z.enum(["file", "folder"]) }).strict(),
    ),
  })
  .strict();

/** Turns the session's `Auto memory` switch on or off. */
export interface SessionAutoMemoryUpdateRequest {
  sessionId: SessionId;
  enabled: boolean;
}
/** Parses a {@link SessionAutoMemoryUpdateRequest}. */
export const SessionAutoMemoryUpdateRequestSchema: z.ZodType<
  SessionAutoMemoryUpdateRequest,
  SessionAutoMemoryUpdateRequest
> = z.object({ sessionId: SessionIdSchema, enabled: z.boolean() }).strict();

/** The switch, and when it takes effect: at once on Codex, at the next start on Claude Code. */
export interface SessionAutoMemoryUpdateResponse {
  sessionId: SessionId;
  enabled: boolean;
  appliesAt: "now" | "next_start";
}
/** Parses a {@link SessionAutoMemoryUpdateResponse}. */
export const SessionAutoMemoryUpdateResponseSchema: z.ZodType<SessionAutoMemoryUpdateResponse> = z
  .object({
    sessionId: SessionIdSchema,
    enabled: z.boolean(),
    appliesAt: z.enum(["now", "next_start"]),
  })
  .strict();

/**
 * One hook the provider loaded for the session's folder. `event`, `source` and `trustStatus` are
 * the provider's own words, carried as sent.
 */
export interface SessionProviderHook {
  key: string;
  event: string;
  handlerType: "command" | "mcpTool" | "prompt" | "agent";
  command?: string | undefined;
  matcher?: string | undefined;
  timeoutSeconds: number;
  sourcePath: string;
  source: string;
  enabled: boolean;
  managed: boolean;
  hash: string;
  trustStatus: string;
}

/** One folder's hooks, with the errors and warnings the provider reported for it. */
export interface ProviderHookSource {
  folder: string;
  hooks: SessionProviderHook[];
  errors: { path: string; message: string }[];
  warnings: string[];
}

/**
 * The inspector's `Hooks` section, by what it lists: `loadedHooks` where the provider reports
 * the hooks it loaded (Codex), `hookFiles` where it reports none and the section lists the files
 * it reads hooks from (Claude Code). The daemon's own hooks are never listed.
 */
export type SessionHookListResponse =
  | {
      sessionId: SessionId;
      provider: ProviderName;
      kind: "loadedHooks";
      folders: ProviderHookSource[];
    }
  | { sessionId: SessionId; provider: ProviderName; kind: "hookFiles"; files: { path: string }[] };
/** Parses a {@link SessionHookListResponse}. */
export const SessionHookListResponseSchema: z.ZodType<SessionHookListResponse> =
  z.discriminatedUnion("kind", [
    z
      .object({
        sessionId: SessionIdSchema,
        provider: ProviderNameSchema,
        kind: z.literal("loadedHooks"),
        folders: z.array(
          z
            .object({
              folder: composedPathSchema,
              hooks: z.array(
                z
                  .object({
                    key: composedTextSchema,
                    event: composedTextSchema,
                    handlerType: z.enum(["command", "mcpTool", "prompt", "agent"]),
                    command: composedTextSchema.optional(),
                    matcher: composedTextSchema.optional(),
                    timeoutSeconds: countSchema,
                    sourcePath: composedPathSchema,
                    source: composedTextSchema,
                    enabled: z.boolean(),
                    managed: z.boolean(),
                    hash: composedTextSchema,
                    trustStatus: composedTextSchema,
                  })
                  .strict(),
              ),
              errors: z.array(
                z.object({ path: composedPathSchema, message: composedTextSchema }).strict(),
              ),
              warnings: z.array(composedTextSchema),
            })
            .strict(),
        ),
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        provider: ProviderNameSchema,
        kind: z.literal("hookFiles"),
        files: z.array(z.object({ path: composedPathSchema }).strict()),
      })
      .strict(),
  ]);

/** The inspector's methods, keyed by method name. */
export interface SessionInspectorMethodDescriptors {
  readonly "session.contextSubscribe": SubscriptionMethodDescriptor<
    "session.contextSubscribe",
    SessionAddressedRequest,
    SubscribeAckResponse,
    SessionContextReading
  >;
  readonly "session.memoryRead": MethodDescriptor<
    "session.memoryRead",
    SessionAddressedRequest,
    SessionMemoryReadResponse
  >;
  readonly "session.autoMemoryUpdate": MethodDescriptor<
    "session.autoMemoryUpdate",
    SessionAutoMemoryUpdateRequest,
    SessionAutoMemoryUpdateResponse
  >;
  readonly "session.hookList": MethodDescriptor<
    "session.hookList",
    SessionAddressedRequest,
    SessionHookListResponse
  >;
}

/** The inspector methods' wire contract: name, procedure type and schemas. */
export const SESSION_INSPECTOR_METHOD_DESCRIPTORS: SessionInspectorMethodDescriptors =
  defineMethodDescriptors({
    "session.contextSubscribe": {
      method: "session.contextSubscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: SessionAddressedRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: SessionContextReadingSchema,
    },
    "session.memoryRead": {
      method: "session.memoryRead",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionAddressedRequestSchema,
      responseSchema: SessionMemoryReadResponseSchema,
    },
    "session.autoMemoryUpdate": {
      method: "session.autoMemoryUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionAutoMemoryUpdateRequestSchema,
      responseSchema: SessionAutoMemoryUpdateResponseSchema,
    },
    "session.hookList": {
      method: "session.hookList",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionAddressedRequestSchema,
      responseSchema: SessionHookListResponseSchema,
    },
  });
