// One provider axis as a combobox over a provider-published vocabulary, built on
// `@base-ui/react`'s combobox primitives.
// A vocabulary that does not exist gets no control: a disabled one would assert the
// capability exists but is momentarily unavailable, and the daemon refuses an unsettable axis.

import { Combobox } from "@base-ui/react/combobox";

import { OverlayComboboxPopup } from "../../components/OverlayComboboxPopup/OverlayComboboxPopup.js";

/** What the axis combobox shows and hands back. */
export interface AxisComboboxProps {
  /** The field label a person reads, e.g. "Effort". */
  readonly label: string;
  /** The provider-published choices. `undefined` or empty renders nothing (see the header). */
  readonly options: readonly string[] | undefined;
  readonly value: string | undefined;
  readonly onValueChange: (value: string | undefined) => void;
  /** Where popups portal. The frame's overlay root; `undefined` is its own window's body. */
  readonly overlayContainer?: HTMLElement | null | undefined;
  /** Shown under the control, for an advisory the caller wants beside the field. */
  readonly advisory?: string | undefined;
  /** Marks the field as carrying a caller edit over a definition's value. */
  readonly isOverridden?: boolean | undefined;
}

/** A provider axis as a combobox; renders nothing when the vocabulary is absent or empty. */
export function AxisCombobox(props: AxisComboboxProps): React.JSX.Element | null {
  const { options } = props;
  if (options === undefined || options.length === 0) {
    return null;
  }
  return (
    <label className="meridian-axis-field meridian-form__field">
      <span className="meridian-form__label">
        {props.label}
        {props.isOverridden === true ? (
          <span className="meridian-axis-field__overridden meridian-form__label-note">
            {" "}
            overridden
          </span>
        ) : null}
      </span>
      <Combobox.Root
        items={options as string[]}
        value={props.value ?? null}
        onValueChange={(next: string | null) => props.onValueChange(next ?? undefined)}
      >
        <Combobox.Trigger className="meridian-axis-field__trigger meridian-form__input">
          <Combobox.Value />
        </Combobox.Trigger>
        {/* The primitive's anchored part keeps this list in the window's airspace; a field
            mounting its own portal would be painted over by the Preview pane's native view. */}
        <OverlayComboboxPopup
          container={props.overlayContainer}
          positionerClassName="meridian-axis-field__positioner"
          className="meridian-axis-field__popup"
        >
          <Combobox.Input
            className="meridian-axis-field__input meridian-form__input"
            aria-label={`Filter ${props.label.toLowerCase()}`}
          />
          <Combobox.Empty className="meridian-axis-field__empty">No value matches.</Combobox.Empty>
          <Combobox.List className="meridian-axis-field__list">
            {options.map((option) => (
              <Combobox.Item key={option} value={option} className="meridian-axis-field__option">
                {option}
              </Combobox.Item>
            ))}
          </Combobox.List>
        </OverlayComboboxPopup>
      </Combobox.Root>
      {props.advisory === undefined ? null : (
        <span className="meridian-axis-field__advisory">{props.advisory}</span>
      )}
    </label>
  );
}
