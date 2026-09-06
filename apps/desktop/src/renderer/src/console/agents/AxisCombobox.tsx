// One provider axis, as a combobox over a provider-published vocabulary.
//
// COMPOSITION. `Spec-023 §Console Libraries` adopts `@base-ui/react` 1.7.0 as the one
// widget family "including combobox and autocomplete", so the roles, the listbox
// keyboard model, `aria-activedescendant`, the focus management, and the portal are
// the library's. Nothing about any of that is re-implemented here — that is the
// whole reason the family was adopted, and the palette composes the same primitives
// for the same reason.
//
// WHY BOTH THE ATTACH FORM AND THE SWITCH CONTROL REACH THIS FILE. They render the
// same three axes over the same two vocabularies, and a second copy would be two
// components that had to agree about the one rule below and eventually would not.
//
// THE RULE: A VOCABULARY THAT DOES NOT EXIST GETS NO CONTROL AT ALL.
// `Spec-023 §Console Design (Meridian)` §The eight rules makes a control that cannot
// be used ABSENT rather than disabled, and the composer restates it for exactly these
// capability-gated axes: a disabled control asserts that a capability exists and is
// momentarily unavailable — which would be false. An absent or empty vocabulary
// makes the axis unsettable and the mutation refuses fail-closed, so drawing a
// control over one would be offering a choice the daemon will not take.

import { Combobox } from "@base-ui/react/combobox";

export interface AxisComboboxProps {
  /** The field label a person reads, e.g. "Effort". */
  readonly label: string;
  /**
   * The provider-published choices. `undefined` or empty renders NOTHING — see the
   * header; the caller decides whether to say why.
   */
  readonly options: readonly string[] | undefined;
  readonly value: string | undefined;
  readonly onValueChange: (value: string | undefined) => void;
  /** Where popups portal. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly overlayContainer?: HTMLElement | null | undefined;
  /** Shown under the control, for an advisory the caller wants beside the field. */
  readonly advisory?: string | undefined;
  /** Marks the field as carrying a caller edit over a definition's value. */
  readonly isOverridden?: boolean | undefined;
}

export function AxisCombobox(props: AxisComboboxProps): React.JSX.Element | null {
  const { options } = props;
  if (options === undefined || options.length === 0) {
    return null;
  }
  return (
    <label className="meridian-axis-field">
      <span className="meridian-axis-field__label">
        {props.label}
        {props.isOverridden === true ? (
          <span className="meridian-axis-field__overridden"> overridden</span>
        ) : null}
      </span>
      <Combobox.Root
        items={options as string[]}
        value={props.value ?? null}
        onValueChange={(next: string | null) => props.onValueChange(next ?? undefined)}
      >
        <Combobox.Trigger className="meridian-axis-field__trigger">
          <Combobox.Value />
        </Combobox.Trigger>
        <Combobox.Portal container={props.overlayContainer}>
          <Combobox.Positioner className="meridian-axis-field__positioner">
            <Combobox.Popup className="meridian-axis-field__popup">
              <Combobox.Input
                className="meridian-axis-field__input"
                aria-label={`Filter ${props.label.toLowerCase()}`}
              />
              <Combobox.Empty className="meridian-axis-field__empty">
                No value matches.
              </Combobox.Empty>
              <Combobox.List className="meridian-axis-field__list">
                {options.map((option) => (
                  <Combobox.Item
                    key={option}
                    value={option}
                    className="meridian-axis-field__option"
                  >
                    {option}
                  </Combobox.Item>
                ))}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {props.advisory === undefined ? null : (
        <span className="meridian-axis-field__advisory">{props.advisory}</span>
      )}
    </label>
  );
}
