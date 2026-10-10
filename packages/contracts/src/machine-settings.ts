// The machine's settings file and the three service verbs that read, write and stream it.
//
// The file is `<home>/.ai-sidekicks/machine-settings.json`. The background service is its only
// writer: every client hands a change to `daemon.machineSettingsUpdate` and reads it through
// `daemon.machineSettingsRead` and `daemon.machineSettingsSubscribe`. The main process alone may
// read the file directly, and only before the service first answers. One schema describes the file
// for every reader, so a missing key reads as its default wherever it is read.
//
// The environment-name rule lives here too: the service checks a row's name against it before
// saving, and the drivers read the names they set on the processes they start from it.
import { z } from "zod";

import { AgentProviderBindingSchema, type AgentProviderBinding } from "./agent/definition.js";
import { DAEMON_DATA_FOLDER_NAME } from "./daemon/data.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { ExecutionModeSchema, type ExecutionMode } from "./repo/mount.js";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "./free-form-string.js";
import { isoDateTimeSchema, portSchema } from "./internal/wire-scalars.js";

/** Where the file sits, relative to the person's home folder. */
export const MACHINE_SETTINGS_FILE_PATH_SEGMENTS: readonly [
  typeof DAEMON_DATA_FOLDER_NAME,
  "machine-settings.json",
] = [DAEMON_DATA_FOLDER_NAME, "machine-settings.json"];

// Bounds

/**
 * The longest environment name or value. Windows caps one variable at 32,767
 * characters, the tightest limit of the three platforms.
 */
export const ENVIRONMENT_ROW_MAX_LEN = 32_767;
/** The longest editor id or call voice name. */
export const MACHINE_SETTINGS_NAME_MAX_LEN = 256;
/** The longest branch-name pattern. */
export const BRANCH_NAME_PATTERN_MAX_LEN = 256;
/** RFC 5321 caps a forward path at 320 octets. */
export const EMAIL_ADDRESS_MAX_LEN = 320;
/** RFC 1035 caps a host name at 253 characters. */
export const MAIL_SERVER_MAX_LEN = 253;

// The environment-name rule

/**
 * What an environment variable name may look like on every platform: a letter
 * or underscore, then letters, digits and underscores.
 */
