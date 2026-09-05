// The definitions browser with a wire behind it.
//
// `WorkflowsSurface` is the chrome and takes rows; this is the component that goes
// and gets them. ONE caller mounts it — `WorkflowsDestination.tsx`, the rail's
// workflows destination — and it always supplies a session. The builder pane's
// no-subject arm used to be the second, which is what made `sessionId` optional and
// the enumeration's `unasked` arm reachable; that arm now renders
// `unaddressedBuilderPane()` and mounts nothing, so the option went with it. A prop
// that can only ever be supplied is required, and a header naming a caller that no
// longer exists is the state in which the next reader restores the unreachable arm
// rather than deleting it.
//
// THE ENUMERATION IS SESSION-SCOPED, AND THAT IS THE WIRE'S SHAPE RATHER THAN A
// CHOICE. Resolution walks `session` then `project` then `shared` FROM a session, so
// the registered request carries a required session id, and the destination resolves
// one before it mounts this browser at all.
//
// WHY THE MAPPING FROM READ STATE TO CHROME STATE LIVES HERE. The chrome is told
// about rows and which of the absence grammars to reach for; the port answers with ONE
// outcome for the whole enumeration. Turning one answer into what the surface shows is
// a decision, and it is made once here rather than inside the chrome, which would then
// have two ways to be told the same thing.
//
// WHAT EACH SCOPE GROUP MAY CLAIM IS NOT DECIDED HERE. It is projected by
// `definitions/definition-directory.ts` from the continuation that read already carries, and
// threaded through untouched. Deriving it here as well — a pending tuple from the
// directory's status and an exhaustion answer from the control's presence — is how the
// groups came to assert `No shared definitions` over an enumeration with pages left.
//
// A REFUSED ENUMERATION IS ONE REFUSAL AND NOT THREE EMPTY GROUPS. A wait does belong
// to all three scopes — one read serves them all, so all three are pending together
// — but a REFUSAL does not distribute the same way: attaching it to each group left
// every group rendering the refusal AND `No <scope> definitions` underneath it,
// which turns one failed read into three asserted empty results about a daemon that
// answered none of them. The refusal is the whole surface's, so it reaches the chrome
// as the `refused` state and the groups are not rendered at all.
//
// AND THERE IS NO PER-SCOPE REFUSAL BESIDE IT, because no registered reply carries
// one. The enumeration's reply is a single envelope — the rows and a cursor — so a
// refusal of it is the call's and not a scope's, and this hook puts ONE unscoped read
// for the resolved union rather than three scoped ones. The refusal that would really
// have belonged to a single scope is an authoring denial at `shared`, and the growth
// port declares no authoring operation at all: its workflow half is the enumeration,
// the run start, read, cancel and resume, the phase-output read, the gate resolve,
// the human-form submit, the gate-chain verify and the run enumeration — ten
// operations, none of which writes a definition. A prop for a refusal nothing in this
// console can raise is a seam that reads as coverage and has no producer, so the
// browser passes none and the surface below declares none.

import type { GrowthPort } from "../bridge/index.js";
import type { ReadingState } from "../primitives/index.js";
import type { WorkflowDefinitionRow } from "./definitions/DefinitionsBrowser.js";
import { WorkflowsSurface } from "./WorkflowsSurface.js";
import { useReadSettlementAnnouncement } from "./read-announcement.js";
import { refusedWorkflowChrome, type WorkflowChromeState } from "./chrome-state.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
} from "./definitions/definition-directory.js";

/**
 * Which chrome the surface wears, given one read state.
 *
 * `ready` for every arm that has something to show or something to wait on, and the
 * refusal grammar for the one that does not: a refused enumeration produced no list
 * to group, so the groups do not render and the daemon's own code and message stand
 * in their place.
 */
function chromeStateFor(directory: WorkflowDefinitionDirectoryState): WorkflowChromeState {
  return directory.status === "unavailable"
    ? refusedWorkflowChrome(directory.refusal)
    : { kind: "ready" };
}

/**
 * The continuation control the browser offers, given one read state.
 *
 * Present exactly while the hook would act on it — a cursor in hand and nothing in
 * flight — so "absent, not disabled" is decided once, here, rather than by the
 * browser rendering a control and the hook quietly ignoring it.
 */
function continuationActionFor(
  directory: WorkflowDefinitionDirectoryState,
  continueReading: () => void,
): (() => void) | undefined {
  if (directory.status !== "served") {
    return undefined;
  }
  const { continuation } = directory;
  return continuation.status === "available" || continuation.status === "unavailable"
    ? continueReading
    : undefined;
}

