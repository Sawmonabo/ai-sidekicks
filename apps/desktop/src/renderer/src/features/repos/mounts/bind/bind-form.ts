// The bind form: what it holds, what makes it sendable, and which modes it may offer.
// An excluded mode is shown disabled, with the mount's reason if the reply sent one, and is
// never dropped from the list. One `directory` field covers both wire forms (a subtree of the
// mount root or an absolute working-tree path); empty means the mount root.

import {
  FILE_PATH_MAX_LEN,
  type ExecutionMode,
  type WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";

import {
  resolveServedSelection,
  selectedChoiceOf,
  type ServedSelection,
} from "../served-selection.js";

/** What the bind dialog holds while it is open. */
export interface BindFormState {
  /** Exactly what was typed, or empty for the mount root. Never normalized here. */
  readonly directory: string;
  /**
   * The mode a user picked, or none yet. Never the daemon's default: {@link resolveBindForm}
   * derives that per read, so a reopened dialog gets it again and a refresh can withdraw it.
   */
  readonly executionMode: ExecutionMode | undefined;
}

/** An empty bind form: the mount root, and no mode chosen. */
export const EMPTY_BIND_FORM: BindFormState = { directory: "", executionMode: undefined };

/** Whether this form is a request, and if not, what is missing. */
export type BindFormVerdict =
  | {
      readonly status: "sendable";
      readonly executionMode: ExecutionMode;
      readonly directory: string | undefined;
    }
  | { readonly status: "incomplete"; readonly because: string };

/** One form read against what the mount admits: the mode it is on, and its verdict. */
export interface BindFormResolution {
  /**
   * The mode the picker draws as checked, which is the mode the verdict would send. One
   * reading serves both, so a refresh that withdraws the held mode cannot leave the button open.
   */
  readonly selectedMode: ExecutionMode | undefined;
  readonly verdict: BindFormVerdict;
}

/**
 * Read one bind form against the capabilities currently served. The daemon's default is
 * derived here, not written into the form, so a reopened dialog gets it again. It comes from
 * the reply's `defaultMode` and resolves to nothing when that is outside `availableModes`.
 * An unanswered read cannot confirm a pick; a mount that admits nothing withdraws one.
 */
export function resolveBindForm(
  form: BindFormState,
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined,
): BindFormResolution {
  const selection = resolveServedSelection<ExecutionMode>({
    chosen: form.executionMode,
    servedChoices: capabilities?.availableModes,
    defaultChoice: capabilities === undefined ? undefined : defaultBindMode(capabilities),
  });
  return {
    selectedMode: selectedChoiceOf(selection),
    verdict: bindVerdictFor(form, selection),
  };
}

/** The mode to pre-fill: the daemon's own default, and never a guess of the console's. */
export function defaultBindMode(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): ExecutionMode | undefined {
  return capabilities.availableModes.includes(capabilities.defaultMode)
    ? capabilities.defaultMode
    : undefined;
}

/**
 * The verdict, once the mode question has an answer. An empty directory is omitted rather than
 * sent: an absent wire member means the mount root, an empty string is refused. What is typed is
 * what is sent; only the emptiness test trims, because edge spaces are legal in POSIX names.
 */
function bindVerdictFor(
  form: BindFormState,
  selection: ServedSelection<ExecutionMode>,
): BindFormVerdict {
  if (form.directory.length > FILE_PATH_MAX_LEN) {
    return {
      status: "incomplete",
      because: `That directory is ${String(form.directory.length)} characters. The wire accepts ${String(FILE_PATH_MAX_LEN)}.`,
    };
  }
  switch (selection.status) {
    case "resolved":
      return {
        status: "sendable",
        executionMode: selection.choice,
        directory: form.directory.trim().length === 0 ? undefined : form.directory,
      };
    case "withdrawn":
      return {
        status: "incomplete",
        because: "That mode is no longer one this mount admits. Choose one of the modes listed.",
      };
    case "unserved":
      return {
        status: "incomplete",
        because: "What this mount admits has not answered, so the mode chosen cannot be confirmed.",
      };
    case "unresolved":
      return {
        status: "incomplete",
        because: "Choose the execution mode this workspace binds in.",
      };
  }
}
