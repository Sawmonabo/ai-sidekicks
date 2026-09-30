// The `provider.*` wire surface: each provider's own settings on this machine,
// read and changed apart from its accounts.
//
// A provider's section holds what belongs to the provider rather than to one
// account: whether its command is installed and which version, where that
// command lives, whether new sessions may start on it, how many helper processes
// it may run at once, where it compacts automatically, Claude Code's output
// style, Codex's shared terminal service, Claude Code's terminal plugin, the
// paths it refuses an agent, the standing rules it keeps in its own files, and
// the one-press install of a missing command. The accounts half is the
// `providerAccount.*` surface beside this one.
//
// Every figure a knob is bounded by is read from the provider, never written
// here: the compaction stops come from the provider's own models, and the output
// styles from the installed build's own listing. The daemon holds the settings
// in one table and hands them to the provider as flag settings at each start or
// mid-session, never by writing the provider's own files. The standing rules are
// the one exception, because they are the provider's: they are read from and
// revoked in the provider's own files, and the daemon keeps no copy.
//
// None of this is a session event: a machine-level setting has no session to
// belong to, and nothing here appends to a session's log.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import {
  ProviderAccountIdSchema,
  ProviderNameSchema,
  type ProviderAccountId,
  type ProviderName,
} from "./provider-account.js";
import { REPO_PATH_MAX_LEN, RepoMountIdSchema, type RepoMountId } from "./repo.js";
import { wireFreeFormString } from "./session.js";

// --------------------------------------------------------------------------
// Length caps
// --------------------------------------------------------------------------

/** A provider command's version as the command itself reports it. */
export const PROVIDER_VERSION_MAX_LEN = 64;
/** One output style's name, in the installed build's own spelling. */
export const PROVIDER_OUTPUT_STYLE_NAME_MAX_LEN = 128;
/** The one line the build's own listing gives a style. */
export const PROVIDER_OUTPUT_STYLE_DESCRIPTION_MAX_LEN = 512;
/** How many output styles one build may list. */
export const PROVIDER_OUTPUT_STYLES_MAX = 256;
/** One protected-path pattern or one standing rule, in the provider's own words. */
export const PROVIDER_RULE_TEXT_MAX_LEN = 4096;
/** A standing rule's decision word, carried as the provider spells it. */
export const PROVIDER_RULE_DECISION_MAX_LEN = 64;
/** The daemon-minted id of one standing rule. */
export const PROVIDER_STANDING_RULE_ID_MAX_LEN = 256;
/** The installer's own last lines, credential-shaped strings removed. */
export const PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN = 4096;
/** The installer command a failed install shows, for running it by hand. */
export const PROVIDER_INSTALL_COMMAND_MAX_LEN = 1024;

// --------------------------------------------------------------------------
// The provider's command: installed, too old, missing, or undecided
// --------------------------------------------------------------------------

/**
 * What the provider check found where the command resolves.
 *
 * Four readings and never a guess. `installed` names the version the command
 * reports. `tooOld` is installed below the version this build supports and names
 * the version that is needed. `notInstalled` found nothing runnable. The
 * `indeterminate` arm is the check that could not settle, which reads `Cannot
 * tell right now` and is never folded into either of the others.
 */
export type ProviderInstallation =
  | { state: "installed"; version: string }
  | { state: "tooOld"; version: string; neededVersion: string }
  | { state: "notInstalled" }
  | { state: "indeterminate" };

const providerVersionSchema = wireFreeFormString(PROVIDER_VERSION_MAX_LEN, "provider version");

/** Parses a {@link ProviderInstallation}. */
export const ProviderInstallationSchema: z.ZodType<ProviderInstallation> = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("installed"), version: providerVersionSchema }).strict(),
    z
      .object({
        state: z.literal("tooOld"),
        version: providerVersionSchema,
        neededVersion: providerVersionSchema,
      })
      .strict(),
    z.object({ state: z.literal("notInstalled") }).strict(),
    z.object({ state: z.literal("indeterminate") }).strict(),
  ],
);

// --------------------------------------------------------------------------
// The knobs a provider's section draws
// --------------------------------------------------------------------------

/**
 * `Compact automatically at <N>% full`. `lowest` and `highest` are the lowest
 * bottom stop and the highest top stop that provider's models report, and the
 * value moves between them in steps of five.
 */
