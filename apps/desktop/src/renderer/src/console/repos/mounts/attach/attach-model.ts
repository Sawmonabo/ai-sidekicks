// What an attach form holds, what makes it sendable, and what the roster offers to
// pick from.
//
// PURE, AND SEPARATE FROM THE ACT FOR THAT REASON. Everything below is a function of
// what a participant typed and what the roster read answered; nothing here reaches a
// bridge or holds a lifetime. The controller beside it owns both.
//
// THE CONSOLE VALIDATES TWO THINGS AND RESOLVES NOTHING. Resolution, containment,
// symlink following, case folding, and working-tree-boundary awareness are DAEMON
// rules, so this module never
// normalises a path, never joins one, never decides whether two spellings name one
// place, and never asks whether a path exists. What it does is refuse to put a request
// on the wire that the contract's own parser would reject unread — an entry with no
// non-whitespace character, and one past `REPO_PATH_MAX_LEN` — because a refusal a
// person can act on beats a schema failure that names a member path.
//
// AND IT SENDS WHAT WAS TYPED, BYTE FOR BYTE. The emptiness guard READS a trimmed copy
// and the request carries the original: a leading or trailing space is a legal POSIX
// filename character, so a console that trimmed on the way out would attach a
// different directory from the one that was named — silently, and only for the paths
// where it matters.
//
// NO ELIGIBILITY IS COMPUTED FOR A NODE, WHICH IS THE PICKER'S WHOLE POSTURE. Whether
// a given node can attach a given path is a question only that node can answer, and
// the roster carries two independent axes — the slot `state` and the sweep-owned
// `healthState` — that the wire deliberately does not reconcile into one. So every
// node the roster names is offered, both axes are disclosed on the row, and a node
// that cannot serve the attach refuses it with a typed code the dialog renders.

import {
  REPO_PATH_MAX_LEN,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type RuntimeNodeRosterEntry,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import { resolveServedSelection, selectedChoiceOf, type ServedSelection } from "../form/index.js";

/** The namespace every frame about a runtime node is registered under. */
const RUNTIME_NODE_EVENT_NAMESPACE_PREFIX = "runtime_node.";

/**
 * Every registered frame that changes a session's node roster.
 *
 * DERIVED FROM THE CONTRACT'S OWN CENSUS rather than hand-listed, on
 * `repos/repo-lifecycle-events.ts`'s shape and for its reason: the registered
 * `runtime_node.*` set is five of a seven-member census today, and a hand-written list
 * would go stale the day the sixth is registered — with a roster on screen that stops
 * re-reading and nothing anywhere saying why. `SESSION_EVENT_CATEGORY_BY_TYPE` is the
 * canonical type registry and its keys are the whole census, so a kind is watched the
 * day it is registered.
 *
 * THE SELECTOR IS THE NAMESPACE AND NOT THE CATEGORY, which is the question the attach
 * dialog is asking — does this frame name a node — and `packages/contracts/src/event.ts`
 * warns against inferring a category from a prefix in any case.
 *
 * AN ARRAY AND NOT A `Set`, on `repos/repo-lifecycle-events.ts`'s shape and for the
 * usual reason: an exported module-level
 * `Set` is a mutable runtime singleton whatever its annotation says — `ReadonlySet`
 * hides `add` from a reader and from nobody else, and every controller in the window
 * shares the one object. What is derived here is the CENSUS, which is data; the
 * `ReadonlySet` a `ReadTriggerTarget` declares is built by the controller that
 * declares it, once per controller, out of this.
 *
 * The annotation is explicit rather than inferred, because `isolatedDeclarations`
 * requires one on every exported binding.
 */
export const RUNTIME_NODE_ROSTER_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType: SessionEventType) =>
  eventType.startsWith(RUNTIME_NODE_EVENT_NAMESPACE_PREFIX),
);

/** What the dialog holds while it is open. Two fields, neither defaulted. */
export interface AttachFormState {
  /** Exactly what was typed. Never trimmed, normalised, or joined by this console. */
  readonly localPath: string;
  /**
   * The node a participant PICKED, or none picked yet.
   *
   * NEVER THE SOLE-NODE DEFAULT. That default is derived per read by
   * {@link resolveAttachForm} against the roster on screen, so it cannot survive the
   * roster it was taken from — which a default written in here would.
   */
  readonly nodeId: string | undefined;
}

/** An empty form: nothing typed, no node chosen. */
export const EMPTY_ATTACH_FORM: AttachFormState = { localPath: "", nodeId: undefined };

/**
 * Whether this form can be sent, and if not, what is missing.
 *
 * A VERDICT RATHER THAN A BOOLEAN, because a disabled control with no sentence is the
 * console refusing and declining to say why — which rule 8 forbids in the same terms
 * it forbids a silent no-op. Each arm names one thing to do next, and the arms are
 * ordered by which a person meets first.
 */
export type AttachFormVerdict =
  | { readonly status: "sendable"; readonly localPath: string; readonly nodeId: string }
  | { readonly status: "incomplete"; readonly because: string };

/** One form read against the roster on screen: the node it is on, and its verdict. */
export interface AttachFormResolution {
  /**
   * The node the picker draws as checked, which is the node the verdict would send.
   *
   * ONE READING SERVING BOTH, which is why this is a resolution rather than two
   * functions: the picker used to fall back to the sole node while the verdict read the
   * form alone, so a single-node session drew a checked radio over a shut control and a
   * roster refresh that dropped the picked node left an open one over a stale id.
   */
  readonly selectedNodeId: string | undefined;
  readonly verdict: AttachFormVerdict;
}

