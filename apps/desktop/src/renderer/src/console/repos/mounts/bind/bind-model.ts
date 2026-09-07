// What a bind form holds, what makes it sendable, and which modes it may offer.
//
// PURE, AND SEPARATE FROM THE ACT FOR THAT REASON. Everything here is a function of what
// a participant typed and what the mount-scoped capabilities read answered; nothing
// reaches a bridge or holds a lifetime.
//
// THE CONSOLE OFFERS WHAT THE MOUNT ADMITS AND WITHHOLDS NOTHING SILENTLY. The read
// carries `availableModes` and a sparse `restrictions` map, and `Spec-009 §Fallback
// Behavior` requires the capability gap stated rather than substituted — so an excluded
// mode is rendered, disabled, and never dropped from the list, carrying the mount's own
// reason beside it WHEN THE REPLY SENT ONE. The map is sparse, so a mode can be
// excluded with no reason on file, and `BindModePicker` then draws the row and no
// sentence rather than composing one the daemon did not send — which is what
// `ModeRowView` does with the same rows. A form that showed one row on a plain
// directory would leave a person wondering where the other three went.
//
// ONE `directory` FIELD AND NO SELECTOR BESIDE IT. The wire carries both forms the trust
// envelope admits — a subtree relative to the mount's canonical root, and an absolute
// path naming a registered working tree — over one optional member, so a control saying
// which kind it is would be the console splitting a field the contract keeps whole.
// Empty means the mount root, which is the default-workspace case.

import {
  REPO_PATH_MAX_LEN,
  type ExecutionMode,
  type WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";

import { resolveServedSelection, selectedChoiceOf, type ServedSelection } from "../form/index.js";

/** What the bind dialog holds while it is open. */
export interface BindFormState {
  /** Exactly what was typed, or empty for the mount root. Never normalised here. */
  readonly directory: string;
  /**
   * The mode a participant PICKED, or none picked yet.
   *
   * NEVER THE DAEMON'S DEFAULT. That default is derived per read by
   * {@link resolveBindForm} from the capabilities on screen, so a reopened dialog gets
   * it again and a refresh that withdraws it takes it away — neither of which a value
   * written in here could do, because form state has no idea which read it came from.
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
   * The mode the picker draws as checked, which is the mode the verdict would send.
   *
   * ONE READING SERVING BOTH. The picker drew from the capabilities read and the verdict
   * read the form alone, so a refresh that withdrew the held mode drew the row excluded
   * and left the button beside it open over exactly that mode.
   */
  readonly selectedMode: ExecutionMode | undefined;
  readonly verdict: BindFormVerdict;
}

/**
 * Read one bind form against the capabilities that are currently served.
 *
 * THE DAEMON'S DEFAULT IS DERIVED HERE RATHER THAN WRITTEN INTO THE FORM, which is what
 * makes it survive a close: a pre-fill applied once per mount needs a memory of having
 * been applied, and that memory outlived the form it was about — so a dialog reopened on
 * the same mount met a picker with nothing chosen and a control that would not send.
 *
 * IT IS STILL NOT A GUESS OF THE CONSOLE'S, which is the rule `repo.workspaceBind`'s own
 * refusal to conflate "omitted a mode" with "chose `read-only`" is about. The value
 * comes from `defaultMode` on the mount's own reply, and a reply that names one outside
 * its own `availableModes` resolves to nothing at all.
 *
 * `undefined` where the read has not answered, which is a different fact from a mount
 * that admits nothing: the first cannot confirm a pick, the second withdraws one.
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

/**
 * The verdict itself, once the mode question has an answer.
 *
 * AN EMPTY DIRECTORY IS OMITTED RATHER THAN SENT, because the wire's absent member means
 * the mount root and an empty string does not — it is a path, and a path of no
 * characters is a request the parser refuses.
 *
 * WHAT IS TYPED IS WHAT IS SENT. The emptiness test reads a trimmed copy; a leading or
 * trailing space is a legal POSIX filename character, so trimming on the way out would
 * bind a different directory from the one that was named.
 *
 * EACH CLOSED ARM NAMES ITS OWN FACT. A withdrawn mode and a read that has not answered
 * shut the control for different reasons, and one sentence covering both would be false
 * about whichever it was not written for.
 */
function bindVerdictFor(
  form: BindFormState,
  selection: ServedSelection<ExecutionMode>,
): BindFormVerdict {
  if (form.directory.length > REPO_PATH_MAX_LEN) {
    return {
      status: "incomplete",
      because: `That directory is ${String(form.directory.length)} characters. The wire accepts ${String(REPO_PATH_MAX_LEN)}.`,
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

/** The mode to pre-fill: the daemon's own default, and never a guess of the console's. */
export function defaultBindMode(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): ExecutionMode | undefined {
  return capabilities.availableModes.includes(capabilities.defaultMode)
    ? capabilities.defaultMode
    : undefined;
}
