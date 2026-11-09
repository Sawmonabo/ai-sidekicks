// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The machine's settings file and the three service methods that read, write and stream it, with the environment-name rule the service checks a row's name against.

import { type SchemaCheck, deepEqual, ucs2length } from "../../schema-check.js";
import type { Port, WireInstant } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { Place, PlacedPath } from "../place.js";
import type { ProjectId } from "../project.js";
import type { ProviderDeclarationId, ProviderPlaceSwitch } from "../provider/declaration.js";
import type { ProviderId } from "../provider/id.js";
import type { ExecutionMode } from "../repo/mount.js";

/** Where the file sits, relative to the person's home folder. */
export const MACHINE_SETTINGS_FILE_PATH_SEGMENTS = [
  ".ai-sidekicks",
  "machine-settings.json",
] as const;

/**
 * The most UTF-16 units one environment entry, `NAME=value` and its NUL, may fill: Windows'
 * 32,767 characters a variable, the tightest limit of the three platforms, read as the whole
 * entry. A name's or a value's own cap takes the same number but counts code points; only the
 * whole-entry check counts UTF-16 units.
 */
export const ENVIRONMENT_ENTRY_MAX_UNITS = 32767 as const;

/** The longest editor id, call voice name or dictation language. */
export const MACHINE_SETTINGS_NAME_MAX_LEN = 256 as const;

/** The longest branch-name pattern. */
export const BRANCH_NAME_PATTERN_MAX_LEN = 256 as const;

/** RFC 5321 caps a forward path at 320 octets. */
export const EMAIL_ADDRESS_MAX_LEN = 320 as const;

/** RFC 1035 caps a host name at 253 characters. */
export const MAIL_SERVER_MAX_LEN = 253 as const;

/**
 * What an environment variable name may look like on every platform: a letter or underscore,
 * then letters, digits and underscores.
 */
export const ENVIRONMENT_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$" as const;

/**
 * The endings that make a name credential-shaped. A credential is set on Providers or in a
 * workflow step's Credential field, never as a row; a provider's API key is caught by `_KEY`.
 */
export const CREDENTIAL_NAME_SUFFIXES = ["_TOKEN", "_SECRET", "_KEY", "_PASSWORD"] as const;

/**
 * Names the file a Terminal pane's shell reads its mark nonce from; the shell's script deletes
 * the file and unsets the name, so the nonce never sits in an environment another program can
 * read.
 */
export const SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME = "SIDEKICKS_SHELL_MARK_NONCE_FILE" as const;

/**
 * Carries bash's own `ENV` past the posix-mode start that loads a Terminal pane's shell
 * script.
 */
export const SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME = "SIDEKICKS_ORIGINAL_ENV" as const;

/** Names a Terminal pane's shell script for a bash that loads it from its first prompt command. */
export const SHELL_BASH_SCRIPT_ENVIRONMENT_NAME = "SIDEKICKS_BASH_SCRIPT" as const;

/** Carries bash's own `PROMPT_COMMAND` past the first prompt command that loads its script. */
export const SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME =
  "SIDEKICKS_ORIGINAL_PROMPT_COMMAND" as const;

/**
 * Carries macOS's own bash's `HISTFILE` past the empty one it starts with, so it reads no
 * history before a Terminal pane's shell script has run the login files that size it.
 */
export const SHELL_ORIGINAL_HISTFILE_ENVIRONMENT_NAME = "SIDEKICKS_ORIGINAL_HISTFILE" as const;

/** Carries zsh's own `ZDOTDIR` past the folder that loads a Terminal pane's shell script. */
export const SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME = "SIDEKICKS_ORIGINAL_ZDOTDIR" as const;

/**
 * Carries fish's own `XDG_DATA_DIRS` past the folder that loads a Terminal pane's shell
 * script.
 */
export const SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME =
  "SIDEKICKS_ORIGINAL_XDG_DATA_DIRS" as const;

/**
 * The names the app's own shared code sets on the processes it starts. A row with one of
 * these names would be overwritten without a word, so it is refused at save; the names a
 * provider's driver sets are its own declaration's, which the service checks beside these.
 */
export const APP_SET_ENVIRONMENT_NAMES = [
  "SIDEKICKS_SHELL_MARK_NONCE_FILE",
  "SIDEKICKS_ORIGINAL_ENV",
  "SIDEKICKS_BASH_SCRIPT",
  "SIDEKICKS_ORIGINAL_PROMPT_COMMAND",
  "SIDEKICKS_ORIGINAL_HISTFILE",
  "SIDEKICKS_ORIGINAL_ZDOTDIR",
  "SIDEKICKS_ORIGINAL_XDG_DATA_DIRS",
] as const;

/** The code the service answers with when a row's name is refused. */
export const PROJECT_ENVIRONMENT_NAME_REFUSED_CODE = "project.environment.nameRefused" as const;

/** The code the service answers with when a branch-name pattern is refused. */
export const PROJECT_BRANCH_PATTERN_REFUSED_CODE = "project.branchPattern.refused" as const;

/** The placeholder a branch-name pattern holds exactly once: the tail of the session's title. */
export const BRANCH_NAME_TITLE_PLACEHOLDER = "{title}" as const;

/** Every [`EmailDigestPeriod`], shortest first. */
export const EMAIL_DIGEST_PERIODS = ["hour", "fourHours", "day"] as const;

/** Every [`VoiceMode`]. */
export const VOICE_MODES = ["hold", "tap"] as const;

/** Every [`SettingsFileRepairCause`]. */
export const SETTINGS_FILE_REPAIR_CAUSES = ["unparsable", "schemaRefused"] as const;

/** What each value is before anybody has chosen. */
export const MACHINE_SETTINGS_DEFAULTS = {
  updatesAutomatic: true,
  keepCrashReports: true,
  editorId: null,
  providerSettings: {},
  providerCommandPaths: {},
  providerKnobs: {},
  commitTextModel: null,
  defaultCheckout: "provisionedWorktree",
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
  sandboxBackgroundBrowser: false,
  screenReaderMode: false,
  environmentRows: [],
  backup: { automatic: false, folder: null },
  branchNamePattern: "sidekicks/{session}/{title}",
  cloneFolder: null,
  voice: { mode: "hold", callVoice: null, dictationLanguage: null },
} as const;

/**
 * Why a row's name is refused at save.
 */
export type EnvironmentNameRefusalReason = "notAName" | "credentialShaped" | "setByApp";
/**
 * Why a branch-name pattern was refused at save, told apart by `reason`, so the page says which
 * rule it broke.
 */
export type ProjectBranchPatternRefusedDetails =
  | {
      reason: "titleNotOnce";
    }
  | {
      reason: "notABranchName";
    }
  | {
      reason: "clashesWithBranch";
      /**
       * Git's own line for the clash, without git's `fatal: prepare: ` prefix and, on git's
       * files backend, the `cannot lock ref '<name>': ` clause after it, which reftable omits.
       */
      gitMessage: string;
      /**
       * The project whose repository holds the branch the name clashes with.
       */
      projectId: ProjectId;
    };
/**
 * How often the email digest may go out at most.
 */
export type EmailDigestPeriod = "hour" | "fourHours" | "day";
/**
 * An email address in the form mail clients accept: a dotted local part of letters, digits
 * and `_'+-`, then a host of letter-led labels and a top-level name of two letters or more.
 */
export type EmailAddress = string;
/**
 * Whether Space is held while talking or tapped to start and stop, on every provider.
 */
export type VoiceMode = "hold" | "tap";
/**
 * A saved branch-name pattern: a change's pattern that also holds `{title}` exactly once.
 */
export type BranchNamePattern = string;
/**
 * One declared Settings row's value set in the app, split by the row's shape; its check refuses
 * two entries for one place.
 */
export type ProviderRowValue = [ProviderPlaceSwitch, ...ProviderPlaceSwitch[]] | (string | null);
/**
 * One change to the file: exactly one top-level member, with its whole value. A group such as
 * `notifications` is written whole, so a change to one of its switches carries the group as the
 * page last read it with that switch moved. A pattern's `{title}` rule is the service's coded
 * refusal, not a parse failure.
 */
export type MachineSettingsChange =
  | {
      updatesAutomatic: boolean;
    }
  | {
      keepCrashReports: boolean;
    }
  | {
      editorId: string | null;
    }
  | {
      commitTextModel: CommitTextModel | null;
    }
  | {
      defaultCheckout: ExecutionMode;
    }
  | {
      newSessionCarriesLastModel: boolean;
    }
  | {
      lastLeadModel: LastLeadModel | null;
    }
  | {
      keepAwakeWhileAgentWorks: boolean;
    }
  | {
      keepAwakeForOtherDevices: boolean;
    }
  | {
      notifications: NotificationSettings;
    }
  | {
      rememberSiteData: boolean;
    }
  | {
      browserToolsForAgents: boolean;
    }
  | {
      sandboxBackgroundBrowser: boolean;
    }
  | {
      screenReaderMode: boolean;
    }
  | {
      environmentRows: EnvironmentRow[];
    }
  | {
      backup: BackupSettings;
    }
  | {
      branchNamePattern: string;
    }
  | {
      cloneFolder: PlacedPath | null;
    }
  | {
      voice: VoiceSettings;
    };
/**
 * Why a settings file was found broken.
 */
export type SettingsFileRepairCause = "unparsable" | "schemaRefused";

/**
 * The refused name and why, so the page marks the row it was typed into.
 */
export interface ProjectEnvironmentNameRefusedDetails {
  /**
   * The name as typed.
   */
  name: string;
  /**
   * Why it was refused.
   */
  reason: EnvironmentNameRefusalReason;
}
/**
 * One `name = value` row passed to every process the app starts, in `Every project` or in one
 * project's own list. The name rule is [`environment_name_refusal`], checked by the service when
 * a list is saved. Its whole entry fits [`ENVIRONMENT_ENTRY_MAX_UNITS`], so every system starts a
 * process with it.
 */
export interface EnvironmentRow {
  /**
   * The variable's name.
   */
  name: string;
  /**
   * Its value; a NUL would cut the environment entry short.
   */
  value: string;
}
/**
 * The four kinds of moment a notification or a delivery can be about.
 */
export interface NotificationKindSwitches {
  /**
   * `Waiting on you`.
   */
  waitingOnYou: boolean;
  /**
   * `Finished`.
   */
  finished: boolean;
  /**
   * `Failed`.
   */
  failed: boolean;
  /**
   * A workflow's Notify step.
   */
  notifyStep: boolean;
}
/**
 * The email digest's settings other than its password, which the service seals in the keychain.
 * A field left unset is `null`; `userName` unset means the address itself, and `mailServer` and
 * `port` unset mean the mail library's own entry for the address's domain.
 */
export interface EmailDigestSettings {
  /**
   * Whether the digest goes out.
   */
  enabled: boolean;
  /**
   * The address it goes to.
   */
  sendTo: EmailAddress | null;
  /**
   * The mail server's host.
   */
  mailServer: string | null;
  /**
   * The mail server's port.
   */
  port: Port | null;
  /**
   * The user name the server signs in with.
   */
  userName: string | null;
  /**
   * The shortest time between two digests.
   */
  after: EmailDigestPeriod;
}
/**
 * The web address's switch and the kinds it is sent; the address and its secret are sealed.
 */
export interface WebAddressSettings {
  /**
   * Whether the web address is sent anything.
   */
  enabled: boolean;
  /**
   * The kinds it is sent.
   */
  kinds: NotificationKindSwitches;
}
/**
 * Everything the Notifications page keeps in the file.
 */
export interface NotificationSettings {
  /**
   * `Show a count on the app icon`.
   */
  appIconCount: boolean;
  /**
   * `Notify me outside the app`, the switch above the four kinds.
   */
  notifyOutsideApp: boolean;
  /**
   * The kinds a notification is shown for.
   */
  kinds: NotificationKindSwitches;
  /**
   * The email digest.
   */
  emailDigest: EmailDigestSettings;
  /**
   * The web address.
   */
  webAddress: WebAddressSettings;
}
/**
 * Voice's settings. `callVoice`, the voice a spoken call answers in, and `dictationLanguage`, the
 * language dictation hears, are `null` until picked, while the provider's own value is followed.
 */
export interface VoiceSettings {
  /**
   * How Space works.
   */
  mode: VoiceMode;
  /**
   * The voice a spoken call answers in.
   */
  callVoice: string | null;
  /**
   * The dictation language, a language name the speech service takes.
   */
  dictationLanguage: string | null;
}
/**
 * `Back up automatically` and `Back up to`; a `folder` unset is the service's default folder.
 */
export interface BackupSettings {
  /**
   * Whether backups run on their own.
   */
  automatic: boolean;
  /**
   * Where they go.
   */
  folder: string | null;
}
/**
 * The lead's model and effort the person last picked, which a new session starts on while
 * `newSessionCarriesLastModel` is on. The service writes it each time a pick moves it; `effort`
 * `null` is the driver's default.
 */
export interface LastLeadModel {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The model.
   */
  modelId: string;
  /**
   * The effort, or `null` for the driver's default.
   */
  effort: string | null;
}
/**
 * The provider and model Generate writes its commit and pull-request text with.
 */
export interface CommitTextModel {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The model.
   */
  modelId: string;
}
/**
 * One place's command path the person set in place of auto-detect. A computer without a WSL 2
 * distribution has one entry and names no place.
 */
export interface ProviderCommandPath {
  /**
   * The place; absent on a computer without a WSL 2 distribution.
   */
  place?: Place;
  /**
   * The path the provider's command is started from there.
   */
  path: string;
}
/**
 * The knobs every provider offers, each absent until set: availability absent reads on, the
 * helper limit absent or `null` reads no limit and `0` none, and the compaction threshold absent
 * follows the provider's own setting.
 */
