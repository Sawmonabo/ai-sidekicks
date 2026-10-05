// One definition's row in the Workflows tab's table.

import "./DefinitionListItem.css";

import { memo } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire/figures.js";
import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { OpenDefinition } from "../definition-rows.js";

interface DefinitionListItemProps {
  readonly definition: WorkflowDefinitionSummary;
  /** Required-and-nullable rather than optional: every construction site sets it. */
  readonly onOpenDefinition: OpenDefinition | undefined;
}

/**
 * One definition's row, memoized: the table re-renders on every page of a cursor-paged fetch,
 * and row values are frozen wire summaries.
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
