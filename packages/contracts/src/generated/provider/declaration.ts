// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a provider's driver declares for the screens to draw by kind: its own Settings rows and the options a session of it takes.

import type { Place } from "../place.js";

/** The longest label, line or reason a declaration carries. */
export const PROVIDER_DECLARATION_TEXT_MAX_LEN = 512 as const;

/** The longest value a choice or a text setting holds. */
export const PROVIDER_VALUE_MAX_LEN = 4096 as const;

/** The most options one choice lists. */
export const PROVIDER_CHOICE_OPTIONS_MAX = 256 as const;

/**
 * The id a driver gives one of its rows or options, unique within its provider: a lowercase
 * letter, then up to 63 letters or digits (`outputStyle`). Opaque to every client.
 */
export type ProviderDeclarationId = string & { readonly __brand: "ProviderDeclarationId" };
/**
 * Where an action stands in one place beyond whether it is done: settled, running, or failed with
 * the provider's reason, the switch back where it was.
 */
export type ProviderActionProgress =
  | {
      state: "settled";
    }
  | {
      state: "running";
      /**
       * Whether it is doing the action, not undoing it.
       */
      isDoing: boolean;
      /**
       * Whether the driver can stop it.
       */
      canStop: boolean;
    }
  | {
      state: "failed";
      /**
       * Whether it was doing the action, not undoing it.
       */
      isDoing: boolean;
      /**
       * The provider's own reason.
       */
      reason: string;
    };
/**
 * What a setting row holds, by kind, with its live value: the app's own value once it is changed
 * in the app, else the one the provider's own settings resolve.
 */
export type ProviderSettingControl =
  | {
      control: "switch";
      /**
       * Each place's entry.
       *
       * @minItems 1
       */
      places: [ProviderPlaceSwitch, ...ProviderPlaceSwitch[]];
    }
  | {
      control: "choice";
      /**
       * The option it is on, or `null` for none, which only a choice with `noneLabel` takes.
       */
      value: string | null;
      /**
       * The words of the pick that sets none, where the choice offers one.
       */
      noneLabel?: string;
      /**
       * The options.
       *
       * @minItems 1
       * @maxItems 256
       */
      options: [ProviderChoiceOption, ...ProviderChoiceOption[]];
    }
  | {
      control: "text";
      /**
       * The text, or `null` while none is set.
       */
      value: string | null;
      /**
       * The longest text it takes, in code points.
       */
      maxLength: number;
    };
/**
 * One row a provider's driver declares on its Settings section, drawn by its kind.
 */
export type ProviderRow =
  | {
      kind: "setting";
      /**
       * The row's id.
       */
      id: ProviderDeclarationId;
      /**
       * The row's label.
       */
      label: string;
      /**
       * The line under it, where it has one.
       */
      line?: string;
      /**
       * What it holds.
       */
      control: ProviderSettingControl;
    }
  | {
      kind: "status";
      /**
       * The row's id.
       */
      id: ProviderDeclarationId;
      /**
       * The row's label.
       */
      label: string;
      /**
       * The line under it, where it has one.
       */
      line?: string;
      /**
       * The fact, in the provider's words.
       */
      text: string;
    }
  | {
      kind: "action";
      /**
       * The row's id.
       */
      id: ProviderDeclarationId;
      /**
       * The row's label.
       */
      label: string;
      /**
       * The line under it, where it has one.
       */
      line?: string;
      /**
       * The words its runs and failures read in.
       */
      words: ProviderActionWords;
      /**
       * Each place's state.
       *
       * @minItems 1
       */
      places: [ProviderActionPlace, ...ProviderActionPlace[]];
    };
/**
 * A value sent for one declared setting or session option: on or off, or a text.
 */
export type ProviderValue = boolean | string;
/**
 * Where a session option is drawn in the session's composer.
 */
export type ProviderSessionOptionPlacement = "effortMenu";
/**
 * What a session option holds, by kind; each agent's value travels on its binding.
 */
export type ProviderSessionOptionControl =
  | {
      control: "switch";
    }
  | {
      control: "choice";
      /**
       * The options.
       *
       * @minItems 1
       * @maxItems 256
       */
      options: [ProviderChoiceOption, ...ProviderChoiceOption[]];
    };

/**
 * One place's on-or-off for a per-place switch. A computer without a WSL 2 distribution has one
 * entry and names no place.
 */
export interface ProviderPlaceSwitch {
  /**
   * The place; absent on a computer without a WSL 2 distribution.
   */
  place?: Place;
  /**
   * Whether the switch is on there.
   */
  enabled: boolean;
}
/**
 * The words an action row reads in while it runs and when it fails, each failure followed by the
 * provider's own reason.
 */
export interface ProviderActionWords {
  /**
   * While it is being done.
   */
  doing: string;
  /**
   * While it is being undone.
   */
  undoing: string;
  /**
   * When doing it failed.
   */
  doFailed: string;
  /**
   * When undoing it failed.
   */
  undoFailed: string;
}
/**
 * One place's state of an action row. A computer without a WSL 2 distribution has one entry and
 * names no place.
 */
export interface ProviderActionPlace {
  /**
   * The place; absent on a computer without a WSL 2 distribution.
   */
  place?: Place;
  /**
   * Whether the action is done there.
   */
  isDone: boolean;
  /**
   * Its run there, if any.
   */
  progress: ProviderActionProgress;
}
/**
 * One option of a choice: its value, the words it reads in, and the provider's reason where it
 * cannot be picked, which draws it dimmed.
 */
export interface ProviderChoiceOption {
  /**
   * The value a pick sends.
   */
  value: string;
  /**
   * The option's words.
   */
  label: string;
  /**
   * The line describing it, where it has one.
   */
  line?: string;
  /**
   * Why it cannot be picked, in the provider's words; absent while it can.
   */
  unavailableReason?: string;
}
/**
 * One option a provider's driver declares on its sessions, drawn by its kind where its placement
 * says, and shown on a session only where the provider reports it available there.
 */
export interface ProviderSessionOption {
  /**
   * The option's id.
   */
  id: ProviderDeclarationId;
  /**
   * The option's label.
   */
  label: string;
  /**
   * Where it is drawn.
   */
  placement: ProviderSessionOptionPlacement;
  /**
   * What it holds.
   */
  control: ProviderSessionOptionControl;
}
/**
 * One session option's value as it is set on an agent's binding.
 */
export interface ProviderOptionSetting {
  /**
   * The option.
   */
  id: ProviderDeclarationId;
  /**
   * Its value.
   */
  value: ProviderValue;
}
/**
 * One session option as the provider reports it on a live binding, read after each start and
 * each change: its value in effect, and whether this session can run it.
 */
export interface ObservedProviderOption {
  /**
   * The option.
   */
  id: ProviderDeclarationId;
  /**
   * The value in effect.
   */
  value: ProviderValue;
  /**
   * Whether this session can run it; an option it cannot run is not drawn.
   */
  isAvailable: boolean;
}

export {
  validateObservedProviderOption,
  validateProviderDeclarationId,
  validateProviderOptionSetting,
  validateProviderPlaceSwitch,
  validateProviderValue,
} from "../checks/provider/declaration.js";
