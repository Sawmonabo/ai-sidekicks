// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The provider settings methods: each provider's section on this machine, its driver's fixed facts, shared rows and declared rows, apart from its accounts, installs and imports.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import {
  validateProviderListResponse,
  validateProviderPlaceRequest,
  validateProviderProtectedPathListResponse,
  validateProviderRequest,
  validateProviderSettingsResponse,
  validateProviderStandingRuleListResponse,
  validateProviderStandingRuleRevokeRequest,
  validateProviderStandingRuleRevokeResponse,
  validateProviderTerminalPluginUpdateRequest,
  validateProviderUpdateRequest,
} from "../checks/provider/settings.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { ProviderMcpDeclaration } from "../mcp/server.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { Place, WslPlace } from "../place.js";
import type { RepoMountId } from "../repo/mount.js";
import type { VoiceKind } from "../voice.js";
import type { ProviderAccountId } from "./account/record.js";
import type {
  ProviderDeclarationId,
  ProviderRow,
  ProviderSessionOption,
  ProviderValue,
} from "./declaration.js";
import type { ProviderId } from "./id.js";

/**
 * The longest provider command version, as the command prints it, in code points; the
 * provider crate stores and checks a printed version within the same bound.
 */
export const PROVIDER_VERSION_MAX_LEN = 128 as const;

/** The longest protected-path pattern or standing rule text. */
export const PROVIDER_RULE_TEXT_MAX_LEN = 4096 as const;

/** The longest standing rule decision word. */
export const PROVIDER_RULE_DECISION_MAX_LEN = 64 as const;

/** The longest standing rule id. */
export const PROVIDER_STANDING_RULE_ID_MAX_LEN = 256 as const;

/**
 * The provider's command is not installed, so a setting that needs it cannot be turned on:
 * availability for new sessions, a declared row that runs the command, and the terminal
 * plugin.
 */
export const PROVIDER_NOT_INSTALLED_CODE = "provider.notInstalled" as const;

/** Nothing runnable sits at the command path the person typed. */
export const PROVIDER_COMMAND_PATH_NOT_RUNNABLE_CODE = "provider.commandPath.notRunnable" as const;

/**
 * What the provider check found where the command resolves. `indeterminate` is a check that
 * could not settle and is never folded into another arm; `noBuildForSystem` and
 * `distributionNeedsWsl2` are rows no check runs on and no install offers.
 */
export type ProviderInstallation =
  | {
      state: "installed";
      /**
       * The version as the command printed it.
       */
      rawVersion: string;
      /**
       * The version, where it parses; every version runs.
       */
      parsedVersion?: string;
      /**
       * The newer build the provider's latest-version marker names, drawn as `Update
       * available`; absent while the command resolves to the latest build.
       */
      latestVersion?: string;
    }
  | {
      state: "notInstalled";
    }
  | {
      state: "indeterminate";
    }
  | {
      state: "noBuildForSystem";
    }
  | {
      state: "distributionNeedsWsl2";
    };
/**
 * One setting changed, one member per press: a row every provider offers, one the provider's
 * driver declares, whose value the daemon holds to the row's declaration
 * ([`ProviderRow::check_value`]), or the run or stop of a declared action row. A new command path
 * is checked again where it now points and the provider's model catalog is read again.
 */
export type ProviderUpdateRequest =
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The place: absent on a computer without a WSL 2 distribution and present on one with.
       * On Windows, `"windows"` names Windows and a distribution is refused by its name,
       * whether or not a WSL 2 distribution remains; a place on macOS or Linux is refused with
       * `provider.place.notOffered`, and none where a WSL 2 distribution is with
       * `provider.place.required`.
       */
      place?: Place;
      /**
       * The path, or `null` for auto-detect.
       */
      commandPath: string | null;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * Whether it may.
       */
      availableForNewSessions: boolean;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The limit, or `null` for none.
       */
      helpersAtOnce: number | null;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The threshold.
       */
      autoCompactPercent: number;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The row.
       */
      rowId: ProviderDeclarationId;
      /**
       * The place of a per-place switch row: absent on a computer without a WSL 2 distribution
       * and present on one with. On Windows, `"windows"` names Windows and a distribution is
       * refused by its name, whether or not a WSL 2 distribution remains; a place on macOS or
       * Linux is refused with `provider.place.notOffered`, and none where a WSL 2 distribution
       * is with `provider.place.required`.
       */
      place?: Place;
      /**
       * The value, or `null` for none where the row takes none.
       */
      value: ProviderValue | null;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The action row.
       */
      rowId: ProviderDeclarationId;
      /**
       * The place, as on a per-place switch row.
       */
      place?: Place;
      /**
       * Whether the action is to be done there, not undone.
       */
      enabled: boolean;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The action row.
       */
      rowId: ProviderDeclarationId;
      /**
       * The place, as on a per-place switch row.
       */
      place?: Place;
      /**
       * Always `true`: the member that marks a stop.
       */
      stop: true;
    };