export const ENVIRONMENT_NAME_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The endings that make a name credential-shaped. A credential is set on
 * Providers or in a workflow step's Credential field, never as a row.
 * `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are caught by `_KEY`.
 */
export const CREDENTIAL_NAME_SUFFIXES: readonly string[] = Object.freeze([
  "_TOKEN",
  "_SECRET",
  "_KEY",
  "_PASSWORD",
]);

/** Claude Code's two update switches, set to `1` on every Claude process to keep it pinned. */
export const CLAUDE_UPDATE_SWITCH_NAMES: readonly string[] = Object.freeze([
  "DISABLE_AUTOUPDATER",
  "DISABLE_UPDATES",
]);

/** Carries the Codex binary path into the Codex launch prelude, which never interpolates it. */
export const CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME: string = "CODEX_APP_SERVER_BIN";

/** Set to `1` on a Terminal pane's shell alone while `Simplify for a screen reader` is on. */
export const CLAUDE_SCREEN_READER_ENVIRONMENT_NAME: string = "CLAUDE_AX_SCREEN_READER";

/**
 * Names the file a Terminal pane's shell reads its mark nonce from; the shell's script deletes the
 * file and unsets the name, so the nonce never sits in an environment another program can read.
 */
export const SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME: string = "SIDEKICKS_SHELL_MARK_NONCE_FILE";

/** Carries bash's own `ENV` past the posix-mode start that loads a Terminal pane's shell script. */
export const SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME: string = "SIDEKICKS_ORIGINAL_ENV";

/** Names a Terminal pane's shell script for a bash that loads it from its first prompt command. */
export const SHELL_BASH_SCRIPT_ENVIRONMENT_NAME: string = "SIDEKICKS_BASH_SCRIPT";

/**
 * Carries the exact prompt command that loads a Terminal pane's shell script, which the script
 * takes back out of `PROMPT_COMMAND`.
 */
export const SHELL_BASH_PROMPT_LOADER_ENVIRONMENT_NAME: string = "SIDEKICKS_BASH_PROMPT_LOADER";

/** Carries zsh's own `ZDOTDIR` past the folder that loads a Terminal pane's shell script. */
export const SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME: string = "SIDEKICKS_ORIGINAL_ZDOTDIR";

/** Carries fish's own `XDG_DATA_DIRS` past the folder that loads a Terminal pane's shell script. */
export const SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME: string =
  "SIDEKICKS_ORIGINAL_XDG_DATA_DIRS";

/**
 * The names the app sets itself on the processes it starts. A row with one of
 * these names would be overwritten without a word, so it is refused at save.
 */
export const APP_SET_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  ...CLAUDE_UPDATE_SWITCH_NAMES,
  CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME,
  CLAUDE_SCREEN_READER_ENVIRONMENT_NAME,
  SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME,
  SHELL_BASH_SCRIPT_ENVIRONMENT_NAME,
  SHELL_BASH_PROMPT_LOADER_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME,
]);

/** Why a row's name is refused at save. */
export type EnvironmentNameRefusalReason = "not_a_name" | "credential_shaped" | "set_by_app";

/**
 * The reason a row's name is refused, or `null` when the name may be saved.
 * Names compare without case, because Windows reads `disable_updates` and
 * `DISABLE_UPDATES` as one variable.
 */
export function environmentNameRefusal(name: string): EnvironmentNameRefusalReason | null {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    return "not_a_name";
  }
  const upperName = name.toUpperCase();
  if (CREDENTIAL_NAME_SUFFIXES.some((suffix) => upperName.endsWith(suffix))) {
    return "credential_shaped";
  }
  if (APP_SET_ENVIRONMENT_NAMES.includes(upperName)) {
    return "set_by_app";
  }
  return null;
}

/** A row's name refused at save; nothing is written and the rows stay as they were. */
export type DaemonEnvironmentNameRefusedCode = "daemon.environment_name_refused";
/** The error code the service answers with when a row's name is refused. */
export const DAEMON_ENVIRONMENT_NAME_REFUSED_CODE: DaemonEnvironmentNameRefusedCode =
  "daemon.environment_name_refused";

/** The refused name and why, so the page marks the row it was typed into. */
export interface DaemonEnvironmentNameRefusedDetails {
  name: string;
  reason: EnvironmentNameRefusalReason;
}
// The settings

/**
 * One `name = value` row passed to every process the app starts, in
 * `Every project` or in one project's own list. The name rule is
 * {@link environmentNameRefusal}, checked by the service when a list is saved.
 */
export interface EnvironmentRow {
  name: string;
  value: string;
}
/** Parses an {@link EnvironmentRow}. */
export const EnvironmentRowSchema: z.ZodType<EnvironmentRow, EnvironmentRow> = z
  .object({
    name: z.string().min(1).max(ENVIRONMENT_ROW_MAX_LEN),
    value: z
      .string()
      .max(ENVIRONMENT_ROW_MAX_LEN)
      .refine((value) => !value.includes("\0"), { message: "An environment value has no NUL." }),
  })
  .strict();

/** The four kinds of moment a notification or a delivery can be about. */
export interface NotificationKindSwitches {
  waitingOnYou: boolean;
  finished: boolean;
  failed: boolean;
  notifyStep: boolean;
}
/** Parses a {@link NotificationKindSwitches}. */
export const NotificationKindSwitchesSchema: z.ZodType<
  NotificationKindSwitches,
  NotificationKindSwitches
> = z
  .object({
    waitingOnYou: z.boolean(),
    finished: z.boolean(),
    failed: z.boolean(),
    notifyStep: z.boolean(),
  })
  .strict();

/** How often the email digest may go out at most. */
export type EmailDigestPeriod = "hour" | "fourHours" | "day";
/** Every {@link EmailDigestPeriod}, shortest first. */
export const EMAIL_DIGEST_PERIODS: readonly EmailDigestPeriod[] = Object.freeze([
  "hour",
  "fourHours",
  "day",
]);

/**
 * The email digest's settings other than its password, which the service seals
 * in the keychain. A field left unset is `null`; `userName` unset means the
 * address itself, and `mailServer` and `port` unset mean the mail library's own
 * entry for the address's domain.
 */
export interface EmailDigestSettings {
  enabled: boolean;
  sendTo: string | null;
  mailServer: string | null;
  port: number | null;
  userName: string | null;
  after: EmailDigestPeriod;
}
const EmailDigestSettingsSchema: z.ZodType<EmailDigestSettings, EmailDigestSettings> = z
  .object({
    enabled: z.boolean(),
    sendTo: z.email().max(EMAIL_ADDRESS_MAX_LEN).nullable(),
    mailServer: wireFreeFormString(
      MAIL_SERVER_MAX_LEN,
      "EmailDigestSettings.mailServer",
    ).nullable(),
    port: portSchema.nullable(),
    userName: wireFreeFormString(EMAIL_ADDRESS_MAX_LEN, "EmailDigestSettings.userName").nullable(),
    after: z.enum(EMAIL_DIGEST_PERIODS),
  })
  .strict();

/** The web address's switch and the kinds it is sent; the address and its secret are sealed. */
export interface WebAddressSettings {
  enabled: boolean;
  kinds: NotificationKindSwitches;
}
const WebAddressSettingsSchema: z.ZodType<WebAddressSettings, WebAddressSettings> = z
  .object({ enabled: z.boolean(), kinds: NotificationKindSwitchesSchema })
  .strict();

/** Everything the Notifications page keeps in the file. */
export interface NotificationSettings {
  /** `Show a count on the app icon`. */
  appIconCount: boolean;
  /** `Notify me outside the app`, the switch above the four kinds. */
  notifyOutsideApp: boolean;
  kinds: NotificationKindSwitches;
  emailDigest: EmailDigestSettings;
  webAddress: WebAddressSettings;
}
const NotificationSettingsSchema: z.ZodType<NotificationSettings, NotificationSettings> = z
  .object({
    appIconCount: z.boolean(),
    notifyOutsideApp: z.boolean(),
    kinds: NotificationKindSwitchesSchema,
    emailDigest: EmailDigestSettingsSchema,
    webAddress: WebAddressSettingsSchema,
  })
  .strict();

/** Whether Space is held while talking or tapped to start and stop, on both providers. */
export type VoiceMode = "hold" | "tap";
/** Every {@link VoiceMode}. */
export const VOICE_MODES: readonly VoiceMode[] = Object.freeze(["hold", "tap"]);

/**
 * Voice's two settings. `callVoice`, the voice a spoken call answers in, reads as the call's own
 * default voice when unset.
 */
export interface VoiceSettings {
  mode: VoiceMode;
  callVoice: string | null;
}
const VoiceSettingsSchema: z.ZodType<VoiceSettings, VoiceSettings> = z
  .object({
    mode: z.enum(VOICE_MODES),
    callVoice: wireFreeFormString(
      MACHINE_SETTINGS_NAME_MAX_LEN,
      "VoiceSettings.callVoice",
    ).nullable(),
  })
  .strict();

/** `Back up automatically` and `Back up to`; a `folder` unset is the service's default folder. */
export interface BackupSettings {
  automatic: boolean;
  folder: string | null;
}
const BackupSettingsSchema: z.ZodType<BackupSettings, BackupSettings> = z
  .object({
    automatic: z.boolean(),
    folder: wireFreeFormString(FILE_PATH_MAX_LEN, "BackupSettings.folder").nullable(),
  })
  .strict();

/** The placeholder a branch-name pattern holds exactly once: the tail of the session's title. */
export const BRANCH_NAME_TITLE_PLACEHOLDER = "{title}";

function countOccurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Why a branch-name pattern is refused at save. */
export type BranchPatternRefusalReason = "title_not_once" | "not_a_branch_name";

/**
 * A pattern refused at save, from `Every project`'s `Branch names` or one project's own pattern;
 * nothing is written.
 */
export type DaemonBranchPatternRefusedCode = "daemon.branch_pattern_refused";
/** The error code the service answers with when a branch-name pattern is refused. */
export const DAEMON_BRANCH_PATTERN_REFUSED_CODE: DaemonBranchPatternRefusedCode =
  "daemon.branch_pattern_refused";

/** Why the pattern was refused, so the page says which rule it broke. */
export interface DaemonBranchPatternRefusedDetails {
  reason: BranchPatternRefusalReason;
}

/** Why a pattern's placeholders are refused, before git sees the name it fills in. */
export type BranchPatternPlaceholderRefusalReason = Exclude<
  BranchPatternRefusalReason,
  "not_a_branch_name"
>;

/**
 * `title_not_once` when the pattern does not hold `{title}` exactly once, or `null`. Whether the
 * filled-in name is a branch name is git's check, which the service makes after this one.
 */
export function branchPatternPlaceholderRefusal(
  pattern: string,
): BranchPatternPlaceholderRefusalReason | null {
  if (countOccurrences(pattern, BRANCH_NAME_TITLE_PLACEHOLDER) !== 1) {
    return "title_not_once";
  }
  return null;
}

/**
 * A branch-name pattern as a change carries it: bounded. Its placeholder rule and git's check are
 * the service's, refused with {@link DAEMON_BRANCH_PATTERN_REFUSED_CODE} so the page can say which.
 */
export const BranchNamePatternChangeSchema: z.ZodType<string, string> = wireFreeFormString(
  BRANCH_NAME_PATTERN_MAX_LEN,
  "branch-name pattern",
);

/**
 * A saved branch-name pattern, for `Every project` and for one project's own override: a change's
 * pattern that also holds `{title}` exactly once. A file holding any other is repaired.
 */
export const BranchNamePatternSchema: z.ZodType<string, string> =
  BranchNamePatternChangeSchema.superRefine((pattern, context) => {
    const reason = branchPatternPlaceholderRefusal(pattern);
    if (reason !== null) {
      context.addIssue({ code: "custom", message: reason });
    }
  });

/**
 * The lead's model and effort the person last picked, which a new session starts on while
 * `newSessionCarriesLastModel` is on. The service writes it each time a pick moves it; `effort`
 * `null` is the driver's default.
 */
export type LastLeadModel = Pick<AgentProviderBinding, "driverName" | "modelId" | "effort">;
const LastLeadModelSchema: z.ZodType<LastLeadModel, LastLeadModel> =
  AgentProviderBindingSchema.pick({ driverName: true, modelId: true, effort: true });

/** Every value the machine's settings file holds. */
export interface MachineSettings {
  /** `Check for updates automatically`. */
  updatesAutomatic: boolean;
  /** `Keep crash reports`. */
  keepCrashReports: boolean;
  /** `Editor that opens files`; `null` is `System default`. */
  editorId: string | null;
  /**
   * Claude Code's `Advisor` for sessions started later: one of the advisor models Claude Code
   * offers, or `null` for `Off`.
   */
  advisorModel: string | null;
  /** `Default checkout for a new project session`. */
  defaultCheckout: ExecutionMode;
  /** `Start a new session on the last model and effort used`. */
  newSessionCarriesLastModel: boolean;
  /** The last model and effort picked, `null` before the first pick. */
  lastLeadModel: LastLeadModel | null;
  /** `Keep this Mac awake while a sidekick is working`. */
  keepAwakeWhileAgentWorks: boolean;
  /** `Keep this Mac awake for other devices`, held only while on power. */
  keepAwakeForOtherDevices: boolean;
  notifications: NotificationSettings;
  /** `Remember site data`. */
  rememberSiteData: boolean;
  /** `Browser tools for sidekicks`. */
  browserToolsForAgents: boolean;
  /** `Simplify for a screen reader`, carried into the Terminal pane's shells. */
  screenReaderMode: boolean;
  /** `Every project`'s environment rows. */
  environmentRows: EnvironmentRow[];
  backup: BackupSettings;
  /** `Every project`'s `Branch names`. */
  branchNamePattern: string;
  /** `Clone new repositories into`; `null` until the person sets one. */
  cloneFolder: string | null;
  voice: VoiceSettings;
}

/** What each value is before anybody has chosen. */
export const MACHINE_SETTINGS_DEFAULTS: Readonly<MachineSettings> = Object.freeze<MachineSettings>({
  updatesAutomatic: true,
  keepCrashReports: true,
  editorId: null,
  advisorModel: null,
  defaultCheckout: "provisioned-worktree",
  newSessionCarriesLastModel: true,
  lastLeadModel: null,
  keepAwakeWhileAgentWorks: false,
  keepAwakeForOtherDevices: false,
  notifications: {
    appIconCount: true,
    notifyOutsideApp: true,
    kinds: { waitingOnYou: true, finished: true, failed: true, notifyStep: true },
    emailDigest: {
      enabled: false,
      sendTo: null,
      mailServer: null,
      port: null,
      userName: null,
      after: "day",
    },
    webAddress: {
      enabled: false,
      kinds: { waitingOnYou: true, finished: true, failed: true, notifyStep: true },
    },
  },
  rememberSiteData: true,
  browserToolsForAgents: true,
  screenReaderMode: false,
  environmentRows: [],
  backup: { automatic: false, folder: null },
  branchNamePattern: "sidekicks/{session}/{title}",
  cloneFolder: null,
  voice: { mode: "hold", callVoice: null },
});

// Each member's value schema, stated once for the whole value and for a change.
const MACHINE_SETTINGS_MEMBER_SCHEMAS = {
  updatesAutomatic: z.boolean(),
  keepCrashReports: z.boolean(),
  editorId: wireFreeFormString(
    MACHINE_SETTINGS_NAME_MAX_LEN,
    "MachineSettings.editorId",
  ).nullable(),
  advisorModel: wireFreeFormString(
    MACHINE_SETTINGS_NAME_MAX_LEN,
    "MachineSettings.advisorModel",
  ).nullable(),
  defaultCheckout: ExecutionModeSchema,
  newSessionCarriesLastModel: z.boolean(),
  lastLeadModel: LastLeadModelSchema.nullable(),
  keepAwakeWhileAgentWorks: z.boolean(),
  keepAwakeForOtherDevices: z.boolean(),
  notifications: NotificationSettingsSchema,
  rememberSiteData: z.boolean(),
  browserToolsForAgents: z.boolean(),
  screenReaderMode: z.boolean(),
  environmentRows: z.array(EnvironmentRowSchema),
  backup: BackupSettingsSchema,
  branchNamePattern: BranchNamePatternSchema,
  cloneFolder: wireFreeFormString(FILE_PATH_MAX_LEN, "MachineSettings.cloneFolder").nullable(),
  voice: VoiceSettingsSchema,
};

/** Parses a whole settings value: every member present, none unknown. */
export const MachineSettingsSchema: z.ZodType<MachineSettings> = z
  .object(MACHINE_SETTINGS_MEMBER_SCHEMAS)
  .strict();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Lays what the file holds over the defaults, member by member and group by
// group, so a key the file lacks reads as its default. A key the file holds
// that the defaults do not know is carried over, so the strict parse refuses it.
function overDefaults(defaults: Record<string, unknown>, stored: Record<string, unknown>): unknown {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, storedValue] of Object.entries(stored)) {
    const defaultValue = defaults[key];
    merged[key] =
      isPlainObject(defaultValue) && isPlainObject(storedValue)
        ? overDefaults(defaultValue, storedValue)
        : storedValue;
  }
  return merged;
}

/**
 * Reads the file's parsed JSON as settings: a missing key takes its default,
 * and an unknown key or a value out of shape refuses the whole file, which the
 * service then reads as the defaults and repairs.
 */
export function parseMachineSettingsFile(fileJson: unknown): z.ZodSafeParseResult<MachineSettings> {
  if (!isPlainObject(fileJson)) {
    return MachineSettingsSchema.safeParse(fileJson);
  }
  return MachineSettingsSchema.safeParse(
    overDefaults(MACHINE_SETTINGS_DEFAULTS as unknown as Record<string, unknown>, fileJson),
  );
}

/**
 * One change to the file: exactly one top-level member, with its whole value.
 * A group such as `notifications` is written whole, so a change to one of its
 * switches carries the group as the page last read it with that switch moved.
 */
export type MachineSettingsChange = {
  [Member in keyof MachineSettings]?: MachineSettings[Member] | undefined;
};

/**
 * Parses a {@link MachineSettingsChange}: one member, never none and never two. A pattern's
 * `{title}` rule is the service's coded refusal, not a parse failure.
 */
export const MachineSettingsChangeSchema: z.ZodType<MachineSettingsChange, MachineSettingsChange> =
  z
    .object({
      ...MACHINE_SETTINGS_MEMBER_SCHEMAS,
      branchNamePattern: BranchNamePatternChangeSchema,
    })
    .partial()
    .strict()
    .refine((change) => Object.values(change).filter((value) => value !== undefined).length === 1, {
      message: "A settings change carries exactly one member.",
    });

// The service's verbs

/** Why a settings file was found broken. */
export type SettingsFileRepairCause = "unparseable" | "schemaRefused";
/** Every {@link SettingsFileRepairCause}. */
export const SETTINGS_FILE_REPAIR_CAUSES: readonly SettingsFileRepairCause[] = Object.freeze([
  "unparseable",
  "schemaRefused",
]);

/**
 * A settings file's repair: its owner found the file broken, read the defaults in
 * its place and wrote them back. Carried until the next change is written, so the
 * page can say both happened. The machine settings file and the keyboard map both
 * carry one.
 */
export interface SettingsFileRepair {
  repairedAt: string;
  cause: SettingsFileRepairCause;
}

/** The file as the service last read or wrote it, and the repair it made, if any. */
export interface MachineSettingsReading {
  settings: MachineSettings;
  repair?: SettingsFileRepair | undefined;
}
/** Parses a {@link MachineSettingsReading}. */
export const MachineSettingsReadingSchema: z.ZodType<MachineSettingsReading> = z
  .object({
    settings: MachineSettingsSchema,
    repair: z
      .object({
        repairedAt: isoDateTimeSchema,
        cause: z.enum(SETTINGS_FILE_REPAIR_CAUSES),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `daemon.machineSettingsRead` takes nothing. */
export type MachineSettingsReadRequest = Record<string, never>;
/** Parses a {@link MachineSettingsReadRequest}. */
export const MachineSettingsReadRequestSchema: z.ZodType<
  MachineSettingsReadRequest,
  MachineSettingsReadRequest
> = z.object({}).strict();

/** `daemon.machineSettingsSubscribe` takes nothing: there is one file per machine. */
export type MachineSettingsSubscribeRequest = Record<string, never>;
/** Parses a {@link MachineSettingsSubscribeRequest}. */
export const MachineSettingsSubscribeRequestSchema: z.ZodType<
  MachineSettingsSubscribeRequest,
  MachineSettingsSubscribeRequest
> = z.object({}).strict();

/** `daemon.machineSettingsUpdate`: the one change to write. */
export interface MachineSettingsUpdateRequest {
  change: MachineSettingsChange;
}
/** Parses a {@link MachineSettingsUpdateRequest}. */
export const MachineSettingsUpdateRequestSchema: z.ZodType<
  MachineSettingsUpdateRequest,
  MachineSettingsUpdateRequest
> = z.object({ change: MachineSettingsChangeSchema }).strict();

/** The file as written. */
export interface MachineSettingsUpdateResponse {
  settings: MachineSettings;
}
/** Parses a {@link MachineSettingsUpdateResponse}. */
export const MachineSettingsUpdateResponseSchema: z.ZodType<MachineSettingsUpdateResponse> = z
  .object({ settings: MachineSettingsSchema })
  .strict();

/** The three service verbs' descriptors. */
export interface MachineSettingsMethodDescriptors {
  readonly "daemon.machineSettingsRead": MethodDescriptor<
    "daemon.machineSettingsRead",
    MachineSettingsReadRequest,
    MachineSettingsReading
  >;
  readonly "daemon.machineSettingsUpdate": MethodDescriptor<
    "daemon.machineSettingsUpdate",
    MachineSettingsUpdateRequest,
    MachineSettingsUpdateResponse
  >;
  /** The first emission is the file as it stands; each written change follows. */
  readonly "daemon.machineSettingsSubscribe": SubscriptionMethodDescriptor<
    "daemon.machineSettingsSubscribe",
    MachineSettingsSubscribeRequest,
    SubscribeAckResponse,
    MachineSettingsReading
  >;
}
/** The descriptor table of the three machine-settings verbs. */
export const MACHINE_SETTINGS_METHOD_DESCRIPTORS: MachineSettingsMethodDescriptors =
  defineMethodDescriptors({
    "daemon.machineSettingsRead": {
      method: "daemon.machineSettingsRead",
      procedureType: "query",
      mutating: false,
      requestSchema: MachineSettingsReadRequestSchema,
      responseSchema: MachineSettingsReadingSchema,
    },
    "daemon.machineSettingsUpdate": {
      method: "daemon.machineSettingsUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: MachineSettingsUpdateRequestSchema,
      responseSchema: MachineSettingsUpdateResponseSchema,
    },
    "daemon.machineSettingsSubscribe": {
      method: "daemon.machineSettingsSubscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: MachineSettingsSubscribeRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: MachineSettingsReadingSchema,
    },
  });