export interface ProviderAutoCompactBound {
  value: number;
  lowest: number;
  highest: number;
}

const percentSchema = z.number().int().min(0).max(100);

/** Parses a {@link ProviderAutoCompactBound}; the value sits on a step of five within the stops. */
export const ProviderAutoCompactBoundSchema: z.ZodType<ProviderAutoCompactBound> = z
  .object({ value: percentSchema.multipleOf(5), lowest: percentSchema, highest: percentSchema })
  .strict()
  .superRefine((bound, context) => {
    if (bound.value < bound.lowest || bound.value > bound.highest) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "the compaction bound sits between the lowest and the highest stop",
      });
    }
  });

/** One output style the installed build lists, with the one line it gives it (none on `default`). */
export interface ProviderOutputStyle {
  name: string;
  description?: string | undefined;
}

/** Claude Code's output style: the one the build is on, among the build's own styles. */
export interface ProviderOutputStyleSetting {
  current: string;
  styles: ProviderOutputStyle[];
}

const outputStyleNameSchema = wireFreeFormString(
  PROVIDER_OUTPUT_STYLE_NAME_MAX_LEN,
  "provider output style",
);

/** Parses a {@link ProviderOutputStyleSetting}; the current style is one the build lists. */
export const ProviderOutputStyleSettingSchema: z.ZodType<ProviderOutputStyleSetting> = z
  .object({
    current: outputStyleNameSchema,
    styles: z
      .array(
        z
          .object({
            name: outputStyleNameSchema,
            description: wireFreeFormString(
              PROVIDER_OUTPUT_STYLE_DESCRIPTION_MAX_LEN,
              "provider output style description",
            ).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(PROVIDER_OUTPUT_STYLES_MAX),
  })
  .strict()
  .superRefine((setting, context) => {
    if (!setting.styles.some((style) => style.name === setting.current)) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "the current output style is one the installed build lists",
      });
    }
  });

/**
 * One provider's section as `provider.list` reads it.
 *
 * `commandPath` is `null` while the person has typed none, which reads
 * `Auto-detect`. `helpersAtOnce` is `0` where the provider decides. The
 * compaction bound and the output style are `null` until the provider has been
 * read, which a command that is missing or undecided never is. The output style
 * and the terminal plugin are Claude Code's alone and the shared terminal service
 * is Codex's alone, so each provider's row carries only its own.
 */
export type ProviderSettings = ClaudeProviderSettings | CodexProviderSettings;

interface ProviderSettingsCommon {
  installation: ProviderInstallation;
  commandPath: string | null;
  availableForNewSessions: boolean;
  helpersAtOnce: number;
  autoCompactPercent: ProviderAutoCompactBound | null;
}

/** Claude Code's section. */
export interface ClaudeProviderSettings extends ProviderSettingsCommon {
  provider: "claude";
  outputStyle: ProviderOutputStyleSetting | null;
  /** Whether the app's plugin is in the person's own Claude Code (`Use Sidekicks in terminal Claude Code`). */
  terminalPluginEnabled: boolean;
}

/** Codex's section. */
export interface CodexProviderSettings extends ProviderSettingsCommon {
  provider: "codex";
  /** `Reach Codex sessions started in a terminal`: the shared Codex service runs while this is on. */
  terminalSessionsReachable: boolean;
}

const commandPathSchema = wireFreeFormString(REPO_PATH_MAX_LEN, "provider command path");
const helpersAtOnceSchema = z.number().int().min(0);

const providerSettingsCommonShape = {
  installation: ProviderInstallationSchema,
  commandPath: commandPathSchema.nullable(),
  availableForNewSessions: z.boolean(),
  helpersAtOnce: helpersAtOnceSchema,
  autoCompactPercent: ProviderAutoCompactBoundSchema.nullable(),
};

/** Parses a {@link ProviderSettings} row. */
export const ProviderSettingsSchema: z.ZodType<ProviderSettings> = z.discriminatedUnion(
  "provider",
  [
    z
      .object({
        provider: z.literal("claude"),
        ...providerSettingsCommonShape,
        outputStyle: ProviderOutputStyleSettingSchema.nullable(),
        terminalPluginEnabled: z.boolean(),
      })
      .strict(),
    z
      .object({
        provider: z.literal("codex"),
        ...providerSettingsCommonShape,
        terminalSessionsReachable: z.boolean(),
      })
      .strict(),
  ],
);

