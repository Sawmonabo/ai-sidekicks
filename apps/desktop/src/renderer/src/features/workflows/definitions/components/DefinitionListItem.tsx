// One definition's row in the Workflows tab's table.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN A LIST MODULE, which is the package's
// one-component-per-`.tsx` rule: a module holding several components is a module whose
// name answers for one of them, and the others are reached only by reading the file.

import "./DefinitionListItem.css";

import { memo } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { OpenDefinition, WorkflowDefinitionRow } from "../definition-rows.js";

interface DefinitionListItemProps {
  readonly definition: WorkflowDefinitionRow;
  /** Required-and-nullable rather than optional: every construction site sets it. */
  readonly onOpenDefinition: OpenDefinition | undefined;
}

/**
 * One definition's row.
 *
 * Memoized: the table re-renders on every page of a cursor-paged fetch, and rows already
 * on screen have not changed. Row values are frozen wire summaries, so the default
 * shallow comparison is the right one.
 *
 * @consumedBy the Workflows tab's table of definitions
 */
export const DefinitionListItem: React.MemoExoticComponent<
  (props: DefinitionListItemProps) => React.JSX.Element
> = memo(function DefinitionListItem(props: DefinitionListItemProps): React.JSX.Element {
  const { definition, onOpenDefinition } = props;
  return (
    <li className="meridian-definition-row">
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
    </li>
  );
});
