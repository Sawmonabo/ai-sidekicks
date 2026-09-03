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
//     the action and not before, so a console that cannot yet author or import says
//     so by having no button rather than by having a dead one.
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

import { memo, useId } from "react";

import {
  WORKFLOW_DEFINITION_SCOPES,
  type WorkflowDefinitionScope,
  type WorkflowDefinitionSummary,
} from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { Chip, InlineRefusal, Nothing, WireFigure, formatCount } from "../primitives/index.js";

/**
 * The three definition scopes, in the daemon's own resolution order, and the row the
 * enumeration answers with — both taken from the bridge's declaration of the workflow
 * plane rather than spelled again here.
 *
 * The tuple is a tuple because the ORDER is the claim. Written as three headings in
 * the markup, the order would be a fact about where someone happened to paste a
 * block; declared as a value, it is something a test can compare against the rule it
 * encodes.
 *
 * NEITHER IS RESTATED IN THIS FAMILY, and that is one rule rather than two. The wire
 * declares the scope vocabulary because the enumeration's request carries it and the
 * row because its reply is made of them, and a second tuple or a second interface
 * here would be a closed set with two homes — they agree until one of them is
 * widened, and the compiler sees neither drift: a member added to the reply stays
 * structurally assignable to a mirror that never heard of it, so every callback in
 * this family would read a vocabulary the daemon had already moved past. Consumers
 * keep importing both from the browser, which is where a reader of this surface looks
 * for them.
 */
export { WORKFLOW_DEFINITION_SCOPES };
export type { WorkflowDefinitionScope };

/**
 * One definition, as the enumeration carries it.
 *
 * The list draws four of it — the name, the scope, the latest version, and the
 * resolution mark — and carries the whole row anyway, because a row is the value a
 * caller passes to whatever opens the detail: trimming it here would force that
 * caller into a second read for facts it already held. What each member MEANS is
 * documented once, on the wire declaration this alias names.
 */
export type WorkflowDefinitionRow = WorkflowDefinitionSummary;

/** What each group is, in a line, so the scope model teaches itself. */
const SCOPE_SUMMARIES: Readonly<Record<WorkflowDefinitionScope, string>> = {
  session: "Authored in this session. Checked first, so a session definition wins.",
  project: "Shared by everyone working in this project checkout. Checked second.",
  shared: "Available across projects, and never edited in place — editing forks a copy.",
};

/**
 * The copy-on-write consequence, stated on the group it applies to.
 *
 * On the GROUP rather than on each row, because it is a property of the scope and a
 * sentence repeated under every shared row is a sentence nobody finishes reading.
 * It names both editing contexts rather than asserting which one applies here: which
 * scope a fork lands at depends on whether there is a project context, and that is
 * the daemon's answer at save time, not a fact this list may predict.
 */
const SHARED_SCOPE_CONSEQUENCE =
  "Editing one of these never changes it. The save creates a new definition at your editing scope — the project, or this session where there is no project — carrying this definition's hash as its parent, and the shared original is untouched.";

/** What a row's open control does, when a caller supplies one. */
type OpenDefinition = (definition: WorkflowDefinitionRow) => void;

interface DefinitionListItemProps {
  readonly definition: WorkflowDefinitionRow;
  /** Required-and-nullable rather than optional: every construction site sets it. */
  readonly onOpenDefinition: OpenDefinition | undefined;
}

/**
 * One definition's row.
 *
 * Memoized: the browser re-renders on every page of a cursor-paged fetch, and rows
 * already on screen have not changed. Row values are frozen wire summaries, so the
 * default shallow comparison is the right one.
 */
const DefinitionListItem = memo(function DefinitionListItem(
  props: DefinitionListItemProps,
): React.JSX.Element {
  const { definition, onOpenDefinition } = props;
  const resolutionMarkId = useId();
  const resolvesHere = definition.resolvesAtThisContext;
  return (
    <li
      className={
        resolvesHere
          ? "meridian-definition-row meridian-definition-row--resolves"
          : "meridian-definition-row"
      }
      // The mark is announced as well as shown — a chip a screen reader reads as one
      // more label among several does not say what it is — but it is announced as a
      // DESCRIPTION and not as `aria-current`.
      //
      // `aria-current` marks the single current item within a set, and
      // `resolvesAtThisContext` is not that: it is an independent predicate per
      // definition NAME, so a scope holding resolving definitions for two names marks
      // two rows, and assistive technology then says "current" about several rows in
      // one list without saying what any of them is current for. Pointing the row's
      // description at the mark it already renders says the thing that is actually
      // true, in the words the surface already chose.
      aria-describedby={resolvesHere ? resolutionMarkId : undefined}
    >
      {onOpenDefinition === undefined ? (
        <span className="meridian-definition-row__name">{definition.name}</span>
      ) : (
        <button
          type="button"
          className="meridian-definition-row__name meridian-definition-row__open"
          onClick={() => {
            onOpenDefinition(definition);
          }}
        >
          {definition.name}
        </button>
      )}
      <Chip mono label={definition.scope} />
      <span className="meridian-definition-row__version">
        version{" "}
        <WireFigure
          value={formatCount(definition.latestVersionNumber)}
          title={`${definition.latestVersionNumber}`}
        />
      </span>
      {resolvesHere ? (
        // The wrapper exists to be referable by id and for nothing else, which is why
        // it generates no box: the mark's place on the row is a design decision, and a
        // span introduced to carry an attribute must not quietly move it.
        <span className="meridian-definition-row__resolution" id={resolutionMarkId}>
          {/*
           * NEUTRAL, and that is the whole of the treatment. Rule 3 spends the accent
           * on interactive affordances, and a resolution mark is a fact the daemon
           * reported about this row — nothing here is pressable, and the row's one
           * control is the name beside it. Toned accent, the mark advertised a
           * non-actionable reading as the thing to click.
           */}
          <Chip glyph="check" label="Resolves here" />
        </span>
      ) : null}
    </li>
  );
});

