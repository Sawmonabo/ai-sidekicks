// What a bind form holds, what makes it sendable, and which modes it may offer.
//
// PURE, AND SEPARATE FROM THE ACT FOR THAT REASON. Everything here is a function of what
// a participant typed and what the mount-scoped capabilities read answered; nothing
// reaches a bridge or holds a lifetime.
//
// THE CONSOLE OFFERS WHAT THE MOUNT ADMITS AND WITHHOLDS NOTHING SILENTLY. The read
// carries `availableModes` and a sparse `restrictions` map, and `Spec-009 §Fallback
// Behavior` requires the capability gap stated rather than substituted — so an excluded
// mode is rendered, disabled, with the mount's own reason beside it, and never dropped
// from the list. A form that showed one row on a plain directory would leave a person
// wondering where the other three went.
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

/** What the bind dialog holds while it is open. */
export interface BindFormState {
  /** Exactly what was typed, or empty for the mount root. Never normalised here. */
  readonly directory: string;
  /** The mode picked. Never defaulted by this console — see `bindFormVerdict`. */
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

/**
 * Read one bind form, and say whether it is a request.
 *
 * THE MODE IS NEVER DEFAULTED, which is the contract's own rule read from the client
 * side: `repo.workspaceBind` refuses to make "the caller omitted a mode" and "the caller
 * chose `read-only`" the same request, and a default written into this form would put
 * that distinction back where nobody could see it.
 *
 * AN EMPTY DIRECTORY IS OMITTED RATHER THAN SENT, because the wire's absent member means
 * the mount root and an empty string does not — it is a path, and a path of no
 * characters is a request the parser refuses.
 *
 * WHAT IS TYPED IS WHAT IS SENT. The emptiness test reads a trimmed copy; a leading or
 * trailing space is a legal POSIX filename character, so trimming on the way out would
 * bind a different directory from the one that was named.
 */
export function bindFormVerdict(form: BindFormState): BindFormVerdict {
  if (form.directory.length > REPO_PATH_MAX_LEN) {
    return {
      status: "incomplete",
      because: `That directory is ${String(form.directory.length)} characters. The wire accepts ${String(REPO_PATH_MAX_LEN)}.`,
    };
  }
  if (form.executionMode === undefined) {
    return { status: "incomplete", because: "Choose the execution mode this workspace binds in." };
  }
  return {
    status: "sendable",
    executionMode: form.executionMode,
    directory: form.directory.trim().length === 0 ? undefined : form.directory,
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