/**
 * One path an agent is refused on this provider, and where it came from: the credential files
 * the app always protects, or a deny rule the person set in the provider's own configuration.
 * Read-only.
 */
export type ProviderProtectedPath =
  | {
      source: "builtIn";
      /**
       * The path pattern.
       */
      pattern: string;
    }
  | {
      source: "global";
      /**
       * The path pattern.
       */
      pattern: string;
      /**
       * Where the rule's file is, the file's path in that place's form; absent on a computer
       * without a WSL 2 distribution.
       */
      place?: Place;
      /**
       * The file the rule sits in.
       */
      sourcePath: string;
    }
  | {
      source: "project";
      /**
       * The path pattern.
       */
      pattern: string;
      /**
       * The file the rule sits in.
       */
      sourcePath: string;
      /**
       * The project.
       */
      repoMountId: RepoMountId;
    };
/**
 * The daemon-minted id of one standing rule, a digest of the rule's place, its file, its
 * scope, the provider's decision word and its text, so the same text in two places, files,
 * scopes or decisions names two rules and a file read again gives the same ids.
 */
export type ProviderStandingRuleId = string & { readonly __brand: "ProviderStandingRuleId" };
/**
 * Where a standing rule holds: one account's home, or one attached project.
 */
export type ProviderStandingRuleScope =
  | {
      kind: "accountHome";
      /**
       * The account.
       */
      accountId: ProviderAccountId;
    }
  | {
      kind: "project";
      /**
       * The project.
       */
      repoMountId: RepoMountId;
    };

/**
 * One place's `Command` row: where the provider's command is read, what the last check there
 * found and when, and the path the person typed for that place. A computer without a WSL 2
 * distribution has one row and names no place. With one, the rows run Windows first, then each
 * distribution in WSL's list order with WSL's default first, a WSL 1 distribution among them;
 * distributions other tools keep for themselves (`docker-desktop*`, `rancher-desktop*`) are never
 * listed.
 */
export interface ProviderPlaceReading {
  /**
   * The place; absent on a computer without a WSL 2 distribution.
   */
  place?: Place;
  /**
   * What the last check there found, `null` until the place has been checked.
   */
  installation: ProviderInstallation | null;
  /**
   * The path the person typed for the place, or `null` for auto-detect.
   */
  commandPath: string | null;
  /**
   * When the place was last checked, `null` until it has been.
   */
  checkedAt: WireInstant | null;
}
/**
 * The compaction threshold, in percent full, between the lowest bottom stop and the highest top
 * stop that provider's models report.
 */
export interface ProviderAutoCompactBound {
  /**
   * The threshold; it sits between `lowest` and `highest`.
   */
  value: number;
  /**
   * The lowest bottom stop.
   */
  lowest: number;
  /**
   * The highest top stop.
   */
  highest: number;
}
/**
 * One plan id the provider sends and the word a person reads it as. A plan id the provider lists
 * no word for reads as its own words in sentence case.
 */
export interface ProviderPlanWord {
  /**
   * The plan id as the provider sends it.
   */
  plan: string;
  /**
   * The word a person reads.
   */
  word: string;
}
/**
 * One tool the provider has built in, which the tool allowlist picker offers.
 */
export interface ProviderBuiltInTool {
  /**
   * The tool's name in the provider's own spelling, as an allowlist names it.
   */
  name: string;
  /**
   * The words the picker draws it in.
   */
  label: string;
}
/**
 * One provider's section as `provider.list` reads it, one per registered driver: the fixed facts
 * its driver declares, the rows every provider offers, and the rows and session options its driver
 * declares with their live values. `helpersAtOnce` is `null` for no limit and `0` for none; the
 * compaction bound is `null` until the provider has been read.
 */
