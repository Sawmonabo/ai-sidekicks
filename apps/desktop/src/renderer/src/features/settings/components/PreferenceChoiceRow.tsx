// One preference and one choice, in the settings row. Written once for the settings pages that
// share it: a native select, so the keyboard, the label and an option that cannot be picked come
// from the platform. The row never decides whether a setting may change; `value` and `isPending`
// come from the page.

import { useId, type ReactNode } from "react";

import type { SettingsControl } from "../types.js";
import { PreferenceRow } from "./PreferenceRow.js";

/** One entry of a choice: the value it picks and the words it reads. */
export interface PreferenceChoiceOption {
  readonly value: string;
  readonly label: string;
  /** Drawn in its place but cannot be picked. */
  readonly isDisabled?: boolean | undefined;
  /** Never listed, so it can only stand as the value already held; it reads blank there. */
  readonly isHidden?: boolean | undefined;
}

/** Props for {@link PreferenceChoiceRow}. */
export interface PreferenceChoiceRowProps {
  /** The findable control the row draws, whose label it shows. */
  readonly control: SettingsControl;
  /** The lines under the label, each its own paragraph, tied to the choice as its description. */
  readonly descriptionLines?: readonly ReactNode[] | undefined;
  /** Every entry, in the order the choice lists them. */
  readonly options: readonly PreferenceChoiceOption[];
  /** The value picked now; one of `options`. */
  readonly value: string;
  /** The entry the setting ships with, one of `options`; any other value draws the changed mark. */
  readonly defaultOption: PreferenceChoiceOption;
  /** True while a write for this key is in flight. The choice stops taking picks. */
  readonly isPending?: boolean | undefined;
  readonly onChoose: (value: string) => void;
}

/** A labeled choice for one preference; picks are ignored while `isPending`. */
export function PreferenceChoiceRow(props: PreferenceChoiceRowProps): React.JSX.Element {
  const selectId = useId();
  return (
    <PreferenceRow
      control={props.control}
      controlElementId={selectId}
      descriptionLines={props.descriptionLines ?? []}
      changedFromDefault={
        props.value === props.defaultOption.value
          ? undefined
          : { defaultDescription: `${props.defaultOption.label} by default` }
      }
      renderControl={(describedBy) => (
        <select
          id={selectId}
          className="meridian-form__input"
          aria-describedby={describedBy}
          value={props.value}
          disabled={props.isPending ?? false}
          onChange={(event) => {
            props.onChoose(event.currentTarget.value);
          }}
        >
          {props.options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.isDisabled ?? false}
              hidden={option.isHidden ?? false}
            >
              {option.label}
            </option>
          ))}
        </select>
      )}
    />
  );
}