/** The reply every `provider.*` change settles with: the section as the provider accepted it. */
export interface ProviderSettingsResponse {
  settings: ProviderSettings;
}

/** Parses a {@link ProviderSettingsResponse}. */
export const ProviderSettingsResponseSchema: z.ZodType<ProviderSettingsResponse> = z
  .object({ settings: ProviderSettingsSchema })
  .strict();

/** A request naming one provider. */
export interface ProviderRequest {
  provider: ProviderName;
}

/** Parses a {@link ProviderRequest}. */
export const ProviderRequestSchema: z.ZodType<ProviderRequest, ProviderRequest> = z
  .object({ provider: ProviderNameSchema })
  .strict();

/** An acknowledgement that carries nothing: the outcome arrives elsewhere. */
export type ProviderAckResponse = Record<string, never>;

/** Parses a {@link ProviderAckResponse}. */
export const ProviderAckResponseSchema: z.ZodType<ProviderAckResponse> = z.object({}).strict();

// --------------------------------------------------------------------------
// provider.list
// --------------------------------------------------------------------------

/** `provider.list` takes nothing: it reads every provider on this machine. */
export type ProviderListRequest = Record<string, never>;

/** Parses a {@link ProviderListRequest}. */
export const ProviderListRequestSchema: z.ZodType<ProviderListRequest, ProviderListRequest> = z
  .object({})
  .strict();

/** Each provider's section, one row per provider. */
export interface ProviderListResponse {
  providers: ProviderSettings[];
}

/** Parses a {@link ProviderListResponse}. */
export const ProviderListResponseSchema: z.ZodType<ProviderListResponse> = z
  .object({ providers: z.array(ProviderSettingsSchema) })
  .strict();

// --------------------------------------------------------------------------
// provider.update
// --------------------------------------------------------------------------

/**
 * One knob changed, one member per press.
 *
 * `commandPath: null` returns the command to `Auto-detect`; a new path is checked
 * again where it now points and the provider's model catalog is read again.
 * `outputStyle` is Claude Code's alone and `terminalSessionsReachable` Codex's
 * alone. A `helpersAtOnce` outside the range the provider accepts settles on the
 * nearest one it does, and the reply carries the value that settled.
 */
export interface ProviderUpdateRequest {
  provider: ProviderName;
  commandPath?: string | null | undefined;
  availableForNewSessions?: boolean | undefined;
  helpersAtOnce?: number | undefined;
  autoCompactPercent?: number | undefined;
  outputStyle?: string | undefined;
  terminalSessionsReachable?: boolean | undefined;
}

const PROVIDER_UPDATE_SETTING_KEYS = [
  "commandPath",
  "availableForNewSessions",
  "helpersAtOnce",
  "autoCompactPercent",
  "outputStyle",
  "terminalSessionsReachable",
] as const;

/** Parses a {@link ProviderUpdateRequest}: exactly one knob, and only one its provider has. */
export const ProviderUpdateRequestSchema: z.ZodType<ProviderUpdateRequest, ProviderUpdateRequest> =
  z
    .object({
      provider: ProviderNameSchema,
      commandPath: commandPathSchema.nullable().optional(),
      availableForNewSessions: z.boolean().optional(),
      helpersAtOnce: helpersAtOnceSchema.optional(),
      autoCompactPercent: percentSchema.multipleOf(5).optional(),
      outputStyle: outputStyleNameSchema.optional(),
      terminalSessionsReachable: z.boolean().optional(),
    })
    .strict()
    .superRefine((request, context) => {
      const present = PROVIDER_UPDATE_SETTING_KEYS.filter((key) => request[key] !== undefined);
      if (present.length !== 1) {
        context.addIssue({
          code: "custom",
          path: [],
          message: `provider.update changes exactly one setting; this request carries ${String(present.length)}`,
        });
        return;
      }
      if (request.outputStyle !== undefined && request.provider !== "claude") {
        context.addIssue({
          code: "custom",
          path: ["outputStyle"],
          message: "the output style is Claude Code's alone",
        });
      }
      if (request.terminalSessionsReachable !== undefined && request.provider !== "codex") {
        context.addIssue({
          code: "custom",
          path: ["terminalSessionsReachable"],
          message: "the shared terminal service is Codex's alone",
        });
      }
    });

