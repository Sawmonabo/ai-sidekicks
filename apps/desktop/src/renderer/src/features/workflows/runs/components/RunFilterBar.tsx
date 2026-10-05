import { useId } from "react";

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import {
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TRIGGER_KINDS,
  type WorkflowRunStatus,
  type WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/run";

import { RUN_STATUS_WORDS, TRIGGER_KIND_WORDS } from "../../words.js";
import { RUN_DATE_RANGES, RUN_DATE_RANGE_WORDS, type RunFilters } from "../run-filters.js";

/** The value a select holds for "no filter". */
const ANY = "";

/**
 * The runs table's four filters — workflow, status, trigger and date range — each one choice.
 * They narrow the table alone; what stands above it never moves under them.
 */
export function RunFilterBar(props: {
  readonly filters: RunFilters;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly onChange: (next: RunFilters) => void;
}): React.JSX.Element {
  const idPrefix = useId();
  const { filters, onChange } = props;
  return (
    <div className="meridian-workflows-filters" role="group" aria-label="Filter runs">
      <FilterSelect
        id={`${idPrefix}-workflow`}
        label="Workflow"
        value={filters.definitionId ?? ANY}
        options={[
          { value: ANY, label: "Every workflow" },
          ...props.definitions.map((definition) => ({
            value: definition.id,
            label: definition.name,
          })),
        ]}
        onChange={(value) => {
          const { definitionId: _definitionId, ...rest } = filters;
          onChange(value === ANY ? rest : { ...rest, definitionId: value });
        }}
      />
      <FilterSelect
        id={`${idPrefix}-status`}
        label="Status"
        value={filters.status ?? ANY}
        options={[
          { value: ANY, label: "Any status" },
          ...WORKFLOW_RUN_STATUSES.map((status) => ({
            value: status,
            label: RUN_STATUS_WORDS[status],
          })),
        ]}
        onChange={(value) => {
          const { status: _status, ...rest } = filters;
          const status = WORKFLOW_RUN_STATUSES.find((candidate) => candidate === value);
          onChange(
            status === undefined ? rest : { ...rest, status: status satisfies WorkflowRunStatus },
          );
        }}
      />
      <FilterSelect
        id={`${idPrefix}-trigger`}
        label="Trigger"
        value={filters.triggerKind ?? ANY}
        options={[
          { value: ANY, label: "Any trigger" },
          ...WORKFLOW_TRIGGER_KINDS.map((kind) => ({
            value: kind,
            label: TRIGGER_KIND_WORDS[kind],
          })),
        ]}
        onChange={(value) => {
          const { triggerKind: _triggerKind, ...rest } = filters;
          const triggerKind = WORKFLOW_TRIGGER_KINDS.find((candidate) => candidate === value);
          onChange(
            triggerKind === undefined
              ? rest
              : { ...rest, triggerKind: triggerKind satisfies WorkflowTriggerKind },
          );
        }}
      />
      <FilterSelect
        id={`${idPrefix}-range`}
        label="Date range"
        value={filters.dateRange}
        options={RUN_DATE_RANGES.map((range) => ({
          value: range,
          label: RUN_DATE_RANGE_WORDS[range].label,
        }))}
        onChange={(value) => {
          const dateRange = RUN_DATE_RANGES.find((candidate) => candidate === value) ?? "any";
          onChange({ ...filters, dateRange });
        }}
      />
    </div>
  );
}

function FilterSelect(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <span className="meridian-workflows-filters__filter meridian-form__field">
      <label htmlFor={props.id} className="meridian-form__label">
        {props.label}
      </label>
      <select
        id={props.id}
        className="meridian-form__input"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