/** One node the picker offers, with both of the roster's health axes disclosed. */
export interface AttachNodeOption {
  readonly nodeId: string;
  /** The slot axis, verbatim: `registering` / `online` / `degraded` / `offline` / `revoked`. */
  readonly state: string;
  /**
   * The sweep-owned liveness axis, or the sentence for a node that has never beat.
   *
   * KEPT SEPARATE FROM `state` because the wire keeps them separate: a node whose slot
   * reads `online` and whose presence reads `offline` is a real and reportable
   * disagreement, and a picker that collapsed them into one word would pick which of
   * the two to believe on the participant's behalf.
   */
  readonly healthState: string;
  /** Whether this node reports itself read-only. Disclosed, never used as a gate. */
  readonly readOnly: boolean;
}

/**
 * Read one form against the roster that is currently served.
 *
 * THE ROSTER IS AN INPUT AND NOT A LATER CHECK. Which node this form is on is a
 * function of what a participant picked AND of what the session still offers, so a
 * refresh that removes the picked node closes the control in the same act that removes
 * the row — rather than leaving an enabled button over an id the daemon would refuse.
 *
 * `undefined` where the roster has not answered, which is a different fact from a
 * roster that answered with no nodes: the first cannot confirm a pick, the second
 * withdraws one.
 */
export function resolveAttachForm(
  form: AttachFormState,
  servedNodes: readonly AttachNodeOption[] | undefined,
): AttachFormResolution {
  const selection = resolveServedSelection<string>({
    chosen: form.nodeId,
    servedChoices: servedNodes?.map((option) => option.nodeId),
    defaultChoice: servedNodes === undefined ? undefined : soleNodeIdOf(servedNodes),
  });
  return {
    selectedNodeId: selectedChoiceOf(selection),
    verdict: attachVerdictFor(form, selection),
  };
}

/**
 * The verdict itself, once the node question has an answer.
 *
 * THE PATH IS CHECKED BEFORE THE NODE because that is the order the form is filled in,
 * and a dialog that reported "choose a node" over an empty path field would name the
 * second obstacle while the first is still on screen.
 *
 * THE LENGTH IS MEASURED IN CODE UNITS, WHICH IS WHAT THE CONTRACT MEASURES. Its cap
 * is a Zod `max` on the string, so this guard is exact rather than approximate — a
 * byte count over a UTF-8 encoding would refuse paths the daemon accepts.
 *
 * EACH CLOSED ARM NAMES ITS OWN FACT. A withdrawn node and a roster that has not
 * answered shut the control for different reasons, and one sentence covering both
 * would be false about whichever it was not written for.
 */
function attachVerdictFor(
  form: AttachFormState,
  selection: ServedSelection<string>,
): AttachFormVerdict {
  if (form.localPath.trim().length === 0) {
    return {
      status: "incomplete",
      because: "Name the repository's path on the node that holds it.",
    };
  }
  if (form.localPath.length > REPO_PATH_MAX_LEN) {
    return {
      status: "incomplete",
      because: `That path is ${String(form.localPath.length)} characters. The wire accepts ${String(REPO_PATH_MAX_LEN)}.`,
    };
  }
  switch (selection.status) {
    case "resolved":
      return { status: "sendable", localPath: form.localPath, nodeId: selection.choice };
    case "withdrawn":
      return {
        status: "incomplete",
        because: "That node is no longer on this session's roster. Choose one of the nodes listed.",
      };
    case "unserved":
      return {
        status: "incomplete",
        because: "This session's nodes have not answered, so the node chosen cannot be confirmed.",
      };
    case "unresolved":
      return { status: "incomplete", because: "Choose the node that can reach that path." };
  }
}

/** The sentence a node with no presence row gets, in place of a health word. */
export const NO_HEARTBEAT_YET = "no heartbeat yet";

/**
 * The picker's options, in the order the roster returned them.
 *
 * NOT SORTED, NOT FILTERED. The roster read is a faithful projection of every
 * attachment row for the session — degraded and offline nodes stay visible and
 * distinguishable rather than hidden — so a console that
 * dropped the unhealthy ones would make an attach that is merely refusable look
 * impossible, and one that reordered them would put the console's opinion of node
 * health ahead of the daemon's ordering.
 */
export function attachNodeOptions(
  entries: readonly RuntimeNodeRosterEntry[],
): readonly AttachNodeOption[] {
  return entries.map((entry) => ({
    nodeId: entry.nodeId,
    state: entry.state,
    healthState: entry.healthState ?? NO_HEARTBEAT_YET,
    readOnly: entry.readOnly,
  }));
}

/**
 * The node to pre-fill, where the roster leaves no choice to make.
 *
 * ONE NODE ONLY, and never "the healthiest" or "the first". A session on one machine
 * is the ordinary case and asking it to pick from a list of one is ceremony; a session
 * on several has a real decision in it, and a console that pre-picked would make that
 * decision quietly and get it wrong exactly when the path is on the other machine.
 */
export function soleNodeIdOf(options: readonly AttachNodeOption[]): string | undefined {
  return options.length === 1 ? options[0]?.nodeId : undefined;
}
