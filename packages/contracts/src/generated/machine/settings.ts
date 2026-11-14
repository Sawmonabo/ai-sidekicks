// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The machine's settings file and the three service methods that read, write and stream it, with the environment-name rule the service checks a row's name against.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import {
  validateMachineSettingsReading,
  validateMachineSettingsUpdateRequest,
  validateMachineSettingsUpdateResponse,
} from "../checks/machine/settings.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import type { Port, WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
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
export const MACHINE_SETTINGS_DEFAULTS: Readonly<MachineSettings> = {
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
};

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

export {
  validateBackupSettings,
  validateBranchNamePattern,
  validateCommitTextModel,
  validateEmailAddress,
  validateEmailDigestPeriod,
  validateEmailDigestSettings,
  validateEnvironmentRow,
  validateLastLeadModel,
  validateMachineSettings,
  validateMachineSettingsChange,
  validateMachineSettingsReading,
  validateMachineSettingsUpdateRequest,
  validateMachineSettingsUpdateResponse,
  validateNotificationKindSwitches,
  validateNotificationSettings,
  validateProviderCommandPath,
  validateProviderKnobs,
  validateProviderRowValue,
  validateSettingsFileRepair,
  validateSettingsFileRepairCause,
  validateVoiceMode,
  validateVoiceSettings,
  validateWebAddressSettings,
} from "../checks/machine/settings.js";

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
export const MACHINE_SETTINGS_METHOD_DESCRIPTORS: MachineSettingsMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "machine.settings.read": /* @__PURE__ */ Object.freeze({
      method: "machine.settings.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateMachineSettingsReading,
    }),
    "machine.settings.update": /* @__PURE__ */ Object.freeze({
      method: "machine.settings.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateMachineSettingsUpdateRequest,
      responseCheck: validateMachineSettingsUpdateResponse,
    }),
    "machine.settings.subscribe": /* @__PURE__ */ Object.freeze({
      method: "machine.settings.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateMachineSettingsReading,
    }),
  });