export interface ProviderKnobs {
  /**
   * Whether a new session may use the provider.
   */
  availableForNewSessions?: boolean;
  /**
   * How many helpers run at once: absent or `null` for no limit, `0` for none.
   */
  helpersAtOnce?: number | null;
  /**
   * The compaction threshold in percent full.
   */
  autoCompactPercent?: number;
}
/**
 * Every value the machine's settings file holds; its check refuses two entries for one place in
 * a provider's command paths or a declared switch row.
 */
export interface MachineSettings {
  /**
   * `Check for updates automatically`.
   */
  updatesAutomatic: boolean;
  /**
   * `Keep crash reports`.
   */
  keepCrashReports: boolean;
  /**
   * `Editor that opens files`; `null` is `System default`.
   */
  editorId: string | null;
  /**
   * The values set in the app on the Settings rows each provider's driver declares, written by
   * `provider.update` and passed to the app's own sessions; empty until one is set, while each
   * provider's own values are followed.
   */
  providerSettings: {
    [k: string]:
      | {
          [k: string]: ProviderRowValue | undefined;
        }
      | undefined;
  };
  /**
   * Each provider's `Command` path per place, written by `provider.update`; a place without one
   * auto-detects.
   */
  providerCommandPaths: {
    /**
     * @minItems 1
     */
    [k: string]: [ProviderCommandPath, ...ProviderCommandPath[]] | undefined;
  };
  /**
   * Each provider's availability, helper limit and compaction threshold, written by
   * `provider.update`; a knob unset reads as its default.
   */
  providerKnobs: {
    [k: string]: ProviderKnobs | undefined;
  };
  /**
   * `Commit and pull request text`; `null` is `Automatic`, the session's provider and its
   * lowest-priced model.
   */
  commitTextModel: CommitTextModel | null;
  /**
   * `Default checkout for a new project session`.
   */
  defaultCheckout: ExecutionMode;
  /**
   * `Start a new session on the last model and effort used`.
   */
  newSessionCarriesLastModel: boolean;
  /**
   * The last model and effort picked, `null` before the first pick.
   */
  lastLeadModel: LastLeadModel | null;
  /**
   * `Keep this Mac awake while a sidekick is working`.
   */
  keepAwakeWhileAgentWorks: boolean;
  /**
   * `Keep this Mac awake for other devices`, held only while on power.
   */
  keepAwakeForOtherDevices: boolean;
  /**
   * The Notifications page's settings.
   */
  notifications: NotificationSettings;
  /**
   * `Remember site data`.
   */
  rememberSiteData: boolean;
  /**
   * `Browser tools for sidekicks`.
   */
  browserToolsForAgents: boolean;
  /**
   * `Sandbox the background browser`: whether the headless browser every session and workflow
   * shares starts with Chromium's sandbox, read at its next launch.
   */
  sandboxBackgroundBrowser: boolean;
  /**
   * `Simplify for a screen reader`, carried into the Terminal pane's shells.
   */
  screenReaderMode: boolean;
  /**
   * `Every project`'s environment rows.
   */
  environmentRows: EnvironmentRow[];
  /**
   * The backup settings.
   */
  backup: BackupSettings;
  /**
   * `Every project`'s `Branch names`.
   */
  branchNamePattern: BranchNamePattern;
  /**
   * `Clone new repositories into`, with the distribution it is in; `null` until the person
   * sets one.
   */
  cloneFolder: PlacedPath | null;
  /**
   * The voice settings.
   */
  voice: VoiceSettings;
}
/**
 * A settings file's repair: its owner found the file broken, read the defaults in its place and
 * wrote them back. Carried until the next change is written, so the page can say both happened.
 * The machine settings file and the keyboard map both carry one.
 */
export interface SettingsFileRepair {
  /**
   * When the file was repaired.
   */
  repairedAt: WireInstant;
  /**
   * Why it was broken.
   */
  cause: SettingsFileRepairCause;
}
/**
 * The file as the service last read or wrote it, and the repair it made, if any.
 */
export interface MachineSettingsReading {
  /**
   * The settings.
   */
  settings: MachineSettings;
  /**
   * The repair the service made, until the next change is written.
   */
  repair?: SettingsFileRepair;
}
/**
 * `machine.settings.update`: the one change to write.
 */
export interface MachineSettingsUpdateRequest {
  /**
   * The change.
   */
  change: MachineSettingsChange;
}
/**
 * The file as written.
 */