// --------------------------------------------------------------------------
// provider.terminalPluginUpdate
// --------------------------------------------------------------------------

/**
 * Put the app's terminal plugin into the person's own Claude Code, or take it
 * out. On, Claude Code's own plugin commands add the app's plugin folder as a
 * marketplace and install the plugin, and one `env` key switches plugin hooks
 * on; off removes exactly those three and nothing the person added.
 */
export interface ProviderTerminalPluginUpdateRequest {
  provider: "claude";
  enabled: boolean;
}

/** Parses a {@link ProviderTerminalPluginUpdateRequest}; the plugin is Claude Code's alone. */
export const ProviderTerminalPluginUpdateRequestSchema: z.ZodType<
  ProviderTerminalPluginUpdateRequest,
  ProviderTerminalPluginUpdateRequest
> = z.object({ provider: z.literal("claude"), enabled: z.boolean() }).strict();

// --------------------------------------------------------------------------
// provider.protectedPathList
// --------------------------------------------------------------------------

/**
 * One path an agent is refused on this provider, and where it came from: the
 * credential files this app always protects, or a deny rule the person set in
 * the provider's own configuration, global or in a project. Read-only: nothing
 * here adds, edits or removes an entry.
 */
export type ProviderProtectedPath =
  | { pattern: string; source: "builtIn" }
  | { pattern: string; source: "global"; sourcePath: string }
  | { pattern: string; source: "project"; sourcePath: string; repoMountId: RepoMountId };

const rulePatternSchema = wireFreeFormString(PROVIDER_RULE_TEXT_MAX_LEN, "provider rule text");
const sourcePathSchema = wireFreeFormString(REPO_PATH_MAX_LEN, "provider rule source path");

/** Parses a {@link ProviderProtectedPath}. */
export const ProviderProtectedPathSchema: z.ZodType<ProviderProtectedPath> = z.discriminatedUnion(
  "source",
  [
    z.object({ pattern: rulePatternSchema, source: z.literal("builtIn") }).strict(),
    z
      .object({
        pattern: rulePatternSchema,
        source: z.literal("global"),
        sourcePath: sourcePathSchema,
      })
      .strict(),
    z
      .object({
        pattern: rulePatternSchema,
        source: z.literal("project"),
        sourcePath: sourcePathSchema,
        repoMountId: RepoMountIdSchema,
      })
      .strict(),
  ],
);

/** The paths one provider refuses. */
export interface ProviderProtectedPathListResponse {
  provider: ProviderName;
  entries: ProviderProtectedPath[];
}

/** Parses a {@link ProviderProtectedPathListResponse}. */
export const ProviderProtectedPathListResponseSchema: z.ZodType<ProviderProtectedPathListResponse> =
  z
    .object({ provider: ProviderNameSchema, entries: z.array(ProviderProtectedPathSchema) })
    .strict();

// --------------------------------------------------------------------------
// provider.standingRuleList / provider.standingRuleRevoke
// --------------------------------------------------------------------------
//
// The provider's own standing rules, read from its own files on every read and
// never from a copy the daemon keeps: Codex's `.rules` files under each account
// home and each trusted project, and Claude Code's `permissions` in its user,
// project and project-local settings files. The console's own remembered rules
// are a separate store and never appear here.

/** The daemon-minted id of one standing rule, derived from where the rule sits and what it says. */
export type ProviderStandingRuleId = string & { readonly __brand: "ProviderStandingRuleId" };

/** Parses a {@link ProviderStandingRuleId}. */
export const ProviderStandingRuleIdSchema: z.ZodType<
  ProviderStandingRuleId,
  ProviderStandingRuleId
> = z
  .string()
  .min(1)
  .max(PROVIDER_STANDING_RULE_ID_MAX_LEN)
  .brand<"ProviderStandingRuleId">() as unknown as z.ZodType<
  ProviderStandingRuleId,
  ProviderStandingRuleId
>;

/** Where a standing rule holds: one account's home, or one attached project. */
export type ProviderStandingRuleScope =
  | { kind: "accountHome"; accountId: ProviderAccountId }
  | { kind: "project"; repoMountId: RepoMountId };