/**
 * How complete the pages on screen are, read off the continuation the state carries.
 *
 * The read arm and the refused arm are the same question — is what is shown the whole
 * of it — so they leave here as ONE reading rather than as a boolean beside a refusal.
 * Held apart, a surface could render both at once or neither, and both readings would
 * be false.
 *
 * `beside-an-answer` on the refused arm, and that is the substance of it: the pages
 * already served stay on screen because they were served and are still true, so the
 * refusal qualifies them rather than replacing them. `whole-answer` would say none of
 * it is shown, over a list a person is looking at.
 *
 * Every other arm has nothing to report, including a directory that itself refused:
 * that refusal is the surface's own state and the chrome renders it, and a second
 * sentence under groups that are not there would be the same refusal said twice.
 * Nothing to report leaves as an absent reading rather than a second spelling of
 * `served` — the browser owns that constant, and one home is what keeps the two from
 * disagreeing about what an unstated continuation means.
 */
function continuationReadingFor(
  directory: WorkflowDefinitionDirectoryState,
): ReadingState | undefined {
  if (directory.status !== "served") {
    return undefined;
  }
  const { continuation } = directory;
  if (continuation.status === "reading") {
    return { kind: "reading" };
  }
  return continuation.status === "unavailable"
    ? { kind: "refused", scope: "beside-an-answer", refusal: continuation.refusal }
    : undefined;
}

/**
 * What this browser says about a settled enumeration, or nothing while it has not.
 *
 * The enumeration lands without moving focus, so before this a screen reader heard
 * which session came into scope and that the runs list had settled, and never that the
 * definition list had — the groups simply filled in under a cursor somewhere else.
 *
 * The count is the whole resolved union rather than a figure per scope, because that is
 * what the read answered: one request serves all three, and three sentences would
 * report a split the daemon never made. A refusal carries the daemon's own sentence.
 *
 * A CONTINUATION IN FLIGHT HAS SETTLED NOTHING, AND THE PAGES STAY `served` WHILE IT
 * RUNS. So the directory's own status is not the whole discriminator: pressing "Show
 * more definitions" produced a fresh state object carrying the OLD count, and the
 * settlement hook — which counts once per state object — spoke that count again as
 * though a second read had completed, before the page it announced had answered. And
 * when the daemon refused that page, this function still handed back the count, so the
 * refusal rendered on screen and was never spoken at all. Both arms are the
 * continuation's own, and both are read from it.
 */
function directorySentence(directory: WorkflowDefinitionDirectoryState): string | undefined {
  if (directory.status === "unavailable") {
    return directory.refusal.detail;
  }
  if (directory.status !== "served") {
    return undefined;
  }
  const { continuation } = directory;
  if (continuation.status === "reading") {
    // Nothing has settled since the last thing this said. Announcing here would
    // promise a result the page has not produced, and the hook records only what it
    // spoke — so the settlement that follows is still announced when it arrives.
    return undefined;
  }
  return continuation.status === "unavailable"
    ? continuation.refusal.detail
    : `Definitions visible from this session: ${String(directory.definitions.length)}.`;
}

export interface WorkflowsBrowserProps {
  readonly growth: GrowthPort;
  /** The session the enumeration is scoped to. The one mount always resolves one. */
  readonly sessionId: string;
  /**
   * Opens one definition in the builder. Absent while nothing can address one.
   *
   * Still optional, and it is the only one that is: the browser's suites mount it
   * without a pane board to open into, which is a real caller that legitimately has
   * nowhere to send a row. `onNewDefinition` had no such caller — nothing in this
   * console can author a definition, the growth port declares no authoring operation
   * at all, and the vanished builder mount was the only thing that ever threaded it
   * — so it is gone rather than reserved.
   */
  readonly onOpenDefinition?: ((definition: WorkflowDefinitionRow) => void) | undefined;
}

/** The definitions browser, reading the definitions it shows. */
export function WorkflowsBrowser(props: WorkflowsBrowserProps): React.JSX.Element {
  const { state, scopeResolution, continueReading } = useWorkflowDefinitionDirectory(
    props.growth,
    props.sessionId,
  );
  useReadSettlementAnnouncement(state, directorySentence(state));
  return (
    <WorkflowsSurface
      state={chromeStateFor(state)}
      // The same session the enumeration above was read under, threaded rather than
      // dropped: the surface mounts the conversational start, and a start binds to a
      // session. A browser that read one session's definitions and handed the mount
      // nothing would leave the body with no subject on the very arm that has one.
      sessionId={props.sessionId}
      definitions={state.status === "served" ? state.definitions : undefined}
      pendingScopes={scopeResolution.pendingScopes}
      hasUnreadPages={scopeResolution.hasUnreadPages}
      onContinueReading={continuationActionFor(state, continueReading)}
      continuationReading={continuationReadingFor(state)}
      onOpenDefinition={props.onOpenDefinition}
    />
  );
}