export interface MachineSettingsUpdateResponse {
  /**
   * The settings.
   */
  settings: MachineSettings;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern1201 = new RegExp("^(?![^]*\\{title\\}[^]*\\{title\\})[^]*\\{title\\}", "u");
// prettier-ignore
function validate1041(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BranchNamePattern {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1041.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;if(errors === _errs0){if(typeof data === "string"){if(func1(data) > 256){validate1041.errors = [{instancePath,schemaPath:"#/allOf/0/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate1041.errors = [{instancePath,schemaPath:"#/allOf/0/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data)){validate1041.errors = [{instancePath,schemaPath:"#/allOf/0/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1041.errors = [{instancePath,schemaPath:"#/allOf/0/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs0 === errors;if(valid0){const _errs2: any = errors;if(errors === _errs2){if(typeof data === "string"){if(!pattern1201.test(data)){validate1041.errors = [{instancePath,schemaPath:"#/allOf/1/pattern",keyword:"pattern",params:{pattern: "^(?![^]*\\{title\\}[^]*\\{title\\})[^]*\\{title\\}"}}];return false;}}else {validate1041.errors = [{instancePath,schemaPath:"#/allOf/1/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}validate1041.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1041.errors = null as any[] | null;
// prettier-ignore
validate1041.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1042(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EnvironmentRow {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1042.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.name === undefined) && (missing0 = "name")) || ((data.value === undefined) && (missing0 = "value"))){validate1042.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "name") || (key0 === "value"))){validate1042.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 32767){validate1042.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 32767}}];return false;}else {if(func1(data0) < 1){validate1042.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1042.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){let data1: any = data.value;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 32767){validate1042.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/maxLength",keyword:"maxLength",params:{limit: 32767}}];return false;}else {if(!pattern43.test(data1)){validate1042.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}else {validate1042.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1042.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1042.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1042.errors = null as any[] | null;
// prettier-ignore
validate1042.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1973: any = {"type":"object","additionalProperties":false,"properties":{"updatesAutomatic":{"type":"boolean","description":"`Check for updates automatically`."},"keepCrashReports":{"type":"boolean","description":"`Keep crash reports`."},"editorId":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"`Editor that opens files`; `null` is `System default`."},"providerSettings":{"type":"object","propertyNames":{"allOf":[{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"type":"object","propertyNames":{"allOf":[{"$ref":"sidekicks-contracts:provider/declaration#/$defs/ProviderDeclarationId"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"$ref":"#/$defs/ProviderRowValue"}},"description":"The values set in the app on the Settings rows each provider's driver declares, written by\n`provider.update` and passed to the app's own sessions; empty until one is set, while each\nprovider's own values are followed."},"providerCommandPaths":{"type":"object","propertyNames":{"allOf":[{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"type":"array","items":{"$ref":"#/$defs/ProviderCommandPath"},"minItems":1,"uniqueItems":true},"description":"Each provider's `Command` path per place, written by `provider.update`; a place without one\nauto-detects."},"providerKnobs":{"type":"object","propertyNames":{"allOf":[{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"$ref":"#/$defs/ProviderKnobs"},"description":"Each provider's availability, helper limit and compaction threshold, written by\n`provider.update`; a knob unset reads as its default."},"commitTextModel":{"anyOf":[{"$ref":"#/$defs/CommitTextModel"},{"type":"null"}],"description":"`Commit and pull request text`; `null` is `Automatic`, the session's provider and its\nlowest-priced model."},"defaultCheckout":{"$ref":"sidekicks-contracts:repo/mount#/$defs/ExecutionMode","description":"`Default checkout for a new project session`."},"newSessionCarriesLastModel":{"type":"boolean","description":"`Start a new session on the last model and effort used`."},"lastLeadModel":{"anyOf":[{"$ref":"#/$defs/LastLeadModel"},{"type":"null"}],"description":"The last model and effort picked, `null` before the first pick."},"keepAwakeWhileAgentWorks":{"type":"boolean","description":"`Keep this Mac awake while a sidekick is working`."},"keepAwakeForOtherDevices":{"type":"boolean","description":"`Keep this Mac awake for other devices`, held only while on power."},"notifications":{"$ref":"#/$defs/NotificationSettings","description":"The Notifications page's settings."},"rememberSiteData":{"type":"boolean","description":"`Remember site data`."},"browserToolsForAgents":{"type":"boolean","description":"`Browser tools for sidekicks`."},"sandboxBackgroundBrowser":{"type":"boolean","description":"`Sandbox the background browser`: whether the headless browser every session and workflow\nshares starts with Chromium's sandbox, read at its next launch."},"screenReaderMode":{"type":"boolean","description":"`Simplify for a screen reader`, carried into the Terminal pane's shells."},"environmentRows":{"type":"array","items":{"$ref":"#/$defs/EnvironmentRow"},"description":"`Every project`'s environment rows."},"backup":{"$ref":"#/$defs/BackupSettings","description":"The backup settings."},"branchNamePattern":{"$ref":"#/$defs/BranchNamePattern","description":"`Every project`'s `Branch names`."},"cloneFolder":{"anyOf":[{"$ref":"sidekicks-contracts:place#/$defs/PlacedPath"},{"type":"null"}],"description":"`Clone new repositories into`, with the distribution it is in; `null` until the person\nsets one."},"voice":{"$ref":"#/$defs/VoiceSettings","description":"The voice settings."}},"required":["updatesAutomatic","keepCrashReports","editorId","providerSettings","providerCommandPaths","providerKnobs","commitTextModel","defaultCheckout","newSessionCarriesLastModel","lastLeadModel","keepAwakeWhileAgentWorks","keepAwakeForOtherDevices","notifications","rememberSiteData","browserToolsForAgents","sandboxBackgroundBrowser","screenReaderMode","environmentRows","backup","branchNamePattern","cloneFolder","voice"],"description":"Every value the machine's settings file holds; its check refuses two entries for one place in\na provider's command paths or a declared switch row."};
// prettier-ignore
const schema1983: any = {"type":"object","additionalProperties":false,"properties":{"availableForNewSessions":{"type":"boolean","description":"Whether a new session may use the provider."},"helpersAtOnce":{"type":["integer","null"],"minimum":0,"maximum":9007199254740991,"description":"How many helpers run at once: absent or `null` for no limit, `0` for none."},"autoCompactPercent":{"type":"integer","minimum":0,"maximum":100,"multipleOf":5,"description":"The compaction threshold in percent full."}},"description":"The knobs every provider offers, each absent until set: availability absent reads on, the\nhelper limit absent or `null` reads no limit and `0` none, and the compaction threshold absent\nfollows the provider's own setting."};
// prettier-ignore
const schema1986: any = {"description":"How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's\nown checkout), `provisionedWorktree` in a worktree the daemon provisions for it.","type":"string","enum":["boundRoot","provisionedWorktree"]};
// prettier-ignore
const schema1998: any = {"type":"object","additionalProperties":false,"properties":{"automatic":{"type":"boolean","description":"Whether backups run on their own."},"folder":{"type":["string","null"],"maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"Where they go."}},"required":["automatic","folder"],"description":"`Back up automatically` and `Back up to`; a `folder` unset is the service's default folder."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern20 = new RegExp("^[a-z][A-Za-z0-9]{0,63}$", "u");
// prettier-ignore
const schema1976: any = {"anyOf":[{"type":"array","items":{"$ref":"sidekicks-contracts:provider/declaration#/$defs/ProviderPlaceSwitch"},"minItems":1,"uniqueItems":true,"description":"A switch's entry for each place it was set in, keyed by place; a place left out follows the\nprovider's own value there."},{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"A choice's option or `null` for its none, or a text setting's text or `null` for none."}],"description":"One declared Settings row's value set in the app, split by the row's shape; its check refuses\ntwo entries for one place."};
// prettier-ignore
const schema914: any = {"anyOf":[{"description":"Windows itself.","type":"string","enum":["windows"]},{"$ref":"#/$defs/WslPlace","description":"A WSL distribution."}],"description":"Where work runs: `\"windows\"`, or `{distro}` for a WSL 2 distribution. A provider's `Command`\nrow may also name a WSL 1 distribution, the one place no work runs."};
// prettier-ignore
function validate477(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate477.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.distro === undefined) && (missing0 = "distro")){validate477.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "distro")){validate477.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate477.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate477.errors = vErrors;return errors === 0;}
// prettier-ignore
validate477.errors = null as any[] | null;
// prettier-ignore
validate477.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1046(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1046.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!(data === "windows")){const err1: any = {instancePath,schemaPath:"#/anyOf/0/enum",keyword:"enum",params:{allowedValues: schema914.anyOf[0].enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs3: any = errors;if(!(validate477.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate477.errors : vErrors.concat(validate477.errors);errors = vErrors.length;}var _valid0: any = _errs3 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}if(!valid0){const err2: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validate1046.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1046.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1046.errors = null as any[] | null;
// prettier-ignore
validate1046.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1045(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1045.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.enabled === undefined) && (missing0 = "enabled")){validate1045.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "place") || (key0 === "enabled"))){validate1045.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.place !== undefined){const _errs2: any = errors;if(!(validate1046.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1046.errors : vErrors.concat(validate1046.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs3: any = errors;if(typeof data.enabled !== "boolean"){validate1045.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1045.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1045.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1045.errors = null as any[] | null;
// prettier-ignore
validate1045.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1044(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1044.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(Array.isArray(data)){if(data.length < 1){const err0: any = {instancePath,schemaPath:"#/anyOf/0/minItems",keyword:"minItems",params:{limit: 1}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {var valid1: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){const _errs3: any = errors;if(!(validate1045.call(this, data[i0], {instancePath:instancePath+"/" + i0,parentData:data,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1045.errors : vErrors.concat(validate1045.errors);errors = vErrors.length;}var valid1: any = _errs3 === errors;if(!valid1){break;}}if(valid1){let i1: any = data.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data[i1], data[j0])){const err1: any = {instancePath,schemaPath:"#/anyOf/0/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break outer0;}}}}}}}else {const err2: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var items0: any = true;}const _errs4: any = errors;if((typeof data !== "string") && (data !== null)){const err3: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: schema1976.anyOf[1].type}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}if(errors === _errs4){if(typeof data === "string"){if(func1(data) > 4096){const err4: any = {instancePath,schemaPath:"#/anyOf/1/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {if(func1(data) < 1){const err5: any = {instancePath,schemaPath:"#/anyOf/1/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {if(!pattern6.test(data)){const err6: any = {instancePath,schemaPath:"#/anyOf/1/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}}}}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(!valid0){const err7: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validate1044.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1044.errors = vErrors;evaluated0.items = items0;return errors === 0;}
// prettier-ignore
validate1044.errors = null as any[] | null;
// prettier-ignore
validate1044.evaluated = {"dynamicProps":false,"dynamicItems":true} as any;
// prettier-ignore
function validate1052(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1052.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!(data === "windows")){const err1: any = {instancePath,schemaPath:"#/anyOf/0/enum",keyword:"enum",params:{allowedValues: schema914.anyOf[0].enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs3: any = errors;if(!(validate477.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate477.errors : vErrors.concat(validate477.errors);errors = vErrors.length;}var _valid0: any = _errs3 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}if(!valid0){const err2: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validate1052.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1052.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1052.errors = null as any[] | null;
// prettier-ignore
validate1052.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1051(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1051.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.path === undefined) && (missing0 = "path")){validate1051.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "place") || (key0 === "path"))){validate1051.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.place !== undefined){const _errs2: any = errors;if(!(validate1052.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1052.errors : vErrors.concat(validate1052.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1051.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1051.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1051.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1051.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1051.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1051.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1051.errors = null as any[] | null;
// prettier-ignore
validate1051.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1056(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1056.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.modelId === undefined) && (missing0 = "modelId"))){validate1056.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "modelId"))){validate1056.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1056.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1056.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelId !== undefined){let data1: any = data.modelId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1056.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1056.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1056.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1056.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1056.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1056.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1056.errors = null as any[] | null;
// prettier-ignore
validate1056.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1987: any = {"type":"object","additionalProperties":false,"properties":{"providerName":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"modelId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The model."},"effort":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The effort, or `null` for the driver's default."}},"required":["providerName","modelId","effort"],"description":"The lead's model and effort the person last picked, which a new session starts on while\n`newSessionCarriesLastModel` is on. The service writes it each time a pick moves it; `effort`\n`null` is the driver's default."};
// prettier-ignore
function validate1058(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1058.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerName === undefined) && (missing0 = "providerName")) || ((data.modelId === undefined) && (missing0 = "modelId"))) || ((data.effort === undefined) && (missing0 = "effort"))){validate1058.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "providerName") || (key0 === "modelId")) || (key0 === "effort"))){validate1058.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1058.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1058.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelId !== undefined){let data1: any = data.modelId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1058.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1058.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1058.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1058.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.effort !== undefined){let data2: any = data.effort;const _errs8: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1058.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/type",keyword:"type",params:{type: schema1987.properties.effort.type}}];return false;}if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate1058.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1058.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1058.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1058.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1058.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1058.errors = null as any[] | null;
// prettier-ignore
validate1058.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1991: any = {"type":"object","additionalProperties":false,"properties":{"enabled":{"type":"boolean","description":"Whether the digest goes out."},"sendTo":{"anyOf":[{"$ref":"#/$defs/EmailAddress"},{"type":"null"}],"description":"The address it goes to."},"mailServer":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":253,"description":"The mail server's host."},"port":{"anyOf":[{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Port"},{"type":"null"}],"description":"The mail server's port."},"userName":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":320,"description":"The user name the server signs in with."},"after":{"$ref":"#/$defs/EmailDigestPeriod","description":"The shortest time between two digests."}},"required":["enabled","sendTo","mailServer","port","userName","after"],"description":"The email digest's settings other than its password, which the service seals in the keychain.\nA field left unset is `null`; `userName` unset means the address itself, and `mailServer` and\n`port` unset mean the mail library's own entry for the address's domain."};
// prettier-ignore
const schema1994: any = {"description":"How often the email digest may go out at most.","type":"string","enum":["hour","fourHours","day"]};
// prettier-ignore
const pattern1215 = new RegExp("^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$", "u");
// prettier-ignore
function validate1061(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1061.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.enabled === undefined) && (missing0 = "enabled")) || ((data.sendTo === undefined) && (missing0 = "sendTo"))) || ((data.mailServer === undefined) && (missing0 = "mailServer"))) || ((data.port === undefined) && (missing0 = "port"))) || ((data.userName === undefined) && (missing0 = "userName"))) || ((data.after === undefined) && (missing0 = "after"))){validate1061.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "enabled") || (key0 === "sendTo")) || (key0 === "mailServer")) || (key0 === "port")) || (key0 === "userName")) || (key0 === "after"))){validate1061.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.enabled !== undefined){const _errs2: any = errors;if(typeof data.enabled !== "boolean"){validate1061.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sendTo !== undefined){let data1: any = data.sendTo;const _errs4: any = errors;const _errs5: any = errors;let valid1: any = false;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 320){const err0: any = {instancePath:instancePath+"/sendTo",schemaPath:"#/$defs/EmailAddress/maxLength",keyword:"maxLength",params:{limit: 320}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(!pattern1215.test(data1)){const err1: any = {instancePath:instancePath+"/sendTo",schemaPath:"#/$defs/EmailAddress/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}else {const err2: any = {instancePath:instancePath+"/sendTo",schemaPath:"#/$defs/EmailAddress/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;const _errs9: any = errors;if(data1 !== null){const err3: any = {instancePath:instancePath+"/sendTo",schemaPath:"#/properties/sendTo/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs9 === errors;valid1 = valid1 || _valid0;if(!valid1){const err4: any = {instancePath:instancePath+"/sendTo",schemaPath:"#/properties/sendTo/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1061.errors = vErrors;return false;}else {errors = _errs5;if(vErrors !== null){if(_errs5){vErrors.length = _errs5;}else {vErrors = null;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.mailServer !== undefined){let data2: any = data.mailServer;const _errs11: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1061.errors = [{instancePath:instancePath+"/mailServer",schemaPath:"#/properties/mailServer/type",keyword:"type",params:{type: schema1991.properties.mailServer.type}}];return false;}if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 253){validate1061.errors = [{instancePath:instancePath+"/mailServer",schemaPath:"#/properties/mailServer/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}else {if(func1(data2) < 1){validate1061.errors = [{instancePath:instancePath+"/mailServer",schemaPath:"#/properties/mailServer/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1061.errors = [{instancePath:instancePath+"/mailServer",schemaPath:"#/properties/mailServer/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.port !== undefined){let data3: any = data.port;const _errs13: any = errors;const _errs14: any = errors;let valid3: any = false;const _errs15: any = errors;const _errs16: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){const err5: any = {instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}if(errors === _errs16){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 65535 || isNaN(data3)){const err6: any = {instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(data3 < 1 || isNaN(data3)){const err7: any = {instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}}}var _valid1: any = _errs15 === errors;valid3 = valid3 || _valid1;const _errs18: any = errors;if(data3 !== null){const err8: any = {instancePath:instancePath+"/port",schemaPath:"#/properties/port/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var _valid1: any = _errs18 === errors;valid3 = valid3 || _valid1;if(!valid3){const err9: any = {instancePath:instancePath+"/port",schemaPath:"#/properties/port/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validate1061.errors = vErrors;return false;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.userName !== undefined){let data4: any = data.userName;const _errs20: any = errors;if((typeof data4 !== "string") && (data4 !== null)){validate1061.errors = [{instancePath:instancePath+"/userName",schemaPath:"#/properties/userName/type",keyword:"type",params:{type: schema1991.properties.userName.type}}];return false;}if(errors === _errs20){if(typeof data4 === "string"){if(func1(data4) > 320){validate1061.errors = [{instancePath:instancePath+"/userName",schemaPath:"#/properties/userName/maxLength",keyword:"maxLength",params:{limit: 320}}];return false;}else {if(func1(data4) < 1){validate1061.errors = [{instancePath:instancePath+"/userName",schemaPath:"#/properties/userName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1061.errors = [{instancePath:instancePath+"/userName",schemaPath:"#/properties/userName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.after !== undefined){let data5: any = data.after;const _errs22: any = errors;if(typeof data5 !== "string"){validate1061.errors = [{instancePath:instancePath+"/after",schemaPath:"#/$defs/EmailDigestPeriod/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data5 === "hour") || (data5 === "fourHours")) || (data5 === "day"))){validate1061.errors = [{instancePath:instancePath+"/after",schemaPath:"#/$defs/EmailDigestPeriod/enum",keyword:"enum",params:{allowedValues: schema1994.enum}}];return false;}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1061.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1061.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1061.errors = null as any[] | null;
// prettier-ignore
validate1061.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1063(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1063.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.enabled === undefined) && (missing0 = "enabled")) || ((data.kinds === undefined) && (missing0 = "kinds"))){validate1063.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "enabled") || (key0 === "kinds"))){validate1063.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.enabled !== undefined){const _errs2: any = errors;if(typeof data.enabled !== "boolean"){validate1063.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.kinds !== undefined){let data1: any = data.kinds;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if(((((data1.waitingOnYou === undefined) && (missing1 = "waitingOnYou")) || ((data1.finished === undefined) && (missing1 = "finished"))) || ((data1.failed === undefined) && (missing1 = "failed"))) || ((data1.notifyStep === undefined) && (missing1 = "notifyStep"))){validate1063.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/$defs/NotificationKindSwitches/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs7: any = errors;for(const key1 in data1){if(!((((key1 === "waitingOnYou") || (key1 === "finished")) || (key1 === "failed")) || (key1 === "notifyStep"))){validate1063.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/$defs/NotificationKindSwitches/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs7 === errors){if(data1.waitingOnYou !== undefined){const _errs8: any = errors;if(typeof data1.waitingOnYou !== "boolean"){validate1063.errors = [{instancePath:instancePath+"/kinds/waitingOnYou",schemaPath:"#/$defs/NotificationKindSwitches/properties/waitingOnYou/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data1.finished !== undefined){const _errs10: any = errors;if(typeof data1.finished !== "boolean"){validate1063.errors = [{instancePath:instancePath+"/kinds/finished",schemaPath:"#/$defs/NotificationKindSwitches/properties/finished/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data1.failed !== undefined){const _errs12: any = errors;if(typeof data1.failed !== "boolean"){validate1063.errors = [{instancePath:instancePath+"/kinds/failed",schemaPath:"#/$defs/NotificationKindSwitches/properties/failed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data1.notifyStep !== undefined){const _errs14: any = errors;if(typeof data1.notifyStep !== "boolean"){validate1063.errors = [{instancePath:instancePath+"/kinds/notifyStep",schemaPath:"#/$defs/NotificationKindSwitches/properties/notifyStep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}else {validate1063.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/$defs/NotificationKindSwitches/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1063.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1063.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1063.errors = null as any[] | null;
// prettier-ignore
validate1063.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1060(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1060.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.appIconCount === undefined) && (missing0 = "appIconCount")) || ((data.notifyOutsideApp === undefined) && (missing0 = "notifyOutsideApp"))) || ((data.kinds === undefined) && (missing0 = "kinds"))) || ((data.emailDigest === undefined) && (missing0 = "emailDigest"))) || ((data.webAddress === undefined) && (missing0 = "webAddress"))){validate1060.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "appIconCount") || (key0 === "notifyOutsideApp")) || (key0 === "kinds")) || (key0 === "emailDigest")) || (key0 === "webAddress"))){validate1060.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.appIconCount !== undefined){const _errs2: any = errors;if(typeof data.appIconCount !== "boolean"){validate1060.errors = [{instancePath:instancePath+"/appIconCount",schemaPath:"#/properties/appIconCount/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.notifyOutsideApp !== undefined){const _errs4: any = errors;if(typeof data.notifyOutsideApp !== "boolean"){validate1060.errors = [{instancePath:instancePath+"/notifyOutsideApp",schemaPath:"#/properties/notifyOutsideApp/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.kinds !== undefined){let data2: any = data.kinds;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((((data2.waitingOnYou === undefined) && (missing1 = "waitingOnYou")) || ((data2.finished === undefined) && (missing1 = "finished"))) || ((data2.failed === undefined) && (missing1 = "failed"))) || ((data2.notifyStep === undefined) && (missing1 = "notifyStep"))){validate1060.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/$defs/NotificationKindSwitches/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data2){if(!((((key1 === "waitingOnYou") || (key1 === "finished")) || (key1 === "failed")) || (key1 === "notifyStep"))){validate1060.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/$defs/NotificationKindSwitches/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data2.waitingOnYou !== undefined){const _errs10: any = errors;if(typeof data2.waitingOnYou !== "boolean"){validate1060.errors = [{instancePath:instancePath+"/kinds/waitingOnYou",schemaPath:"#/$defs/NotificationKindSwitches/properties/waitingOnYou/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data2.finished !== undefined){const _errs12: any = errors;if(typeof data2.finished !== "boolean"){validate1060.errors = [{instancePath:instancePath+"/kinds/finished",schemaPath:"#/$defs/NotificationKindSwitches/properties/finished/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data2.failed !== undefined){const _errs14: any = errors;if(typeof data2.failed !== "boolean"){validate1060.errors = [{instancePath:instancePath+"/kinds/failed",schemaPath:"#/$defs/NotificationKindSwitches/properties/failed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data2.notifyStep !== undefined){const _errs16: any = errors;if(typeof data2.notifyStep !== "boolean"){validate1060.errors = [{instancePath:instancePath+"/kinds/notifyStep",schemaPath:"#/$defs/NotificationKindSwitches/properties/notifyStep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}}}}}}}else {validate1060.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/$defs/NotificationKindSwitches/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.emailDigest !== undefined){const _errs18: any = errors;if(!(validate1061.call(this, data.emailDigest, {instancePath:instancePath+"/emailDigest",parentData:data,parentDataProperty:"emailDigest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1061.errors : vErrors.concat(validate1061.errors);errors = vErrors.length;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.webAddress !== undefined){const _errs19: any = errors;if(!(validate1063.call(this, data.webAddress, {instancePath:instancePath+"/webAddress",parentData:data,parentDataProperty:"webAddress",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1063.errors : vErrors.concat(validate1063.errors);errors = vErrors.length;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1060.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1060.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1060.errors = null as any[] | null;
// prettier-ignore
validate1060.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1066(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1066.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.path === undefined) && (missing0 = "path")){validate1066.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "place"))){validate1066.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1066.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1066.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1066.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1066.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs4: any = errors;if(!(validate477.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate477.errors : vErrors.concat(validate477.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1066.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1066.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1066.errors = null as any[] | null;
// prettier-ignore
validate1066.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2001: any = {"type":"object","additionalProperties":false,"properties":{"mode":{"$ref":"#/$defs/VoiceMode","description":"How Space works."},"callVoice":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The voice a spoken call answers in."},"dictationLanguage":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The dictation language, a language name the speech service takes."}},"required":["mode","callVoice","dictationLanguage"],"description":"Voice's settings. `callVoice`, the voice a spoken call answers in, and `dictationLanguage`, the\nlanguage dictation hears, are `null` until picked, while the provider's own value is followed."};
// prettier-ignore
const schema2002: any = {"description":"Whether Space is held while talking or tapped to start and stop, on every provider.","type":"string","enum":["hold","tap"]};
// prettier-ignore
function validate1069(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1069.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.mode === undefined) && (missing0 = "mode")) || ((data.callVoice === undefined) && (missing0 = "callVoice"))) || ((data.dictationLanguage === undefined) && (missing0 = "dictationLanguage"))){validate1069.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "mode") || (key0 === "callVoice")) || (key0 === "dictationLanguage"))){validate1069.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.mode !== undefined){let data0: any = data.mode;const _errs2: any = errors;if(typeof data0 !== "string"){validate1069.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/VoiceMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "hold") || (data0 === "tap"))){validate1069.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/VoiceMode/enum",keyword:"enum",params:{allowedValues: schema2002.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.callVoice !== undefined){let data1: any = data.callVoice;const _errs5: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validate1069.errors = [{instancePath:instancePath+"/callVoice",schemaPath:"#/properties/callVoice/type",keyword:"type",params:{type: schema2001.properties.callVoice.type}}];return false;}if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 256){validate1069.errors = [{instancePath:instancePath+"/callVoice",schemaPath:"#/properties/callVoice/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1069.errors = [{instancePath:instancePath+"/callVoice",schemaPath:"#/properties/callVoice/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1069.errors = [{instancePath:instancePath+"/callVoice",schemaPath:"#/properties/callVoice/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.dictationLanguage !== undefined){let data2: any = data.dictationLanguage;const _errs7: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1069.errors = [{instancePath:instancePath+"/dictationLanguage",schemaPath:"#/properties/dictationLanguage/type",keyword:"type",params:{type: schema2001.properties.dictationLanguage.type}}];return false;}if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) > 256){validate1069.errors = [{instancePath:instancePath+"/dictationLanguage",schemaPath:"#/properties/dictationLanguage/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1069.errors = [{instancePath:instancePath+"/dictationLanguage",schemaPath:"#/properties/dictationLanguage/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1069.errors = [{instancePath:instancePath+"/dictationLanguage",schemaPath:"#/properties/dictationLanguage/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate1069.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1069.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1069.errors = null as any[] | null;
// prettier-ignore
validate1069.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1043(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineSettings {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1043.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((((((((((((((data.updatesAutomatic === undefined) && (missing0 = "updatesAutomatic")) || ((data.keepCrashReports === undefined) && (missing0 = "keepCrashReports"))) || ((data.editorId === undefined) && (missing0 = "editorId"))) || ((data.providerSettings === undefined) && (missing0 = "providerSettings"))) || ((data.providerCommandPaths === undefined) && (missing0 = "providerCommandPaths"))) || ((data.providerKnobs === undefined) && (missing0 = "providerKnobs"))) || ((data.commitTextModel === undefined) && (missing0 = "commitTextModel"))) || ((data.defaultCheckout === undefined) && (missing0 = "defaultCheckout"))) || ((data.newSessionCarriesLastModel === undefined) && (missing0 = "newSessionCarriesLastModel"))) || ((data.lastLeadModel === undefined) && (missing0 = "lastLeadModel"))) || ((data.keepAwakeWhileAgentWorks === undefined) && (missing0 = "keepAwakeWhileAgentWorks"))) || ((data.keepAwakeForOtherDevices === undefined) && (missing0 = "keepAwakeForOtherDevices"))) || ((data.notifications === undefined) && (missing0 = "notifications"))) || ((data.rememberSiteData === undefined) && (missing0 = "rememberSiteData"))) || ((data.browserToolsForAgents === undefined) && (missing0 = "browserToolsForAgents"))) || ((data.sandboxBackgroundBrowser === undefined) && (missing0 = "sandboxBackgroundBrowser"))) || ((data.screenReaderMode === undefined) && (missing0 = "screenReaderMode"))) || ((data.environmentRows === undefined) && (missing0 = "environmentRows"))) || ((data.backup === undefined) && (missing0 = "backup"))) || ((data.branchNamePattern === undefined) && (missing0 = "branchNamePattern"))) || ((data.cloneFolder === undefined) && (missing0 = "cloneFolder"))) || ((data.voice === undefined) && (missing0 = "voice"))){validate1043.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1973.properties, key0))){validate1043.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.updatesAutomatic !== undefined){const _errs2: any = errors;if(typeof data.updatesAutomatic !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/updatesAutomatic",schemaPath:"#/properties/updatesAutomatic/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepCrashReports !== undefined){const _errs4: any = errors;if(typeof data.keepCrashReports !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/keepCrashReports",schemaPath:"#/properties/keepCrashReports/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.editorId !== undefined){let data2: any = data.editorId;const _errs6: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1043.errors = [{instancePath:instancePath+"/editorId",schemaPath:"#/properties/editorId/type",keyword:"type",params:{type: schema1973.properties.editorId.type}}];return false;}if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 256){validate1043.errors = [{instancePath:instancePath+"/editorId",schemaPath:"#/properties/editorId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1043.errors = [{instancePath:instancePath+"/editorId",schemaPath:"#/properties/editorId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1043.errors = [{instancePath:instancePath+"/editorId",schemaPath:"#/properties/editorId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerSettings !== undefined){let data3: any = data.providerSettings;const _errs8: any = errors;if(errors === _errs8){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){for(const key1 in data3){const _errs10: any = errors;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof key1 === "string"){if(!pattern16.test(key1)){const err0: any = {instancePath:instancePath+"/providerSettings",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/providerSettings",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var valid2: any = _errs11 === errors;if(valid2){const _errs15: any = errors;const _errs16: any = errors;const _errs17: any = errors;if("__proto__" !== key1){const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var valid4: any = _errs17 === errors;if(valid4){const err3: any = {instancePath:instancePath+"/providerSettings",schemaPath:"#/properties/providerSettings/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs15 === errors;}var valid1: any = _errs10 === errors;if(!valid1){const err4: any = {instancePath:instancePath+"/providerSettings",schemaPath:"#/properties/providerSettings/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1043.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data3){let data4: any = data3[key2];const _errs19: any = errors;if(errors === _errs19){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key3 in data4){const _errs21: any = errors;const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(typeof key3 === "string"){if(!pattern20.test(key3)){const err5: any = {instancePath:instancePath+"/providerSettings/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"sidekicks-contracts:provider/declaration#/$defs/ProviderDeclarationId/pattern",keyword:"pattern",params:{pattern: "^[a-z][A-Za-z0-9]{0,63}$"},propertyName:key3};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}else {const err6: any = {instancePath:instancePath+"/providerSettings/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"sidekicks-contracts:provider/declaration#/$defs/ProviderDeclarationId/type",keyword:"type",params:{type: "string"},propertyName:key3};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var valid7: any = _errs22 === errors;if(valid7){const _errs26: any = errors;const _errs27: any = errors;const _errs28: any = errors;if("__proto__" !== key3){const err7: any = {};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid9: any = _errs28 === errors;if(valid9){const err8: any = {instancePath:instancePath+"/providerSettings/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/providerSettings/additionalProperties/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key3};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}else {errors = _errs27;if(vErrors !== null){if(_errs27){vErrors.length = _errs27;}else {vErrors = null;}}}var valid7: any = _errs26 === errors;}var valid6: any = _errs21 === errors;if(!valid6){const err9: any = {instancePath:instancePath+"/providerSettings/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/providerSettings/additionalProperties/propertyNames",keyword:"propertyNames",params:{propertyName: key3}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validate1043.errors = vErrors;return false;break;}}if(valid6){for(const key4 in data4){const _errs30: any = errors;if(!(validate1044.call(this, data4[key4], {instancePath:instancePath+"/providerSettings/" + key2.replace(/~/g, "~0").replace(/\//g, "~1")+"/" + key4.replace(/~/g, "~0").replace(/\//g, "~1"),parentData:data4,parentDataProperty:key4,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1044.errors : vErrors.concat(validate1044.errors);errors = vErrors.length;}var valid10: any = _errs30 === errors;if(!valid10){break;}}}}else {validate1043.errors = [{instancePath:instancePath+"/providerSettings/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/providerSettings/additionalProperties/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs19 === errors;if(!valid5){break;}}}}else {validate1043.errors = [{instancePath:instancePath+"/providerSettings",schemaPath:"#/properties/providerSettings/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerCommandPaths !== undefined){let data6: any = data.providerCommandPaths;const _errs31: any = errors;if(errors === _errs31){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){for(const key5 in data6){const _errs33: any = errors;const _errs34: any = errors;const _errs35: any = errors;if(errors === _errs35){if(typeof key5 === "string"){if(!pattern16.test(key5)){const err10: any = {instancePath:instancePath+"/providerCommandPaths",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"},propertyName:key5};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}else {const err11: any = {instancePath:instancePath+"/providerCommandPaths",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"},propertyName:key5};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var valid12: any = _errs34 === errors;if(valid12){const _errs38: any = errors;const _errs39: any = errors;const _errs40: any = errors;if("__proto__" !== key5){const err12: any = {};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}var valid14: any = _errs40 === errors;if(valid14){const err13: any = {instancePath:instancePath+"/providerCommandPaths",schemaPath:"#/properties/providerCommandPaths/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key5};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}else {errors = _errs39;if(vErrors !== null){if(_errs39){vErrors.length = _errs39;}else {vErrors = null;}}}var valid12: any = _errs38 === errors;}var valid11: any = _errs33 === errors;if(!valid11){const err14: any = {instancePath:instancePath+"/providerCommandPaths",schemaPath:"#/properties/providerCommandPaths/propertyNames",keyword:"propertyNames",params:{propertyName: key5}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;validate1043.errors = vErrors;return false;break;}}if(valid11){for(const key6 in data6){let data7: any = data6[key6];const _errs42: any = errors;if(errors === _errs42){if(Array.isArray(data7)){if(data7.length < 1){validate1043.errors = [{instancePath:instancePath+"/providerCommandPaths/" + key6.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/providerCommandPaths/additionalProperties/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid16: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){const _errs44: any = errors;if(!(validate1051.call(this, data7[i0], {instancePath:instancePath+"/providerCommandPaths/" + key6.replace(/~/g, "~0").replace(/\//g, "~1")+"/" + i0,parentData:data7,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1051.errors : vErrors.concat(validate1051.errors);errors = vErrors.length;}var valid16: any = _errs44 === errors;if(!valid16){break;}}if(valid16){let i1: any = data7.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data7[i1], data7[j0])){validate1043.errors = [{instancePath:instancePath+"/providerCommandPaths/" + key6.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/providerCommandPaths/additionalProperties/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validate1043.errors = [{instancePath:instancePath+"/providerCommandPaths/" + key6.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/providerCommandPaths/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid15: any = _errs42 === errors;if(!valid15){break;}}}}else {validate1043.errors = [{instancePath:instancePath+"/providerCommandPaths",schemaPath:"#/properties/providerCommandPaths/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs31 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerKnobs !== undefined){let data9: any = data.providerKnobs;const _errs45: any = errors;if(errors === _errs45){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){for(const key7 in data9){const _errs47: any = errors;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(typeof key7 === "string"){if(!pattern16.test(key7)){const err15: any = {instancePath:instancePath+"/providerKnobs",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"},propertyName:key7};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}else {const err16: any = {instancePath:instancePath+"/providerKnobs",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"},propertyName:key7};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var valid19: any = _errs48 === errors;if(valid19){const _errs52: any = errors;const _errs53: any = errors;const _errs54: any = errors;if("__proto__" !== key7){const err17: any = {};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var valid21: any = _errs54 === errors;if(valid21){const err18: any = {instancePath:instancePath+"/providerKnobs",schemaPath:"#/properties/providerKnobs/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key7};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {errors = _errs53;if(vErrors !== null){if(_errs53){vErrors.length = _errs53;}else {vErrors = null;}}}var valid19: any = _errs52 === errors;}var valid18: any = _errs47 === errors;if(!valid18){const err19: any = {instancePath:instancePath+"/providerKnobs",schemaPath:"#/properties/providerKnobs/propertyNames",keyword:"propertyNames",params:{propertyName: key7}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;validate1043.errors = vErrors;return false;break;}}if(valid18){for(const key8 in data9){let data10: any = data9[key8];const _errs56: any = errors;const _errs57: any = errors;if(errors === _errs57){if(data10 && typeof data10 == "object" && !Array.isArray(data10)){const _errs59: any = errors;for(const key9 in data10){if(!(((key9 === "availableForNewSessions") || (key9 === "helpersAtOnce")) || (key9 === "autoCompactPercent"))){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/$defs/ProviderKnobs/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9}}];return false;break;}}if(_errs59 === errors){if(data10.availableForNewSessions !== undefined){const _errs60: any = errors;if(typeof data10.availableForNewSessions !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/availableForNewSessions",schemaPath:"#/$defs/ProviderKnobs/properties/availableForNewSessions/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid24: any = _errs60 === errors;}else {var valid24: any = true;}if(valid24){if(data10.helpersAtOnce !== undefined){let data12: any = data10.helpersAtOnce;const _errs62: any = errors;if((!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))) && (data12 !== null)){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/helpersAtOnce",schemaPath:"#/$defs/ProviderKnobs/properties/helpersAtOnce/type",keyword:"type",params:{type: schema1983.properties.helpersAtOnce.type}}];return false;}if(errors === _errs62){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 9007199254740991 || isNaN(data12)){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/helpersAtOnce",schemaPath:"#/$defs/ProviderKnobs/properties/helpersAtOnce/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data12 < 0 || isNaN(data12)){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/helpersAtOnce",schemaPath:"#/$defs/ProviderKnobs/properties/helpersAtOnce/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid24: any = _errs62 === errors;}else {var valid24: any = true;}if(valid24){if(data10.autoCompactPercent !== undefined){let data13: any = data10.autoCompactPercent;const _errs64: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/autoCompactPercent",schemaPath:"#/$defs/ProviderKnobs/properties/autoCompactPercent/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs64){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 100 || isNaN(data13)){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/autoCompactPercent",schemaPath:"#/$defs/ProviderKnobs/properties/autoCompactPercent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data13 < 0 || isNaN(data13)){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/autoCompactPercent",schemaPath:"#/$defs/ProviderKnobs/properties/autoCompactPercent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}else {let res0: any;if(((5 as number) === 0 || (res0 = data13/5, res0 !== parseInt(res0)))){validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1")+"/autoCompactPercent",schemaPath:"#/$defs/ProviderKnobs/properties/autoCompactPercent/multipleOf",keyword:"multipleOf",params:{multipleOf: 5}}];return false;}}}}}var valid24: any = _errs64 === errors;}else {var valid24: any = true;}}}}}else {validate1043.errors = [{instancePath:instancePath+"/providerKnobs/" + key8.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/$defs/ProviderKnobs/type",keyword:"type",params:{type: "object"}}];return false;}}var valid22: any = _errs56 === errors;if(!valid22){break;}}}}else {validate1043.errors = [{instancePath:instancePath+"/providerKnobs",schemaPath:"#/properties/providerKnobs/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs45 === errors;}else {var valid0: any = true;}if(valid0){if(data.commitTextModel !== undefined){let data14: any = data.commitTextModel;const _errs66: any = errors;const _errs67: any = errors;let valid25: any = false;const _errs68: any = errors;if(!(validate1056.call(this, data14, {instancePath:instancePath+"/commitTextModel",parentData:data,parentDataProperty:"commitTextModel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1056.errors : vErrors.concat(validate1056.errors);errors = vErrors.length;}var _valid0: any = _errs68 === errors;valid25 = valid25 || _valid0;const _errs69: any = errors;if(data14 !== null){const err20: any = {instancePath:instancePath+"/commitTextModel",schemaPath:"#/properties/commitTextModel/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}var _valid0: any = _errs69 === errors;valid25 = valid25 || _valid0;if(!valid25){const err21: any = {instancePath:instancePath+"/commitTextModel",schemaPath:"#/properties/commitTextModel/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;validate1043.errors = vErrors;return false;}else {errors = _errs67;if(vErrors !== null){if(_errs67){vErrors.length = _errs67;}else {vErrors = null;}}}var valid0: any = _errs66 === errors;}else {var valid0: any = true;}if(valid0){if(data.defaultCheckout !== undefined){let data15: any = data.defaultCheckout;const _errs71: any = errors;if(typeof data15 !== "string"){validate1043.errors = [{instancePath:instancePath+"/defaultCheckout",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data15 === "boundRoot") || (data15 === "provisionedWorktree"))){validate1043.errors = [{instancePath:instancePath+"/defaultCheckout",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/enum",keyword:"enum",params:{allowedValues: schema1986.enum}}];return false;}var valid0: any = _errs71 === errors;}else {var valid0: any = true;}if(valid0){if(data.newSessionCarriesLastModel !== undefined){const _errs74: any = errors;if(typeof data.newSessionCarriesLastModel !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/newSessionCarriesLastModel",schemaPath:"#/properties/newSessionCarriesLastModel/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs74 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastLeadModel !== undefined){let data17: any = data.lastLeadModel;const _errs76: any = errors;const _errs77: any = errors;let valid27: any = false;const _errs78: any = errors;if(!(validate1058.call(this, data17, {instancePath:instancePath+"/lastLeadModel",parentData:data,parentDataProperty:"lastLeadModel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1058.errors : vErrors.concat(validate1058.errors);errors = vErrors.length;}var _valid1: any = _errs78 === errors;valid27 = valid27 || _valid1;const _errs79: any = errors;if(data17 !== null){const err22: any = {instancePath:instancePath+"/lastLeadModel",schemaPath:"#/properties/lastLeadModel/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}var _valid1: any = _errs79 === errors;valid27 = valid27 || _valid1;if(!valid27){const err23: any = {instancePath:instancePath+"/lastLeadModel",schemaPath:"#/properties/lastLeadModel/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;validate1043.errors = vErrors;return false;}else {errors = _errs77;if(vErrors !== null){if(_errs77){vErrors.length = _errs77;}else {vErrors = null;}}}var valid0: any = _errs76 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepAwakeWhileAgentWorks !== undefined){const _errs81: any = errors;if(typeof data.keepAwakeWhileAgentWorks !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/keepAwakeWhileAgentWorks",schemaPath:"#/properties/keepAwakeWhileAgentWorks/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs81 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepAwakeForOtherDevices !== undefined){const _errs83: any = errors;if(typeof data.keepAwakeForOtherDevices !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/keepAwakeForOtherDevices",schemaPath:"#/properties/keepAwakeForOtherDevices/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs83 === errors;}else {var valid0: any = true;}if(valid0){if(data.notifications !== undefined){const _errs85: any = errors;if(!(validate1060.call(this, data.notifications, {instancePath:instancePath+"/notifications",parentData:data,parentDataProperty:"notifications",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1060.errors : vErrors.concat(validate1060.errors);errors = vErrors.length;}var valid0: any = _errs85 === errors;}else {var valid0: any = true;}if(valid0){if(data.rememberSiteData !== undefined){const _errs86: any = errors;if(typeof data.rememberSiteData !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/rememberSiteData",schemaPath:"#/properties/rememberSiteData/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs86 === errors;}else {var valid0: any = true;}if(valid0){if(data.browserToolsForAgents !== undefined){const _errs88: any = errors;if(typeof data.browserToolsForAgents !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/browserToolsForAgents",schemaPath:"#/properties/browserToolsForAgents/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs88 === errors;}else {var valid0: any = true;}if(valid0){if(data.sandboxBackgroundBrowser !== undefined){const _errs90: any = errors;if(typeof data.sandboxBackgroundBrowser !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/sandboxBackgroundBrowser",schemaPath:"#/properties/sandboxBackgroundBrowser/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs90 === errors;}else {var valid0: any = true;}if(valid0){if(data.screenReaderMode !== undefined){const _errs92: any = errors;if(typeof data.screenReaderMode !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/screenReaderMode",schemaPath:"#/properties/screenReaderMode/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs92 === errors;}else {var valid0: any = true;}if(valid0){if(data.environmentRows !== undefined){let data25: any = data.environmentRows;const _errs94: any = errors;if(errors === _errs94){if(Array.isArray(data25)){var valid28: any = true;const len1: any = data25.length;for(let i2=0; i2<len1; i2++){let data26: any = data25[i2];const _errs96: any = errors;const _errs97: any = errors;if(errors === _errs97){if(data26 && typeof data26 == "object" && !Array.isArray(data26)){let missing1: any;if(((data26.name === undefined) && (missing1 = "name")) || ((data26.value === undefined) && (missing1 = "value"))){validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2,schemaPath:"#/$defs/EnvironmentRow/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs99: any = errors;for(const key10 in data26){if(!((key10 === "name") || (key10 === "value"))){validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2,schemaPath:"#/$defs/EnvironmentRow/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key10}}];return false;break;}}if(_errs99 === errors){if(data26.name !== undefined){let data27: any = data26.name;const _errs100: any = errors;if(errors === _errs100){if(typeof data27 === "string"){if(func1(data27) > 32767){validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2+"/name",schemaPath:"#/$defs/EnvironmentRow/properties/name/maxLength",keyword:"maxLength",params:{limit: 32767}}];return false;}else {if(func1(data27) < 1){validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2+"/name",schemaPath:"#/$defs/EnvironmentRow/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2+"/name",schemaPath:"#/$defs/EnvironmentRow/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid30: any = _errs100 === errors;}else {var valid30: any = true;}if(valid30){if(data26.value !== undefined){let data28: any = data26.value;const _errs102: any = errors;if(errors === _errs102){if(typeof data28 === "string"){if(func1(data28) > 32767){validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2+"/value",schemaPath:"#/$defs/EnvironmentRow/properties/value/maxLength",keyword:"maxLength",params:{limit: 32767}}];return false;}else {if(!pattern43.test(data28)){validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2+"/value",schemaPath:"#/$defs/EnvironmentRow/properties/value/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}else {validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2+"/value",schemaPath:"#/$defs/EnvironmentRow/properties/value/type",keyword:"type",params:{type: "string"}}];return false;}}var valid30: any = _errs102 === errors;}else {var valid30: any = true;}}}}}else {validate1043.errors = [{instancePath:instancePath+"/environmentRows/" + i2,schemaPath:"#/$defs/EnvironmentRow/type",keyword:"type",params:{type: "object"}}];return false;}}var valid28: any = _errs96 === errors;if(!valid28){break;}}}else {validate1043.errors = [{instancePath:instancePath+"/environmentRows",schemaPath:"#/properties/environmentRows/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs94 === errors;}else {var valid0: any = true;}if(valid0){if(data.backup !== undefined){let data29: any = data.backup;const _errs104: any = errors;const _errs105: any = errors;if(errors === _errs105){if(data29 && typeof data29 == "object" && !Array.isArray(data29)){let missing2: any;if(((data29.automatic === undefined) && (missing2 = "automatic")) || ((data29.folder === undefined) && (missing2 = "folder"))){validate1043.errors = [{instancePath:instancePath+"/backup",schemaPath:"#/$defs/BackupSettings/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs107: any = errors;for(const key11 in data29){if(!((key11 === "automatic") || (key11 === "folder"))){validate1043.errors = [{instancePath:instancePath+"/backup",schemaPath:"#/$defs/BackupSettings/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key11}}];return false;break;}}if(_errs107 === errors){if(data29.automatic !== undefined){const _errs108: any = errors;if(typeof data29.automatic !== "boolean"){validate1043.errors = [{instancePath:instancePath+"/backup/automatic",schemaPath:"#/$defs/BackupSettings/properties/automatic/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid32: any = _errs108 === errors;}else {var valid32: any = true;}if(valid32){if(data29.folder !== undefined){let data31: any = data29.folder;const _errs110: any = errors;if((typeof data31 !== "string") && (data31 !== null)){validate1043.errors = [{instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/type",keyword:"type",params:{type: schema1998.properties.folder.type}}];return false;}if(errors === _errs110){if(typeof data31 === "string"){if(func1(data31) > 4096){validate1043.errors = [{instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data31) < 1){validate1043.errors = [{instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data31)){validate1043.errors = [{instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}}var valid32: any = _errs110 === errors;}else {var valid32: any = true;}}}}}else {validate1043.errors = [{instancePath:instancePath+"/backup",schemaPath:"#/$defs/BackupSettings/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs104 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchNamePattern !== undefined){let data32: any = data.branchNamePattern;const _errs112: any = errors;const _errs114: any = errors;if(errors === _errs114){if(typeof data32 === "string"){if(func1(data32) > 256){validate1043.errors = [{instancePath:instancePath+"/branchNamePattern",schemaPath:"#/$defs/BranchNamePattern/allOf/0/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data32) < 1){validate1043.errors = [{instancePath:instancePath+"/branchNamePattern",schemaPath:"#/$defs/BranchNamePattern/allOf/0/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data32)){validate1043.errors = [{instancePath:instancePath+"/branchNamePattern",schemaPath:"#/$defs/BranchNamePattern/allOf/0/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1043.errors = [{instancePath:instancePath+"/branchNamePattern",schemaPath:"#/$defs/BranchNamePattern/allOf/0/type",keyword:"type",params:{type: "string"}}];return false;}}var valid34: any = _errs114 === errors;if(valid34){const _errs116: any = errors;if(errors === _errs116){if(typeof data32 === "string"){if(!pattern1201.test(data32)){validate1043.errors = [{instancePath:instancePath+"/branchNamePattern",schemaPath:"#/$defs/BranchNamePattern/allOf/1/pattern",keyword:"pattern",params:{pattern: "^(?![^]*\\{title\\}[^]*\\{title\\})[^]*\\{title\\}"}}];return false;}}else {validate1043.errors = [{instancePath:instancePath+"/branchNamePattern",schemaPath:"#/$defs/BranchNamePattern/allOf/1/type",keyword:"type",params:{type: "string"}}];return false;}}var valid34: any = _errs116 === errors;}var valid0: any = _errs112 === errors;}else {var valid0: any = true;}if(valid0){if(data.cloneFolder !== undefined){let data33: any = data.cloneFolder;const _errs118: any = errors;const _errs119: any = errors;let valid35: any = false;const _errs120: any = errors;if(!(validate1066.call(this, data33, {instancePath:instancePath+"/cloneFolder",parentData:data,parentDataProperty:"cloneFolder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1066.errors : vErrors.concat(validate1066.errors);errors = vErrors.length;}var _valid2: any = _errs120 === errors;valid35 = valid35 || _valid2;const _errs121: any = errors;if(data33 !== null){const err24: any = {instancePath:instancePath+"/cloneFolder",schemaPath:"#/properties/cloneFolder/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}var _valid2: any = _errs121 === errors;valid35 = valid35 || _valid2;if(!valid35){const err25: any = {instancePath:instancePath+"/cloneFolder",schemaPath:"#/properties/cloneFolder/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;validate1043.errors = vErrors;return false;}else {errors = _errs119;if(vErrors !== null){if(_errs119){vErrors.length = _errs119;}else {vErrors = null;}}}var valid0: any = _errs118 === errors;}else {var valid0: any = true;}if(valid0){if(data.voice !== undefined){const _errs123: any = errors;if(!(validate1069.call(this, data.voice, {instancePath:instancePath+"/voice",parentData:data,parentDataProperty:"voice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1069.errors : vErrors.concat(validate1069.errors);errors = vErrors.length;}var valid0: any = _errs123 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}}}}}}}}}}else {validate1043.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1043.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1043.errors = null as any[] | null;
// prettier-ignore
validate1043.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2003: any = {"oneOf":[{"type":"object","properties":{"updatesAutomatic":{"type":"boolean"}},"required":["updatesAutomatic"],"additionalProperties":false,"description":"`Check for updates automatically`."},{"type":"object","properties":{"keepCrashReports":{"type":"boolean"}},"required":["keepCrashReports"],"additionalProperties":false,"description":"`Keep crash reports`."},{"type":"object","properties":{"editorId":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256}},"required":["editorId"],"additionalProperties":false,"description":"`Editor that opens files`."},{"type":"object","properties":{"commitTextModel":{"anyOf":[{"$ref":"#/$defs/CommitTextModel"},{"type":"null"}]}},"required":["commitTextModel"],"additionalProperties":false,"description":"`Commit and pull request text`."},{"type":"object","properties":{"defaultCheckout":{"$ref":"sidekicks-contracts:repo/mount#/$defs/ExecutionMode"}},"required":["defaultCheckout"],"additionalProperties":false,"description":"`Default checkout for a new project session`."},{"type":"object","properties":{"newSessionCarriesLastModel":{"type":"boolean"}},"required":["newSessionCarriesLastModel"],"additionalProperties":false,"description":"`Start a new session on the last model and effort used`."},{"type":"object","properties":{"lastLeadModel":{"anyOf":[{"$ref":"#/$defs/LastLeadModel"},{"type":"null"}]}},"required":["lastLeadModel"],"additionalProperties":false,"description":"The last model and effort picked."},{"type":"object","properties":{"keepAwakeWhileAgentWorks":{"type":"boolean"}},"required":["keepAwakeWhileAgentWorks"],"additionalProperties":false,"description":"`Keep this Mac awake while a sidekick is working`."},{"type":"object","properties":{"keepAwakeForOtherDevices":{"type":"boolean"}},"required":["keepAwakeForOtherDevices"],"additionalProperties":false,"description":"`Keep this Mac awake for other devices`."},{"type":"object","properties":{"notifications":{"$ref":"#/$defs/NotificationSettings"}},"required":["notifications"],"additionalProperties":false,"description":"The Notifications page's settings, whole."},{"type":"object","properties":{"rememberSiteData":{"type":"boolean"}},"required":["rememberSiteData"],"additionalProperties":false,"description":"`Remember site data`."},{"type":"object","properties":{"browserToolsForAgents":{"type":"boolean"}},"required":["browserToolsForAgents"],"additionalProperties":false,"description":"`Browser tools for sidekicks`."},{"type":"object","properties":{"sandboxBackgroundBrowser":{"type":"boolean"}},"required":["sandboxBackgroundBrowser"],"additionalProperties":false,"description":"`Sandbox the background browser`."},{"type":"object","properties":{"screenReaderMode":{"type":"boolean"}},"required":["screenReaderMode"],"additionalProperties":false,"description":"`Simplify for a screen reader`."},{"type":"object","properties":{"environmentRows":{"type":"array","items":{"$ref":"#/$defs/EnvironmentRow"}}},"required":["environmentRows"],"additionalProperties":false,"description":"`Every project`'s environment rows, whole."},{"type":"object","properties":{"backup":{"$ref":"#/$defs/BackupSettings"}},"required":["backup"],"additionalProperties":false,"description":"The backup settings, whole."},{"type":"object","properties":{"branchNamePattern":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256}},"required":["branchNamePattern"],"additionalProperties":false,"description":"`Every project`'s `Branch names`."},{"type":"object","properties":{"cloneFolder":{"anyOf":[{"$ref":"sidekicks-contracts:place#/$defs/PlacedPath"},{"type":"null"}]}},"required":["cloneFolder"],"additionalProperties":false,"description":"`Clone new repositories into`."},{"type":"object","properties":{"voice":{"$ref":"#/$defs/VoiceSettings"}},"required":["voice"],"additionalProperties":false,"description":"The voice settings, whole."}],"description":"One change to the file: exactly one top-level member, with its whole value. A group such as\n`notifications` is written whole, so a change to one of its switches carries the group as the\npage last read it with that switch moved. A pattern's `{title}` rule is the service's coded\nrefusal, not a parse failure."};
// prettier-ignore
function validate1071(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineSettingsChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1071.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;let passing0: any = null;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.updatesAutomatic === undefined) && (missing0 = "updatesAutomatic")){const err0: any = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(key0 === "updatesAutomatic")){const err1: any = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.updatesAutomatic !== undefined){if(typeof data.updatesAutomatic !== "boolean"){const err2: any = {instancePath:instancePath+"/updatesAutomatic",schemaPath:"#/oneOf/0/properties/updatesAutomatic/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}}else {const err3: any = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var _valid0: any = _errs1 === errors;if(_valid0){valid0 = true;passing0 = 0;var props0: any = true;}const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.keepCrashReports === undefined) && (missing1 = "keepCrashReports")){const err4: any = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {const _errs8: any = errors;for(const key1 in data){if(!(key1 === "keepCrashReports")){const err5: any = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;break;}}if(_errs8 === errors){if(data.keepCrashReports !== undefined){if(typeof data.keepCrashReports !== "boolean"){const err6: any = {instancePath:instancePath+"/keepCrashReports",schemaPath:"#/oneOf/1/properties/keepCrashReports/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}}}}else {const err7: any = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var _valid0: any = _errs6 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 1];}else {if(_valid0){valid0 = true;passing0 = 1;if(props0 !== true){props0 = true;}}const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.editorId === undefined) && (missing2 = "editorId")){const err8: any = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}else {const _errs13: any = errors;for(const key2 in data){if(!(key2 === "editorId")){const err9: any = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;break;}}if(_errs13 === errors){if(data.editorId !== undefined){let data2: any = data.editorId;const _errs14: any = errors;if((typeof data2 !== "string") && (data2 !== null)){const err10: any = {instancePath:instancePath+"/editorId",schemaPath:"#/oneOf/2/properties/editorId/type",keyword:"type",params:{type: schema2003.oneOf[2].properties.editorId.type}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}if(errors === _errs14){if(typeof data2 === "string"){if(func1(data2) > 256){const err11: any = {instancePath:instancePath+"/editorId",schemaPath:"#/oneOf/2/properties/editorId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(func1(data2) < 1){const err12: any = {instancePath:instancePath+"/editorId",schemaPath:"#/oneOf/2/properties/editorId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {if(!pattern6.test(data2)){const err13: any = {instancePath:instancePath+"/editorId",schemaPath:"#/oneOf/2/properties/editorId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}}}}}}}}else {const err14: any = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var _valid0: any = _errs11 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 2];}else {if(_valid0){valid0 = true;passing0 = 2;if(props0 !== true){props0 = true;}}const _errs16: any = errors;if(errors === _errs16){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.commitTextModel === undefined) && (missing3 = "commitTextModel")){const err15: any = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {const _errs18: any = errors;for(const key3 in data){if(!(key3 === "commitTextModel")){const err16: any = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;break;}}if(_errs18 === errors){if(data.commitTextModel !== undefined){let data3: any = data.commitTextModel;const _errs20: any = errors;let valid5: any = false;const _errs21: any = errors;if(!(validate1056.call(this, data3, {instancePath:instancePath+"/commitTextModel",parentData:data,parentDataProperty:"commitTextModel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1056.errors : vErrors.concat(validate1056.errors);errors = vErrors.length;}var _valid1: any = _errs21 === errors;valid5 = valid5 || _valid1;const _errs22: any = errors;if(data3 !== null){const err17: any = {instancePath:instancePath+"/commitTextModel",schemaPath:"#/oneOf/3/properties/commitTextModel/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var _valid1: any = _errs22 === errors;valid5 = valid5 || _valid1;if(!valid5){const err18: any = {instancePath:instancePath+"/commitTextModel",schemaPath:"#/oneOf/3/properties/commitTextModel/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {errors = _errs20;if(vErrors !== null){if(_errs20){vErrors.length = _errs20;}else {vErrors = null;}}}}}}}else {const err19: any = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var _valid0: any = _errs16 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 3];}else {if(_valid0){valid0 = true;passing0 = 3;if(props0 !== true){props0 = true;}}const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.defaultCheckout === undefined) && (missing4 = "defaultCheckout")){const err20: any = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}else {const _errs26: any = errors;for(const key4 in data){if(!(key4 === "defaultCheckout")){const err21: any = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;break;}}if(_errs26 === errors){if(data.defaultCheckout !== undefined){let data4: any = data.defaultCheckout;if(typeof data4 !== "string"){const err22: any = {instancePath:instancePath+"/defaultCheckout",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}if(!((data4 === "boundRoot") || (data4 === "provisionedWorktree"))){const err23: any = {instancePath:instancePath+"/defaultCheckout",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/enum",keyword:"enum",params:{allowedValues: schema1986.enum}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}}}}else {const err24: any = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}var _valid0: any = _errs24 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 4];}else {if(_valid0){valid0 = true;passing0 = 4;if(props0 !== true){props0 = true;}}const _errs30: any = errors;if(errors === _errs30){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((data.newSessionCarriesLastModel === undefined) && (missing5 = "newSessionCarriesLastModel")){const err25: any = {instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}else {const _errs32: any = errors;for(const key5 in data){if(!(key5 === "newSessionCarriesLastModel")){const err26: any = {instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;break;}}if(_errs32 === errors){if(data.newSessionCarriesLastModel !== undefined){if(typeof data.newSessionCarriesLastModel !== "boolean"){const err27: any = {instancePath:instancePath+"/newSessionCarriesLastModel",schemaPath:"#/oneOf/5/properties/newSessionCarriesLastModel/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}}}}else {const err28: any = {instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}var _valid0: any = _errs30 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 5];}else {if(_valid0){valid0 = true;passing0 = 5;if(props0 !== true){props0 = true;}}const _errs35: any = errors;if(errors === _errs35){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((data.lastLeadModel === undefined) && (missing6 = "lastLeadModel")){const err29: any = {instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}else {const _errs37: any = errors;for(const key6 in data){if(!(key6 === "lastLeadModel")){const err30: any = {instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;break;}}if(_errs37 === errors){if(data.lastLeadModel !== undefined){let data6: any = data.lastLeadModel;const _errs39: any = errors;let valid10: any = false;const _errs40: any = errors;if(!(validate1058.call(this, data6, {instancePath:instancePath+"/lastLeadModel",parentData:data,parentDataProperty:"lastLeadModel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1058.errors : vErrors.concat(validate1058.errors);errors = vErrors.length;}var _valid2: any = _errs40 === errors;valid10 = valid10 || _valid2;const _errs41: any = errors;if(data6 !== null){const err31: any = {instancePath:instancePath+"/lastLeadModel",schemaPath:"#/oneOf/6/properties/lastLeadModel/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}var _valid2: any = _errs41 === errors;valid10 = valid10 || _valid2;if(!valid10){const err32: any = {instancePath:instancePath+"/lastLeadModel",schemaPath:"#/oneOf/6/properties/lastLeadModel/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}else {errors = _errs39;if(vErrors !== null){if(_errs39){vErrors.length = _errs39;}else {vErrors = null;}}}}}}}else {const err33: any = {instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}}var _valid0: any = _errs35 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 6];}else {if(_valid0){valid0 = true;passing0 = 6;if(props0 !== true){props0 = true;}}const _errs43: any = errors;if(errors === _errs43){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((data.keepAwakeWhileAgentWorks === undefined) && (missing7 = "keepAwakeWhileAgentWorks")){const err34: any = {instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing7}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}else {const _errs45: any = errors;for(const key7 in data){if(!(key7 === "keepAwakeWhileAgentWorks")){const err35: any = {instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;break;}}if(_errs45 === errors){if(data.keepAwakeWhileAgentWorks !== undefined){if(typeof data.keepAwakeWhileAgentWorks !== "boolean"){const err36: any = {instancePath:instancePath+"/keepAwakeWhileAgentWorks",schemaPath:"#/oneOf/7/properties/keepAwakeWhileAgentWorks/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}}}}}else {const err37: any = {instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}}var _valid0: any = _errs43 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 7];}else {if(_valid0){valid0 = true;passing0 = 7;if(props0 !== true){props0 = true;}}const _errs48: any = errors;if(errors === _errs48){if(data && typeof data == "object" && !Array.isArray(data)){let missing8: any;if((data.keepAwakeForOtherDevices === undefined) && (missing8 = "keepAwakeForOtherDevices")){const err38: any = {instancePath,schemaPath:"#/oneOf/8/required",keyword:"required",params:{missingProperty: missing8}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}else {const _errs50: any = errors;for(const key8 in data){if(!(key8 === "keepAwakeForOtherDevices")){const err39: any = {instancePath,schemaPath:"#/oneOf/8/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;break;}}if(_errs50 === errors){if(data.keepAwakeForOtherDevices !== undefined){if(typeof data.keepAwakeForOtherDevices !== "boolean"){const err40: any = {instancePath:instancePath+"/keepAwakeForOtherDevices",schemaPath:"#/oneOf/8/properties/keepAwakeForOtherDevices/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}}}}}else {const err41: any = {instancePath,schemaPath:"#/oneOf/8/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}}var _valid0: any = _errs48 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 8];}else {if(_valid0){valid0 = true;passing0 = 8;if(props0 !== true){props0 = true;}}const _errs53: any = errors;if(errors === _errs53){if(data && typeof data == "object" && !Array.isArray(data)){let missing9: any;if((data.notifications === undefined) && (missing9 = "notifications")){const err42: any = {instancePath,schemaPath:"#/oneOf/9/required",keyword:"required",params:{missingProperty: missing9}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}else {const _errs55: any = errors;for(const key9 in data){if(!(key9 === "notifications")){const err43: any = {instancePath,schemaPath:"#/oneOf/9/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;break;}}if(_errs55 === errors){if(data.notifications !== undefined){if(!(validate1060.call(this, data.notifications, {instancePath:instancePath+"/notifications",parentData:data,parentDataProperty:"notifications",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1060.errors : vErrors.concat(validate1060.errors);errors = vErrors.length;}}}}}else {const err44: any = {instancePath,schemaPath:"#/oneOf/9/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;}}var _valid0: any = _errs53 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 9];}else {if(_valid0){valid0 = true;passing0 = 9;if(props0 !== true){props0 = true;}}const _errs57: any = errors;if(errors === _errs57){if(data && typeof data == "object" && !Array.isArray(data)){let missing10: any;if((data.rememberSiteData === undefined) && (missing10 = "rememberSiteData")){const err45: any = {instancePath,schemaPath:"#/oneOf/10/required",keyword:"required",params:{missingProperty: missing10}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;}else {const _errs59: any = errors;for(const key10 in data){if(!(key10 === "rememberSiteData")){const err46: any = {instancePath,schemaPath:"#/oneOf/10/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key10}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;break;}}if(_errs59 === errors){if(data.rememberSiteData !== undefined){if(typeof data.rememberSiteData !== "boolean"){const err47: any = {instancePath:instancePath+"/rememberSiteData",schemaPath:"#/oneOf/10/properties/rememberSiteData/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;}}}}}else {const err48: any = {instancePath,schemaPath:"#/oneOf/10/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err48];}else {vErrors.push(err48);}errors++;}}var _valid0: any = _errs57 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 10];}else {if(_valid0){valid0 = true;passing0 = 10;if(props0 !== true){props0 = true;}}const _errs62: any = errors;if(errors === _errs62){if(data && typeof data == "object" && !Array.isArray(data)){let missing11: any;if((data.browserToolsForAgents === undefined) && (missing11 = "browserToolsForAgents")){const err49: any = {instancePath,schemaPath:"#/oneOf/11/required",keyword:"required",params:{missingProperty: missing11}};if(vErrors === null){vErrors = [err49];}else {vErrors.push(err49);}errors++;}else {const _errs64: any = errors;for(const key11 in data){if(!(key11 === "browserToolsForAgents")){const err50: any = {instancePath,schemaPath:"#/oneOf/11/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key11}};if(vErrors === null){vErrors = [err50];}else {vErrors.push(err50);}errors++;break;}}if(_errs64 === errors){if(data.browserToolsForAgents !== undefined){if(typeof data.browserToolsForAgents !== "boolean"){const err51: any = {instancePath:instancePath+"/browserToolsForAgents",schemaPath:"#/oneOf/11/properties/browserToolsForAgents/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err51];}else {vErrors.push(err51);}errors++;}}}}}else {const err52: any = {instancePath,schemaPath:"#/oneOf/11/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err52];}else {vErrors.push(err52);}errors++;}}var _valid0: any = _errs62 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 11];}else {if(_valid0){valid0 = true;passing0 = 11;if(props0 !== true){props0 = true;}}const _errs67: any = errors;if(errors === _errs67){if(data && typeof data == "object" && !Array.isArray(data)){let missing12: any;if((data.sandboxBackgroundBrowser === undefined) && (missing12 = "sandboxBackgroundBrowser")){const err53: any = {instancePath,schemaPath:"#/oneOf/12/required",keyword:"required",params:{missingProperty: missing12}};if(vErrors === null){vErrors = [err53];}else {vErrors.push(err53);}errors++;}else {const _errs69: any = errors;for(const key12 in data){if(!(key12 === "sandboxBackgroundBrowser")){const err54: any = {instancePath,schemaPath:"#/oneOf/12/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key12}};if(vErrors === null){vErrors = [err54];}else {vErrors.push(err54);}errors++;break;}}if(_errs69 === errors){if(data.sandboxBackgroundBrowser !== undefined){if(typeof data.sandboxBackgroundBrowser !== "boolean"){const err55: any = {instancePath:instancePath+"/sandboxBackgroundBrowser",schemaPath:"#/oneOf/12/properties/sandboxBackgroundBrowser/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err55];}else {vErrors.push(err55);}errors++;}}}}}else {const err56: any = {instancePath,schemaPath:"#/oneOf/12/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err56];}else {vErrors.push(err56);}errors++;}}var _valid0: any = _errs67 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 12];}else {if(_valid0){valid0 = true;passing0 = 12;if(props0 !== true){props0 = true;}}const _errs72: any = errors;if(errors === _errs72){if(data && typeof data == "object" && !Array.isArray(data)){let missing13: any;if((data.screenReaderMode === undefined) && (missing13 = "screenReaderMode")){const err57: any = {instancePath,schemaPath:"#/oneOf/13/required",keyword:"required",params:{missingProperty: missing13}};if(vErrors === null){vErrors = [err57];}else {vErrors.push(err57);}errors++;}else {const _errs74: any = errors;for(const key13 in data){if(!(key13 === "screenReaderMode")){const err58: any = {instancePath,schemaPath:"#/oneOf/13/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key13}};if(vErrors === null){vErrors = [err58];}else {vErrors.push(err58);}errors++;break;}}if(_errs74 === errors){if(data.screenReaderMode !== undefined){if(typeof data.screenReaderMode !== "boolean"){const err59: any = {instancePath:instancePath+"/screenReaderMode",schemaPath:"#/oneOf/13/properties/screenReaderMode/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err59];}else {vErrors.push(err59);}errors++;}}}}}else {const err60: any = {instancePath,schemaPath:"#/oneOf/13/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err60];}else {vErrors.push(err60);}errors++;}}var _valid0: any = _errs72 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 13];}else {if(_valid0){valid0 = true;passing0 = 13;if(props0 !== true){props0 = true;}}const _errs77: any = errors;if(errors === _errs77){if(data && typeof data == "object" && !Array.isArray(data)){let missing14: any;if((data.environmentRows === undefined) && (missing14 = "environmentRows")){const err61: any = {instancePath,schemaPath:"#/oneOf/14/required",keyword:"required",params:{missingProperty: missing14}};if(vErrors === null){vErrors = [err61];}else {vErrors.push(err61);}errors++;}else {const _errs79: any = errors;for(const key14 in data){if(!(key14 === "environmentRows")){const err62: any = {instancePath,schemaPath:"#/oneOf/14/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key14}};if(vErrors === null){vErrors = [err62];}else {vErrors.push(err62);}errors++;break;}}if(_errs79 === errors){if(data.environmentRows !== undefined){let data14: any = data.environmentRows;const _errs80: any = errors;if(errors === _errs80){if(Array.isArray(data14)){var valid19: any = true;const len0: any = data14.length;for(let i0=0; i0<len0; i0++){let data15: any = data14[i0];const _errs82: any = errors;const _errs83: any = errors;if(errors === _errs83){if(data15 && typeof data15 == "object" && !Array.isArray(data15)){let missing15: any;if(((data15.name === undefined) && (missing15 = "name")) || ((data15.value === undefined) && (missing15 = "value"))){const err63: any = {instancePath:instancePath+"/environmentRows/" + i0,schemaPath:"#/$defs/EnvironmentRow/required",keyword:"required",params:{missingProperty: missing15}};if(vErrors === null){vErrors = [err63];}else {vErrors.push(err63);}errors++;}else {const _errs85: any = errors;for(const key15 in data15){if(!((key15 === "name") || (key15 === "value"))){const err64: any = {instancePath:instancePath+"/environmentRows/" + i0,schemaPath:"#/$defs/EnvironmentRow/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key15}};if(vErrors === null){vErrors = [err64];}else {vErrors.push(err64);}errors++;break;}}if(_errs85 === errors){if(data15.name !== undefined){let data16: any = data15.name;const _errs86: any = errors;if(errors === _errs86){if(typeof data16 === "string"){if(func1(data16) > 32767){const err65: any = {instancePath:instancePath+"/environmentRows/" + i0+"/name",schemaPath:"#/$defs/EnvironmentRow/properties/name/maxLength",keyword:"maxLength",params:{limit: 32767}};if(vErrors === null){vErrors = [err65];}else {vErrors.push(err65);}errors++;}else {if(func1(data16) < 1){const err66: any = {instancePath:instancePath+"/environmentRows/" + i0+"/name",schemaPath:"#/$defs/EnvironmentRow/properties/name/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err66];}else {vErrors.push(err66);}errors++;}}}else {const err67: any = {instancePath:instancePath+"/environmentRows/" + i0+"/name",schemaPath:"#/$defs/EnvironmentRow/properties/name/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err67];}else {vErrors.push(err67);}errors++;}}var valid21: any = _errs86 === errors;}else {var valid21: any = true;}if(valid21){if(data15.value !== undefined){let data17: any = data15.value;const _errs88: any = errors;if(errors === _errs88){if(typeof data17 === "string"){if(func1(data17) > 32767){const err68: any = {instancePath:instancePath+"/environmentRows/" + i0+"/value",schemaPath:"#/$defs/EnvironmentRow/properties/value/maxLength",keyword:"maxLength",params:{limit: 32767}};if(vErrors === null){vErrors = [err68];}else {vErrors.push(err68);}errors++;}else {if(!pattern43.test(data17)){const err69: any = {instancePath:instancePath+"/environmentRows/" + i0+"/value",schemaPath:"#/$defs/EnvironmentRow/properties/value/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err69];}else {vErrors.push(err69);}errors++;}}}else {const err70: any = {instancePath:instancePath+"/environmentRows/" + i0+"/value",schemaPath:"#/$defs/EnvironmentRow/properties/value/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err70];}else {vErrors.push(err70);}errors++;}}var valid21: any = _errs88 === errors;}else {var valid21: any = true;}}}}}else {const err71: any = {instancePath:instancePath+"/environmentRows/" + i0,schemaPath:"#/$defs/EnvironmentRow/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err71];}else {vErrors.push(err71);}errors++;}}var valid19: any = _errs82 === errors;if(!valid19){break;}}}else {const err72: any = {instancePath:instancePath+"/environmentRows",schemaPath:"#/oneOf/14/properties/environmentRows/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err72];}else {vErrors.push(err72);}errors++;}}}}}}else {const err73: any = {instancePath,schemaPath:"#/oneOf/14/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err73];}else {vErrors.push(err73);}errors++;}}var _valid0: any = _errs77 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 14];}else {if(_valid0){valid0 = true;passing0 = 14;if(props0 !== true){props0 = true;}}const _errs90: any = errors;if(errors === _errs90){if(data && typeof data == "object" && !Array.isArray(data)){let missing16: any;if((data.backup === undefined) && (missing16 = "backup")){const err74: any = {instancePath,schemaPath:"#/oneOf/15/required",keyword:"required",params:{missingProperty: missing16}};if(vErrors === null){vErrors = [err74];}else {vErrors.push(err74);}errors++;}else {const _errs92: any = errors;for(const key16 in data){if(!(key16 === "backup")){const err75: any = {instancePath,schemaPath:"#/oneOf/15/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key16}};if(vErrors === null){vErrors = [err75];}else {vErrors.push(err75);}errors++;break;}}if(_errs92 === errors){if(data.backup !== undefined){let data18: any = data.backup;const _errs94: any = errors;if(errors === _errs94){if(data18 && typeof data18 == "object" && !Array.isArray(data18)){let missing17: any;if(((data18.automatic === undefined) && (missing17 = "automatic")) || ((data18.folder === undefined) && (missing17 = "folder"))){const err76: any = {instancePath:instancePath+"/backup",schemaPath:"#/$defs/BackupSettings/required",keyword:"required",params:{missingProperty: missing17}};if(vErrors === null){vErrors = [err76];}else {vErrors.push(err76);}errors++;}else {const _errs96: any = errors;for(const key17 in data18){if(!((key17 === "automatic") || (key17 === "folder"))){const err77: any = {instancePath:instancePath+"/backup",schemaPath:"#/$defs/BackupSettings/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key17}};if(vErrors === null){vErrors = [err77];}else {vErrors.push(err77);}errors++;break;}}if(_errs96 === errors){if(data18.automatic !== undefined){const _errs97: any = errors;if(typeof data18.automatic !== "boolean"){const err78: any = {instancePath:instancePath+"/backup/automatic",schemaPath:"#/$defs/BackupSettings/properties/automatic/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err78];}else {vErrors.push(err78);}errors++;}var valid24: any = _errs97 === errors;}else {var valid24: any = true;}if(valid24){if(data18.folder !== undefined){let data20: any = data18.folder;const _errs99: any = errors;if((typeof data20 !== "string") && (data20 !== null)){const err79: any = {instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/type",keyword:"type",params:{type: schema1998.properties.folder.type}};if(vErrors === null){vErrors = [err79];}else {vErrors.push(err79);}errors++;}if(errors === _errs99){if(typeof data20 === "string"){if(func1(data20) > 4096){const err80: any = {instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err80];}else {vErrors.push(err80);}errors++;}else {if(func1(data20) < 1){const err81: any = {instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err81];}else {vErrors.push(err81);}errors++;}else {if(!pattern43.test(data20)){const err82: any = {instancePath:instancePath+"/backup/folder",schemaPath:"#/$defs/BackupSettings/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err82];}else {vErrors.push(err82);}errors++;}}}}}var valid24: any = _errs99 === errors;}else {var valid24: any = true;}}}}}else {const err83: any = {instancePath:instancePath+"/backup",schemaPath:"#/$defs/BackupSettings/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err83];}else {vErrors.push(err83);}errors++;}}}}}}else {const err84: any = {instancePath,schemaPath:"#/oneOf/15/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err84];}else {vErrors.push(err84);}errors++;}}var _valid0: any = _errs90 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 15];}else {if(_valid0){valid0 = true;passing0 = 15;if(props0 !== true){props0 = true;}}const _errs101: any = errors;if(errors === _errs101){if(data && typeof data == "object" && !Array.isArray(data)){let missing18: any;if((data.branchNamePattern === undefined) && (missing18 = "branchNamePattern")){const err85: any = {instancePath,schemaPath:"#/oneOf/16/required",keyword:"required",params:{missingProperty: missing18}};if(vErrors === null){vErrors = [err85];}else {vErrors.push(err85);}errors++;}else {const _errs103: any = errors;for(const key18 in data){if(!(key18 === "branchNamePattern")){const err86: any = {instancePath,schemaPath:"#/oneOf/16/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key18}};if(vErrors === null){vErrors = [err86];}else {vErrors.push(err86);}errors++;break;}}if(_errs103 === errors){if(data.branchNamePattern !== undefined){let data21: any = data.branchNamePattern;const _errs104: any = errors;if(errors === _errs104){if(typeof data21 === "string"){if(func1(data21) > 256){const err87: any = {instancePath:instancePath+"/branchNamePattern",schemaPath:"#/oneOf/16/properties/branchNamePattern/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err87];}else {vErrors.push(err87);}errors++;}else {if(func1(data21) < 1){const err88: any = {instancePath:instancePath+"/branchNamePattern",schemaPath:"#/oneOf/16/properties/branchNamePattern/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err88];}else {vErrors.push(err88);}errors++;}else {if(!pattern6.test(data21)){const err89: any = {instancePath:instancePath+"/branchNamePattern",schemaPath:"#/oneOf/16/properties/branchNamePattern/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err89];}else {vErrors.push(err89);}errors++;}}}}else {const err90: any = {instancePath:instancePath+"/branchNamePattern",schemaPath:"#/oneOf/16/properties/branchNamePattern/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err90];}else {vErrors.push(err90);}errors++;}}}}}}else {const err91: any = {instancePath,schemaPath:"#/oneOf/16/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err91];}else {vErrors.push(err91);}errors++;}}var _valid0: any = _errs101 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 16];}else {if(_valid0){valid0 = true;passing0 = 16;if(props0 !== true){props0 = true;}}const _errs106: any = errors;if(errors === _errs106){if(data && typeof data == "object" && !Array.isArray(data)){let missing19: any;if((data.cloneFolder === undefined) && (missing19 = "cloneFolder")){const err92: any = {instancePath,schemaPath:"#/oneOf/17/required",keyword:"required",params:{missingProperty: missing19}};if(vErrors === null){vErrors = [err92];}else {vErrors.push(err92);}errors++;}else {const _errs108: any = errors;for(const key19 in data){if(!(key19 === "cloneFolder")){const err93: any = {instancePath,schemaPath:"#/oneOf/17/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key19}};if(vErrors === null){vErrors = [err93];}else {vErrors.push(err93);}errors++;break;}}if(_errs108 === errors){if(data.cloneFolder !== undefined){let data22: any = data.cloneFolder;const _errs110: any = errors;let valid27: any = false;const _errs111: any = errors;if(!(validate1066.call(this, data22, {instancePath:instancePath+"/cloneFolder",parentData:data,parentDataProperty:"cloneFolder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1066.errors : vErrors.concat(validate1066.errors);errors = vErrors.length;}var _valid3: any = _errs111 === errors;valid27 = valid27 || _valid3;const _errs112: any = errors;if(data22 !== null){const err94: any = {instancePath:instancePath+"/cloneFolder",schemaPath:"#/oneOf/17/properties/cloneFolder/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err94];}else {vErrors.push(err94);}errors++;}var _valid3: any = _errs112 === errors;valid27 = valid27 || _valid3;if(!valid27){const err95: any = {instancePath:instancePath+"/cloneFolder",schemaPath:"#/oneOf/17/properties/cloneFolder/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err95];}else {vErrors.push(err95);}errors++;}else {errors = _errs110;if(vErrors !== null){if(_errs110){vErrors.length = _errs110;}else {vErrors = null;}}}}}}}else {const err96: any = {instancePath,schemaPath:"#/oneOf/17/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err96];}else {vErrors.push(err96);}errors++;}}var _valid0: any = _errs106 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 17];}else {if(_valid0){valid0 = true;passing0 = 17;if(props0 !== true){props0 = true;}}const _errs114: any = errors;if(errors === _errs114){if(data && typeof data == "object" && !Array.isArray(data)){let missing20: any;if((data.voice === undefined) && (missing20 = "voice")){const err97: any = {instancePath,schemaPath:"#/oneOf/18/required",keyword:"required",params:{missingProperty: missing20}};if(vErrors === null){vErrors = [err97];}else {vErrors.push(err97);}errors++;}else {const _errs116: any = errors;for(const key20 in data){if(!(key20 === "voice")){const err98: any = {instancePath,schemaPath:"#/oneOf/18/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key20}};if(vErrors === null){vErrors = [err98];}else {vErrors.push(err98);}errors++;break;}}if(_errs116 === errors){if(data.voice !== undefined){if(!(validate1069.call(this, data.voice, {instancePath:instancePath+"/voice",parentData:data,parentDataProperty:"voice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1069.errors : vErrors.concat(validate1069.errors);errors = vErrors.length;}}}}}else {const err99: any = {instancePath,schemaPath:"#/oneOf/18/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err99];}else {vErrors.push(err99);}errors++;}}var _valid0: any = _errs114 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 18];}else {if(_valid0){valid0 = true;passing0 = 18;if(props0 !== true){props0 = true;}}}}}}}}}}}}}}}}}}}}if(!valid0){const err100: any = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0}};if(vErrors === null){vErrors = [err100];}else {vErrors.push(err100);}errors++;validate1071.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1071.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1071.errors = null as any[] | null;
// prettier-ignore
validate1071.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema2010: any = {"description":"Why a settings file was found broken.","type":"string","enum":["unparsable","schemaRefused"]};
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1079(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1079.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.repairedAt === undefined) && (missing0 = "repairedAt")) || ((data.cause === undefined) && (missing0 = "cause"))){validate1079.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "repairedAt") || (key0 === "cause"))){validate1079.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.repairedAt !== undefined){let data0: any = data.repairedAt;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern5.test(data0)){validate1079.errors = [{instancePath:instancePath+"/repairedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1079.errors = [{instancePath:instancePath+"/repairedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data1: any = data.cause;const _errs5: any = errors;if(typeof data1 !== "string"){validate1079.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/SettingsFileRepairCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "unparsable") || (data1 === "schemaRefused"))){validate1079.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/SettingsFileRepairCause/enum",keyword:"enum",params:{allowedValues: schema2010.enum}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate1079.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1079.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1079.errors = null as any[] | null;
// prettier-ignore
validate1079.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1077(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineSettingsReading {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1077.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.settings === undefined) && (missing0 = "settings")){validate1077.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "settings") || (key0 === "repair"))){validate1077.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.settings !== undefined){const _errs2: any = errors;if(!(validate1043.call(this, data.settings, {instancePath:instancePath+"/settings",parentData:data,parentDataProperty:"settings",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1043.errors : vErrors.concat(validate1043.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repair !== undefined){const _errs3: any = errors;if(!(validate1079.call(this, data.repair, {instancePath:instancePath+"/repair",parentData:data,parentDataProperty:"repair",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1079.errors : vErrors.concat(validate1079.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1077.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1077.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1077.errors = null as any[] | null;
// prettier-ignore
validate1077.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1081(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineSettingsUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1081.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.change === undefined) && (missing0 = "change")){validate1081.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "change")){validate1081.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.change !== undefined){if(!(validate1071.call(this, data.change, {instancePath:instancePath+"/change",parentData:data,parentDataProperty:"change",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1071.errors : vErrors.concat(validate1071.errors);errors = vErrors.length;}}}}}else {validate1081.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1081.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1081.errors = null as any[] | null;
// prettier-ignore
validate1081.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1083(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineSettingsUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1083.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.settings === undefined) && (missing0 = "settings")){validate1083.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "settings")){validate1083.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.settings !== undefined){if(!(validate1043.call(this, data.settings, {instancePath:instancePath+"/settings",parentData:data,parentDataProperty:"settings",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1043.errors : vErrors.concat(validate1043.errors);errors = vErrors.length;}}}}}else {validate1083.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1083.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1083.errors = null as any[] | null;
// prettier-ignore
validate1083.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1085(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is NotificationKindSwitches {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1085.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.waitingOnYou === undefined) && (missing0 = "waitingOnYou")) || ((data.finished === undefined) && (missing0 = "finished"))) || ((data.failed === undefined) && (missing0 = "failed"))) || ((data.notifyStep === undefined) && (missing0 = "notifyStep"))){validate1085.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "waitingOnYou") || (key0 === "finished")) || (key0 === "failed")) || (key0 === "notifyStep"))){validate1085.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.waitingOnYou !== undefined){const _errs2: any = errors;if(typeof data.waitingOnYou !== "boolean"){validate1085.errors = [{instancePath:instancePath+"/waitingOnYou",schemaPath:"#/properties/waitingOnYou/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.finished !== undefined){const _errs4: any = errors;if(typeof data.finished !== "boolean"){validate1085.errors = [{instancePath:instancePath+"/finished",schemaPath:"#/properties/finished/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.failed !== undefined){const _errs6: any = errors;if(typeof data.failed !== "boolean"){validate1085.errors = [{instancePath:instancePath+"/failed",schemaPath:"#/properties/failed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.notifyStep !== undefined){const _errs8: any = errors;if(typeof data.notifyStep !== "boolean"){validate1085.errors = [{instancePath:instancePath+"/notifyStep",schemaPath:"#/properties/notifyStep/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validate1085.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1085.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1085.errors = null as any[] | null;
// prettier-ignore
validate1085.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BranchNamePattern}. */
export const validateBranchNamePattern: SchemaCheck<BranchNamePattern> = validate1041;
/** Checks that a value is a {@link EnvironmentRow}. */
export const validateEnvironmentRow: SchemaCheck<EnvironmentRow> = validate1042;
/** Checks that a value is a {@link MachineSettings}. */
export const validateMachineSettings: SchemaCheck<MachineSettings> = validate1043;
/** Checks that a value is a {@link MachineSettingsChange}. */
export const validateMachineSettingsChange: SchemaCheck<MachineSettingsChange> = validate1071;
/** Checks that a value is a {@link MachineSettingsReading}. */
export const validateMachineSettingsReading: SchemaCheck<MachineSettingsReading> = validate1077;
/** Checks that a value is a {@link MachineSettingsUpdateRequest}. */
export const validateMachineSettingsUpdateRequest: SchemaCheck<MachineSettingsUpdateRequest> =
  validate1081;
/** Checks that a value is a {@link MachineSettingsUpdateResponse}. */
export const validateMachineSettingsUpdateResponse: SchemaCheck<MachineSettingsUpdateResponse> =
  validate1083;
/** Checks that a value is a {@link NotificationKindSwitches}. */
export const validateNotificationKindSwitches: SchemaCheck<NotificationKindSwitches> = validate1085;

/** The methods of {@link MACHINE_SETTINGS_METHOD_DESCRIPTORS}, each with its checks. */
export interface MachineSettingsMethodDescriptors {
  readonly "machine.settings.read": {
    readonly method: "machine.settings.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<MachineSettingsReading>;
  };
  readonly "machine.settings.update": {
    readonly method: "machine.settings.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<MachineSettingsUpdateRequest>;
    readonly responseCheck: SchemaCheck<MachineSettingsUpdateResponse>;
  };
  readonly "machine.settings.subscribe": {
    readonly method: "machine.settings.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<MachineSettingsReading>;
  };
}
/** The descriptor table of the three machine-settings methods. */
export const MACHINE_SETTINGS_METHOD_DESCRIPTORS: MachineSettingsMethodDescriptors = Object.freeze({
  "machine.settings.read": Object.freeze({
    method: "machine.settings.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateMachineSettingsReading,
  }),
  "machine.settings.update": Object.freeze({
    method: "machine.settings.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMachineSettingsUpdateRequest,
    responseCheck: validateMachineSettingsUpdateResponse,
  }),
  "machine.settings.subscribe": Object.freeze({
    method: "machine.settings.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateMachineSettingsReading,
  }),
});