/**
 * One standing rule in the provider's own words: `decision` is the provider's
 * own word for what the rule does (Codex's `allow`, `prompt` or `forbidden`,
 * Claude Code's `allow`, `ask` or `deny`), and `text` the rule as its file holds
 * it.
 */
export interface ProviderStandingRule {
  ruleId: ProviderStandingRuleId;
  scope: ProviderStandingRuleScope;
  sourcePath: string;
  decision: string;
  text: string;
}

/** Parses a {@link ProviderStandingRule}. */
export const ProviderStandingRuleSchema: z.ZodType<ProviderStandingRule> = z
  .object({
    ruleId: ProviderStandingRuleIdSchema,
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("accountHome"), accountId: ProviderAccountIdSchema }).strict(),
      z.object({ kind: z.literal("project"), repoMountId: RepoMountIdSchema }).strict(),
    ]),
    sourcePath: sourcePathSchema,
    decision: wireFreeFormString(PROVIDER_RULE_DECISION_MAX_LEN, "provider rule decision"),
    text: rulePatternSchema,
  })
  .strict();

/** One provider's standing rules on this machine; an empty list means it holds none. */
export interface ProviderStandingRuleListResponse {
  provider: ProviderName;
  rules: ProviderStandingRule[];
}

/** Parses a {@link ProviderStandingRuleListResponse}. */
export const ProviderStandingRuleListResponseSchema: z.ZodType<ProviderStandingRuleListResponse> = z
  .object({ provider: ProviderNameSchema, rules: z.array(ProviderStandingRuleSchema) })
  .strict();

/** Remove one standing rule where the provider keeps it; it applies from the next tool call. */
export interface ProviderStandingRuleRevokeRequest {
  provider: ProviderName;
  ruleId: ProviderStandingRuleId;
}

/** Parses a {@link ProviderStandingRuleRevokeRequest}. */
export const ProviderStandingRuleRevokeRequestSchema: z.ZodType<
  ProviderStandingRuleRevokeRequest,
  ProviderStandingRuleRevokeRequest
> = z.object({ provider: ProviderNameSchema, ruleId: ProviderStandingRuleIdSchema }).strict();

/**
 * `revoked` when the rule was removed from its file, `alreadyAbsent` when the
 * file no longer held it, so revoking twice settles the same way.
 */
export interface ProviderStandingRuleRevokeResponse {
  ruleId: ProviderStandingRuleId;
  outcome: "revoked" | "alreadyAbsent";
}

/** Parses a {@link ProviderStandingRuleRevokeResponse}. */
export const ProviderStandingRuleRevokeResponseSchema: z.ZodType<ProviderStandingRuleRevokeResponse> =
  z
    .object({
      ruleId: ProviderStandingRuleIdSchema,
      outcome: z.enum(["revoked", "alreadyAbsent"]),
    })
    .strict();

// --------------------------------------------------------------------------
// provider.install / provider.installSubscribe / provider.installStop
// --------------------------------------------------------------------------
//
// `Install` runs the provider's own installer where the service runs, as the
// person, with its input empty and a 15-minute limit; `provider.installStop`
// stops it and everything it started. The install is keyed by provider, so a
// page opened while one runs finds it, and the stream's first message is that
// provider's last outcome.

/** Where one provider's install has got to. */
export type ProviderInstallProgress =
  | { provider: ProviderName; state: "running" }
  | { provider: ProviderName; state: "installed" }
  | { provider: ProviderName; state: "failed"; reason: string; command: string };

/** Parses a {@link ProviderInstallProgress}. */
export const ProviderInstallProgressSchema: z.ZodType<ProviderInstallProgress> =
  z.discriminatedUnion("state", [
    z.object({ provider: ProviderNameSchema, state: z.literal("running") }).strict(),
    z.object({ provider: ProviderNameSchema, state: z.literal("installed") }).strict(),
    z
      .object({
        provider: ProviderNameSchema,
        state: z.literal("failed"),
        reason: wireFreeFormString(PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN, "install reason"),
        command: wireFreeFormString(PROVIDER_INSTALL_COMMAND_MAX_LEN, "install command"),
      })
      .strict(),
  ]);

// --------------------------------------------------------------------------
// Refusals
// --------------------------------------------------------------------------

/**
 * The provider's command is not installed, so a setting that needs it cannot be
 * turned on: `Available for new sessions`, the shared terminal service, and the
 * terminal plugin.
 */