export interface ProviderSection {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The provider's name as a person reads it.
   */
  name: string;
  /**
   * The words its plan ids read as, unique by plan id; may be empty.
   */
  planWords: ProviderPlanWord[];
  /**
   * Its built-in tools in its own order, unique by name; may be empty.
   */
  builtInTools: ProviderBuiltInTool[];
  /**
   * The environment names the app sets on this provider's processes and its Terminal pane's
   * shells, which a person's own environment row may not take; unique, may be empty.
   */
  appSetEnvironmentNames: string[];
  /**
   * The transports and declaration members its tool servers take.
   */
  mcp: ProviderMcpDeclaration;
  /**
   * The most characters it takes in a skill's name, or `null` where it sets no limit of its
   * own below the shared one.
   */
  skillNameMaxLength: number | null;
  /**
   * The voice kinds it offers, each at most once: the composer starts `voice.dictation.start`
   * for dictation and `voice.call.start` for a call; empty where it offers none.
   */
  voiceKinds: VoiceKind[];
  /**
   * The output-speed levels every one of its models offers, present only where the provider
   * publishes none per model.
   */
  outputSpeedLevels?: string[];
  /**
   * The command's reading in each place.
   *
   * @minItems 1
   */
  places: [ProviderPlaceReading, ...ProviderPlaceReading[]];
  /**
   * Whether a new session may use the provider.
   */
  availableForNewSessions: boolean;
  /**
   * How many helpers run at once: `null` for no limit, `0` for none.
   */
  helpersAtOnce: number | null;
  /**
   * The compaction threshold, `null` until the provider has been read.
   */
  autoCompactPercent: ProviderAutoCompactBound | null;
  /**
   * The rows its driver declares with their live values, in the driver's order; may be empty.
   */
  rows: ProviderRow[];
  /**
   * The options its driver declares on its sessions; may be empty.
   */
  sessionOptions: ProviderSessionOption[];
}
/**
 * The reply every `provider.*` change settles with, and each `provider.subscribe` delivery: one
 * provider's whole section as it now stands.
 */
export interface ProviderSettingsResponse {
  /**
   * The section.
   */
  settings: ProviderSection;
  /**
   * The WSL 2 distributions that are stopped, whose rows show their last reading; a check
   * there starts the distribution. Absent while none is stopped.
   *
   * @minItems 1
   */
  stoppedDistributions?: [WslPlace, ...WslPlace[]];
}
/**
 * A request naming one provider.
 */
export interface ProviderRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
}
/**
 * A request naming one provider in one place: a check, an install or an update of its command
 * there.
 */
export interface ProviderPlaceRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The place: absent on a computer without a WSL 2 distribution and present on one with. On
   * Windows, `"windows"` names Windows and a distribution is refused by its name, whether or not
   * a WSL 2 distribution remains; a place on macOS or Linux is refused with
   * `provider.place.notOffered`, and none where a WSL 2 distribution is with
   * `provider.place.required`.
   */
  place?: Place;
}
/**
 * Each provider's section, in the order the daemon's provider table lists them.
 */
export interface ProviderListResponse {
  /**
   * The sections.
   */
  providers: ProviderSection[];
  /**
   * The WSL 2 distributions that are stopped, whose rows show their last reading; a check
   * there starts the distribution. Absent while none is stopped.
   *
   * @minItems 1
   */
  stoppedDistributions?: [WslPlace, ...WslPlace[]];
}
/**
 * Put the app's terminal plugin into the person's own provider install in one place, or take it
 * out, through the provider's own commands; off removes exactly what on added and nothing the
 * person added. A provider whose driver offers no terminal plugin is refused with
 * `provider.capability.unsupported`.
 */
export interface ProviderTerminalPluginUpdateRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The place: absent on a computer without a WSL 2 distribution and present on one with. On
   * Windows, `"windows"` names Windows and a distribution is refused by its name, whether or not
   * a WSL 2 distribution remains; a place on macOS or Linux is refused with
   * `provider.place.notOffered`, and none where a WSL 2 distribution is with
   * `provider.place.required`.
   */
  place?: Place;
  /**
   * Whether the plugin is in.
   */
  enabled: boolean;
}
/**
 * The paths one provider refuses.
 */
export interface ProviderProtectedPathListResponse {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * Its protected paths.
   */
  entries: ProviderProtectedPath[];
}
/**
 * One standing rule in the provider's own words: `decision` is the provider's word for what the
 * rule does, and `text` the rule as its file holds it.
 */
export interface ProviderStandingRule {
  /**
   * The rule's id.
   */
  ruleId: ProviderStandingRuleId;
  /**
   * Where the rule holds; absent for a rule of the provider's own system settings, which holds
   * for every account and project on the machine and which the daemon never revokes.
   */
  scope?: ProviderStandingRuleScope;
  /**
   * Where the rule's file is, the file's path in that place's form; absent on a computer
   * without a WSL 2 distribution.
   */
  place?: Place;
  /**
   * The file the rule sits in.
   */
  sourcePath: string;
  /**
   * The provider's word for what the rule does.
   */
  decision: string;
  /**
   * The rule as its file holds it.
   */
  text: string;
}
/**
 * One provider's standing rules on this machine, from every account home in every place and
 * every attached project; an empty list means it holds none.
 */
