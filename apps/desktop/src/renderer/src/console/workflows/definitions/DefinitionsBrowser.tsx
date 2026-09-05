// The definitions browser's body: three scope groups in resolution order, and the
// one row a run would actually pick.
//
// The order is the daemon's rule rather than a layout preference, which is why all
// three groups are named and rendered even when all three are empty: the scope model
// has to be legible before anything exists, or an author cannot read which
// definition would win.
//
// FOUR RULES THIS COMPONENT ENCODES, each of which is a rule rather than an omission.
//
//   • **The resolution answer is displayed, never computed.**
//     `resolvesAtThisContext` arrives on the row as the daemon resolved it. A
//     renderer that re-walked `session` → `project` → `shared` would be a second
//     authority on a question the daemon owns, and the two would agree right up
//     until a dedup or a scope reference made them disagree.
//   • **A `shared` row says what editing it does BEFORE any edit begins.** Editing a
//     shared definition never mutates it: the save produces a new definition at the
//     editing context's scope carrying the shared definition's hash as its parent.
//     Stating that after the fact would be the surface discovering a consequence for
//     the author.
//   • **Absent, not disabled.** Every control here appears when its caller supplies
//     the action and not before, so a console that cannot yet author says so by having
//     no button rather than by having a dead one. The continuation control below is
//     the one entry point a caller does supply; a definition-import control used to
//     stand beside it with no producer anywhere in this repository, which is not the
//     same rule applied to a second control but a control that could never appear.
//   • **A refusal is the daemon's, rendered with its code and its message verbatim.**
//     Ten `workflow.*` codes are registered against twenty-two refusal points, and
//     fifteen of those points carry no code of their own — on those the code alone
//     is not diagnostic, so the daemon's message text is the surface and the console
//     paraphrases none of it. One refusal reaches this component and it is the
//     continuation's: the enumeration answers the three scopes in a single reply, so
//     a refused FIRST page is the whole surface's and is drawn by the chrome above,
//     never distributed across three groups that would each then assert an empty
//     result the daemon never gave.
//
// DENSITY IS A BUDGET, AND THIS IS THE CHEAP SIDE OF IT. The list shows the name, the
// scope, the latest version, and the resolution mark. The version chain, the content
// hash, the schema marker, and the parent hash are one click away in the detail pane
// — which is why the row carries the whole summary and renders four of it: opening a
// row hands its caller everything the detail needs without a second read.
//
// THE LIST IS PAGED, AND ITS CONTINUATION IS PART OF THE LIST. The enumeration is
// cursor-paged on the wire, so the rows on screen are a prefix rather than the whole
// answer, and a browser that showed the prefix with nothing beside it would be
// asserting the prefix IS the answer. The continuation therefore renders under the
// groups and not inside one: the cursor pages the whole enumeration across every
// scope at once, so a control inside a group would claim a per-scope handle the wire
// never gave. "Absent, not disabled" applies to it like every other control here —
// it appears while a cursor is held and not otherwise.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method and none of
// these shapes; `WorkflowDefinitionRow` below IS the substrate's own
// `WorkflowDefinitionSummary`, which is where the console declares what the
// enumeration answers with against
// `docs/architecture/contracts/api-payload-contracts.md`, on the growth port's
// precedent. Rows reach this component from its caller and are fixture-fed until the
// wire registers.

import { WORKFLOW_DEFINITION_SCOPES, type WorkflowDefinitionScope } from "../../bridge/index.js";
import { PartialRead, type ReadingState } from "../../primitives/index.js";
import { DefinitionScopeGroup } from "./DefinitionScopeGroup.js";
import type { OpenDefinition, WorkflowDefinitionRow } from "./definition-rows.js";

export interface DefinitionsBrowserProps {
  /** Every definition this context can see, in any order; grouping is done here. */
  readonly definitions: readonly WorkflowDefinitionRow[];
  /** Scopes whose page is still in flight, so their absence reads as a wait. */
  readonly pendingScopes?: readonly WorkflowDefinitionScope[] | undefined;
  /**
   * True while the enumeration holds pages nobody has read.
   *
   * Separate from `pendingScopes` because it answers a different question — that one
   * is what is being waited on, this one is whether the answer is finished — and only
   * a finished enumeration lets a group with no rows say there are none.
   */
  readonly hasUnreadPages?: boolean | undefined;
  /** Opens one definition's detail. Absent while nothing can open one. */
  readonly onOpenDefinition?: OpenDefinition | undefined;
  /** Asks for the page after these. Absent while no cursor is held. */
  readonly onContinueReading?: (() => void) | undefined;
  /**
   * How complete the pages on screen are, as one reading.
   *
   * One member rather than the wait and the refusal as two, because they are two
   * arms of a single question — is what is shown the whole of it — and a surface
   * holding them apart is a surface that can render both or neither. The caller
   * reads the arm off the continuation it already holds; absent is `served`, which
   * is the only arm that renders nothing.
   */
  readonly continuationReading?: ReadingState | undefined;
}

/**
 * What the continuation's notices are ABOUT, mid-sentence.
 *
 * "more definitions" rather than "the definitions": the pages on screen were served
 * and are still true, so every sentence this subject appears in — the wait, and the
 * refusal that says what is shown is not the whole of it — is about the pages BEYOND
 * them. A subject naming the whole list would make a refused continuation read as a
 * refusal of what a person is already looking at.
 */
const CONTINUATION_SUBJECT = "more definitions";

/** The continuation with nothing to report, which is what an absent one means. */
const WHOLE_CONTINUATION: ReadingState = { kind: "served" };

/**
 * What stands under the groups: the handle to the next page, or a wait, or nothing.
 *
 * A function rather than a component, matching `renderScopeBody` next door — this is
 * one of the browser's regions rather than a body with a life of its own, and the
 * three arms are exhaustive over what a caller can say about the pages beyond these.
 */
function renderContinuation(props: DefinitionsBrowserProps): React.ReactNode {
  const continuation = props.continuationReading ?? WHOLE_CONTINUATION;
  if (continuation.kind === "reading") {
    // A wait ON the pages held, never in place of them: the rows above stay on screen
    // while the next page arrives, because they were served and are still true. It
    // stands alone rather than inside the row below, which exists to put a control
    // beside a sentence and has no control to put there while a page is in flight.
    return <PartialRead states={[continuation]} subject={CONTINUATION_SUBJECT} />;
  }
  if (props.onContinueReading === undefined && continuation.kind === "served") {
    return null;
  }
  return (
    <div className="meridian-definitions-continuation">
      <PartialRead states={[continuation]} subject={CONTINUATION_SUBJECT} />
      {props.onContinueReading === undefined ? null : (
        <button
          type="button"
          className="meridian-workflow__action"
          onClick={props.onContinueReading}
        >
          Show more definitions
        </button>
      )}
    </div>
  );
}

/** The three scope groups, in resolution order, with their rows. */
export function DefinitionsBrowser(props: DefinitionsBrowserProps): React.JSX.Element {
  const pendingScopes = props.pendingScopes ?? [];
  return (
    <>
      <ol className="meridian-workflow__scopes">
        {WORKFLOW_DEFINITION_SCOPES.map((scope) => (
          <DefinitionScopeGroup
            key={scope}
            scope={scope}
            definitions={props.definitions.filter((definition) => definition.scope === scope)}
            isPending={pendingScopes.includes(scope)}
            hasUnreadPages={props.hasUnreadPages === true}
            onOpenDefinition={props.onOpenDefinition}
          />
        ))}
      </ol>
      {renderContinuation(props)}
    </>
  );
}