export const PROVIDER_NOT_INSTALLED_CODE = "provider.not_installed" as const;
export type ProviderNotInstalledCode = typeof PROVIDER_NOT_INSTALLED_CODE;

/** The provider is the last one available for new sessions, and one has to stay available. */
export const PROVIDER_LAST_AVAILABLE_CODE = "provider.last_available" as const;
export type ProviderLastAvailableCode = typeof PROVIDER_LAST_AVAILABLE_CODE;

/** Nothing runnable sits at the command path the person typed. */
export const PROVIDER_COMMAND_NOT_RUNNABLE_CODE = "provider.command_not_runnable" as const;
export type ProviderCommandNotRunnableCode = typeof PROVIDER_COMMAND_NOT_RUNNABLE_CODE;

// --------------------------------------------------------------------------
// The method table
// --------------------------------------------------------------------------

export interface ProviderMethodDescriptors {
  readonly "provider.list": MethodDescriptor<
    "provider.list",
    ProviderListRequest,
    ProviderListResponse
  >;
  readonly "provider.update": MethodDescriptor<
    "provider.update",
    ProviderUpdateRequest,
    ProviderSettingsResponse
  >;
  readonly "provider.probe": MethodDescriptor<
    "provider.probe",
    ProviderRequest,
    ProviderSettingsResponse
  >;
  readonly "provider.terminalPluginUpdate": MethodDescriptor<
    "provider.terminalPluginUpdate",
    ProviderTerminalPluginUpdateRequest,
    ProviderSettingsResponse
  >;
  readonly "provider.protectedPathList": MethodDescriptor<
    "provider.protectedPathList",
    ProviderRequest,
    ProviderProtectedPathListResponse
  >;
  readonly "provider.standingRuleList": MethodDescriptor<
    "provider.standingRuleList",
    ProviderRequest,
    ProviderStandingRuleListResponse
  >;
  readonly "provider.standingRuleRevoke": MethodDescriptor<
    "provider.standingRuleRevoke",
    ProviderStandingRuleRevokeRequest,
    ProviderStandingRuleRevokeResponse
  >;
  readonly "provider.install": MethodDescriptor<
    "provider.install",
    ProviderRequest,
    ProviderAckResponse
  >;
  readonly "provider.installSubscribe": SubscriptionMethodDescriptor<
    "provider.installSubscribe",
    ProviderRequest,
    SubscribeAckResponse,
    ProviderInstallProgress
  >;
  readonly "provider.installStop": MethodDescriptor<
    "provider.installStop",
    ProviderRequest,
    ProviderAckResponse
  >;
}

/** Every `provider.*` method: its name, how it answers, and its shapes. */
export const PROVIDER_METHOD_DESCRIPTORS: ProviderMethodDescriptors = defineMethodDescriptors({
  "provider.list": {
    method: "provider.list",
    procedureType: "query",
    mutating: false,
    requestSchema: ProviderListRequestSchema,
    responseSchema: ProviderListResponseSchema,
  },
  "provider.update": {
    method: "provider.update",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProviderUpdateRequestSchema,
    responseSchema: ProviderSettingsResponseSchema,
  },
  "provider.probe": {
    method: "provider.probe",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderSettingsResponseSchema,
  },
  "provider.terminalPluginUpdate": {
    method: "provider.terminalPluginUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProviderTerminalPluginUpdateRequestSchema,
    responseSchema: ProviderSettingsResponseSchema,
  },
  "provider.protectedPathList": {
    method: "provider.protectedPathList",
    procedureType: "query",
    mutating: false,
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderProtectedPathListResponseSchema,
  },
  "provider.standingRuleList": {
    method: "provider.standingRuleList",
    procedureType: "query",
    mutating: false,
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderStandingRuleListResponseSchema,
  },
  "provider.standingRuleRevoke": {
    method: "provider.standingRuleRevoke",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProviderStandingRuleRevokeRequestSchema,
    responseSchema: ProviderStandingRuleRevokeResponseSchema,
  },
  "provider.install": {
    method: "provider.install",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderAckResponseSchema,
  },
  "provider.installSubscribe": {
    method: "provider.installSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: ProviderRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: ProviderInstallProgressSchema,
  },
  "provider.installStop": {
    method: "provider.installStop",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderAckResponseSchema,
  },
});
