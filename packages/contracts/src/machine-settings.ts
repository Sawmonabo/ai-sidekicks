// The machine's settings file and the three service verbs that read, write and
// stream it.
//
// The file is `<home>/.ai-sidekicks/machine-settings.json`. The background
// service is its only writer: the main process and every other device hand a
// change to `daemon.machineSettingsUpdate`, and every console window reads it
// through `daemon.machineSettingsRead` and `daemon.machineSettingsSubscribe`.
// The main process alone may read the file directly, and only before the
// service first answers, for the two values it needs at start. One schema
// describes the file for both readers, so a missing key reads as its default
// wherever it is read.
//
// The environment-name rule lives here too, because both the main process and
// the service check a name against it before a row is saved, and the service
// builds each process's environment from the same list of names it sets itself.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { ExecutionModeSchema, type ExecutionMode } from "./repo.js";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "./session.js";

/** Where the file sits, relative to the person's home folder. */
export const MACHINE_SETTINGS_FILE_PATH_SEGMENTS: readonly [
  ".ai-sidekicks",
  "machine-settings.json",
] = [".ai-sidekicks", "machine-settings.json"];

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

/**
 * The names the app sets itself on the processes it starts. A row with one of
 * these names would be overwritten without a word, so it is refused at save.
 */
export const APP_SET_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  ...CLAUDE_UPDATE_SWITCH_NAMES,
  CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME,
  "CLAUDE_AX_SCREEN_READER",
]);

/** Why a row's name is refused at save. */
export type EnvironmentNameRefusalReason = "notAName" | "credentialShaped" | "setByApp";
/** Every {@link EnvironmentNameRefusalReason}, in the order the rule checks them. */
export const ENVIRONMENT_NAME_REFUSAL_REASONS: readonly EnvironmentNameRefusalReason[] =
  Object.freeze(["notAName", "credentialShaped", "setByApp"]);

/**
 * The reason a row's name is refused, or `null` when the name may be saved.
 * Names compare without case, because Windows reads `disable_updates` and
 * `DISABLE_UPDATES` as one variable.
 */
export function environmentNameRefusal(name: string): EnvironmentNameRefusalReason | null {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    return "notAName";
  }
  const upperName = name.toUpperCase();
  if (CREDENTIAL_NAME_SUFFIXES.some((suffix) => upperName.endsWith(suffix))) {
    return "credentialShaped";
  }
  if (APP_SET_ENVIRONMENT_NAMES.includes(upperName)) {
    return "setByApp";
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
/** Parses {@link DaemonEnvironmentNameRefusedDetails}. */
export const DaemonEnvironmentNameRefusedDetailsSchema: z.ZodType<DaemonEnvironmentNameRefusedDetails> =
  z
    .object({
      name: z.string().max(ENVIRONMENT_ROW_MAX_LEN),
      reason: z.enum(ENVIRONMENT_NAME_REFUSAL_REASONS),
    })
    .strict();

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
    port: z.number().int().min(1).max(65_535).nullable(),
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

/** Voice's two settings. `callVoice`, the voice a spoken call answers in, unset reads as the call's own default voice. */
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

const BRANCH_NAME_TITLE_PLACEHOLDER = "{title}";
const BRANCH_NAME_SESSION_PLACEHOLDER = "{session}";

function countOccurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/**
 * The pattern a new worktree's branch is named by, for `Every project` and for
 * one project's own override: `{title}` exactly once and `{session}` at most
 * once. Whether the whole name is a valid, free branch is git's check, made when
 * the pattern is saved and when a worktree is created.
 */
export const BranchNamePatternSchema: z.ZodType<string, string> = wireFreeFormString(
  BRANCH_NAME_PATTERN_MAX_LEN,
  "MachineSettings.branchNamePattern",
)
  .refine((pattern) => countOccurrences(pattern, BRANCH_NAME_TITLE_PLACEHOLDER) === 1, {
    message: "Put {title} in the name once.",
  })
  .refine((pattern) => countOccurrences(pattern, BRANCH_NAME_SESSION_PLACEHOLDER) <= 1, {
    message: "A branch-name pattern holds {session} at most once.",
  });

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
  /** `Keep this Mac awake while a sidekick is working`. */
  keepAwakeWhileAgentWorks: boolean;
  /** `Keep this Mac awake for your other devices`, held only while on power. */
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

// `ExecutionModeSchema` is single-T, so an object composing it infers an
// `unknown` input slot for that member; the bridge restores the double-T
// annotation the change request carries.
const DefaultCheckoutSchema = ExecutionModeSchema as unknown as z.ZodType<
  ExecutionMode,
  ExecutionMode
>;

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
  defaultCheckout: DefaultCheckoutSchema,
  newSessionCarriesLastModel: z.boolean(),
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

/** Parses a {@link MachineSettingsChange}: one member, never none and never two. */
export const MachineSettingsChangeSchema: z.ZodType<MachineSettingsChange, MachineSettingsChange> =
  z
    .object(MACHINE_SETTINGS_MEMBER_SCHEMAS)
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
        repairedAt: z.iso.datetime({ offset: true }),
        cause: z.enum(SETTINGS_FILE_REPAIR_CAUSES),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `daemon.machineSettingsRead` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MachineSettingsReadRequest {}
/** Parses a {@link MachineSettingsReadRequest}. */
export const MachineSettingsReadRequestSchema: z.ZodType<
  MachineSettingsReadRequest,
  MachineSettingsReadRequest
> = z.object({}).strict();

/** `daemon.machineSettingsSubscribe` takes nothing: there is one file per machine. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MachineSettingsSubscribeRequest {}
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
  > & { readonly procedureType: "query" };
  readonly "daemon.machineSettingsUpdate": MethodDescriptor<
    "daemon.machineSettingsUpdate",
    MachineSettingsUpdateRequest,
    MachineSettingsUpdateResponse
  > & { readonly procedureType: "mutation" };
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