export interface ProviderStandingRuleListResponse {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * Its rules.
   */
  rules: ProviderStandingRule[];
}
/**
 * Remove one standing rule where the provider keeps it; it applies from the next tool call.
 */
export interface ProviderStandingRuleRevokeRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The rule.
   */
  ruleId: ProviderStandingRuleId;
}
/**
 * The reply of a revoke.
 */
export interface ProviderStandingRuleRevokeResponse {
  /**
   * The rule.
   */
  ruleId: ProviderStandingRuleId;
  /**
   * How the revoke settled.
   */
  outcome: "revoked" | "alreadyAbsent";
}

export {
  validateProviderAutoCompactBound,
  validateProviderBuiltInTool,
  validateProviderInstallation,
  validateProviderListResponse,
  validateProviderPlaceReading,
  validateProviderPlaceRequest,
  validateProviderPlanWord,
  validateProviderProtectedPath,
  validateProviderProtectedPathListResponse,
  validateProviderRequest,
  validateProviderSection,
  validateProviderSettingsResponse,
  validateProviderStandingRule,
  validateProviderStandingRuleId,
  validateProviderStandingRuleListResponse,
  validateProviderStandingRuleRevokeRequest,
  validateProviderStandingRuleRevokeResponse,
  validateProviderStandingRuleScope,
  validateProviderTerminalPluginUpdateRequest,
  validateProviderUpdateRequest,
} from "../checks/provider/settings.js";

/** The methods of {@link PROVIDER_METHOD_DESCRIPTORS}, each with its checks. */
export interface ProviderMethodDescriptors {
  readonly "provider.list": {
    readonly method: "provider.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<ProviderListResponse>;
  };
  readonly "provider.subscribe": {
    readonly method: "provider.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProviderSettingsResponse>;
  };
  readonly "provider.update": {
    readonly method: "provider.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProviderSettingsResponse>;
  };
  readonly "provider.probe": {
    readonly method: "provider.probe";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderPlaceRequest>;
    readonly responseCheck: SchemaCheck<ProviderSettingsResponse>;
  };
  readonly "provider.terminalPlugin.update": {
    readonly method: "provider.terminalPlugin.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderTerminalPluginUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProviderSettingsResponse>;
  };
  readonly "provider.protectedPath.list": {
    readonly method: "provider.protectedPath.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderRequest>;
    readonly responseCheck: SchemaCheck<ProviderProtectedPathListResponse>;
  };
  readonly "provider.standingRule.list": {
    readonly method: "provider.standingRule.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderRequest>;
    readonly responseCheck: SchemaCheck<ProviderStandingRuleListResponse>;
  };
  readonly "provider.standingRule.revoke": {
    readonly method: "provider.standingRule.revoke";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderStandingRuleRevokeRequest>;
    readonly responseCheck: SchemaCheck<ProviderStandingRuleRevokeResponse>;
  };
}
/** Every provider settings method: its name, how it answers, and its shapes. */
export const PROVIDER_METHOD_DESCRIPTORS: ProviderMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "provider.list": /* @__PURE__ */ Object.freeze({
      method: "provider.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateProviderListResponse,
    }),
    "provider.subscribe": /* @__PURE__ */ Object.freeze({
      method: "provider.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateProviderSettingsResponse,
    }),
    "provider.update": /* @__PURE__ */ Object.freeze({
      method: "provider.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderUpdateRequest,
      responseCheck: validateProviderSettingsResponse,
    }),
    "provider.probe": /* @__PURE__ */ Object.freeze({
      method: "provider.probe",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderPlaceRequest,
      responseCheck: validateProviderSettingsResponse,
    }),
    "provider.terminalPlugin.update": /* @__PURE__ */ Object.freeze({
      method: "provider.terminalPlugin.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderTerminalPluginUpdateRequest,
      responseCheck: validateProviderSettingsResponse,
    }),
    "provider.protectedPath.list": /* @__PURE__ */ Object.freeze({
      method: "provider.protectedPath.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderRequest,
      responseCheck: validateProviderProtectedPathListResponse,
    }),
    "provider.standingRule.list": /* @__PURE__ */ Object.freeze({
      method: "provider.standingRule.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderRequest,
      responseCheck: validateProviderStandingRuleListResponse,
    }),
    "provider.standingRule.revoke": /* @__PURE__ */ Object.freeze({
      method: "provider.standingRule.revoke",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderStandingRuleRevokeRequest,
      responseCheck: validateProviderStandingRuleRevokeResponse,
    }),
  },
);