interface DefinitionScopeGroupProps {
  readonly scope: WorkflowDefinitionScope;
  readonly definitions: readonly WorkflowDefinitionRow[];
  readonly isPending: boolean;
  readonly onOpenDefinition: OpenDefinition | undefined;
  /** The group's own escape hatch, when its caller supplies one. */
  readonly emptyAction: React.ReactNode;
}

/** One scope's group: its name, what it is, and whatever it holds. */
function DefinitionScopeGroup(props: DefinitionScopeGroupProps): React.JSX.Element {
  return (
    <li className="meridian-workflow__scope">
      <h3 className="meridian-workflow__scope-heading">{props.scope}</h3>
      <p className="meridian-workflow__scope-summary">{SCOPE_SUMMARIES[props.scope]}</p>
      {props.scope === "shared" ? (
        <p className="meridian-workflow__scope-consequence">{SHARED_SCOPE_CONSEQUENCE}</p>
      ) : null}
      {renderScopeBody(props)}
    </li>
  );
}

/**
 * A group's body: its rows, or the right kind of nothing.
 *
 * `not-loaded` while this scope's page is still arriving and `empty` once it has —
 * the two are different next moves (wait, versus create one), and a group that
 * rendered "no definitions" during its own fetch would be asserting an answer it had
 * not received.
 */
function renderScopeBody(props: DefinitionScopeGroupProps): React.ReactNode {
  if (props.definitions.length > 0) {
    return (
      <ul className="meridian-definition-rows">
        {props.definitions.map((definition) => (
          <DefinitionListItem
            key={definition.id}
            definition={definition}
            onOpenDefinition={props.onOpenDefinition}
          />
        ))}
      </ul>
    );
  }
  if (props.isPending) {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title={`Reading ${props.scope} definitions.`}
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title={`No ${props.scope} definitions.`}
      detail="A definition saved at this scope appears here, and the one a run would pick is marked."
      action={props.emptyAction}
    />
  );
}

export interface DefinitionsBrowserProps {
  /** Every definition this context can see, in any order; grouping is done here. */
  readonly definitions: readonly WorkflowDefinitionRow[];
  /** Scopes whose page is still in flight, so their absence reads as a wait. */
  readonly pendingScopes?: readonly WorkflowDefinitionScope[] | undefined;
  /** Opens one definition's detail. Absent while nothing can open one. */
  readonly onOpenDefinition?: OpenDefinition | undefined;
  /** Reads a definition file in and submits it. Absent while nothing can import one. */
  readonly onImportDefinition?: (() => void) | undefined;
  /** Asks for the page after these. Absent while no cursor is held. */
  readonly onContinueReading?: (() => void) | undefined;
  /** True while that page is in flight, so its absence reads as a wait. */
  readonly isContinuing?: boolean | undefined;
  /** A refused continuation, rendered beside the control. The rows held stay. */
  readonly continuationRefusal?: ConsoleRefusal | undefined;
}

/**
 * What stands under the groups: the handle to the next page, or a wait, or nothing.
 *
 * A function rather than a component, matching `renderScopeBody` next door — this is
 * one of the browser's regions rather than a body with a life of its own, and the
 * three arms are exhaustive over what a caller can say about the pages beyond these.
 */
function renderContinuation(props: DefinitionsBrowserProps): React.ReactNode {
  if (props.isContinuing === true) {
    // A wait ON the pages held, never in place of them: the rows above stay on screen
    // while the next page arrives, because they were served and are still true.
    return <Nothing kind="not-loaded" placement="inline" title="Reading more definitions." />;
  }
  if (props.onContinueReading === undefined && props.continuationRefusal === undefined) {
    return null;
  }
  return (
    <div className="meridian-definitions-continuation">
      {props.continuationRefusal === undefined ? null : (
        <InlineRefusal
          code={props.continuationRefusal.code}
          detail={props.continuationRefusal.detail}
        />
      )}
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
            onOpenDefinition={props.onOpenDefinition}
            emptyAction={
              // Import belongs to the scope an import lands in, and a control offered
              // three times is a control that reads as three different acts.
              scope === "session" && props.onImportDefinition !== undefined ? (
                <button
                  type="button"
                  className="meridian-workflow__action"
                  onClick={props.onImportDefinition}
                >
                  Import a definition file
                </button>
              ) : undefined
            }
          />
        ))}
      </ol>
      {renderContinuation(props)}
    </>
  );
}
