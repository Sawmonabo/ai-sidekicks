// One scope's group in the definitions browser: its name, what it is, and its rows.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `DefinitionsBrowser.tsx`, for the
// reason `DefinitionListItem.tsx` beside it states: one component per `.tsx`, reached
// by a deep relative import from its host and published through no door line.
//
// THE SCOPE PROSE TRAVELS WITH THE GROUP. The summaries and the copy-on-write
// consequence have exactly one reader and it is the component below; a sentence about
// a scope in one module and the only heading that renders it in another is one closed
// set with two homes.

import type { WorkflowDefinitionScope } from "../../bridge/index.js";
import { Nothing } from "../../primitives/index.js";
import { DefinitionListItem } from "./DefinitionListItem.js";
import type { OpenDefinition, WorkflowDefinitionRow } from "./definition-rows.js";

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

interface DefinitionScopeGroupProps {
  readonly scope: WorkflowDefinitionScope;
  readonly definitions: readonly WorkflowDefinitionRow[];
  readonly isPending: boolean;
  readonly hasUnreadPages: boolean;
  readonly onOpenDefinition: OpenDefinition | undefined;
  /** The group's own escape hatch, when its caller supplies one. */
  readonly emptyAction: React.ReactNode;
}

/** One scope's group: its name, what it is, and whatever it holds. */
export function DefinitionScopeGroup(props: DefinitionScopeGroupProps): React.JSX.Element {
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
 * THREE ABSENCES, because there are three different next moves. `not-loaded` while a
 * page that could hold this scope is arriving — wait. `not-checked` once it has, while
 * the enumeration still holds pages nobody has read — read on. `empty` only when the
 * enumeration is exhausted — create one.
 *
 * The middle arm is the one the browser used to skip. The cursor pages the whole
 * resolved union at once, so a first page with no `shared` row establishes nothing
 * about `shared`; rendering `No shared definitions` there is the console asserting a
 * result the daemon never gave, and it stood while the continuation was in flight and
 * again after the daemon refused it. The daemon's refusal itself is rendered once,
 * under the groups, beside the control that retries it — never three times over.
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
  if (props.hasUnreadPages) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title={`No ${props.scope} definitions in the pages read so far.`}
        detail="The enumeration has more pages and the console has not read them. Reading on may reach definitions at this scope."
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
