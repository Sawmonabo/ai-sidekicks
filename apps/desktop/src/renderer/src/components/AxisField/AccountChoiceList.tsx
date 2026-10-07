// The account picker over the accounts this driver's provider carries. The combobox holds the
// daemon-minted `accountId` and shows the account's label through the library's label seam, so a
// renamed account or a newly reported identity never changes the wire identity. The caller mints
// the label id because `role="combobox"` takes no name from its own content.

import { Combobox } from "@base-ui/react/combobox";

import { OverlayComboboxPopup } from "../OverlayPopups/OverlayComboboxPopup.js";
import type { AccountAxisReading } from "#renderer/lib/provider-binding/account/axis.js";

/** What the account picker reads, and the id of the label that names its trigger. */
export interface AccountChoiceListProps {
  readonly reading: Extract<AccountAxisReading, { kind: "served" }>;
  readonly value: string | undefined;
  readonly onValueChange: (accountId: string | undefined) => void;
  /** The id of the field's visible label, which is what names the trigger. */
  readonly labelId: string;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

/** The account picker over a served reading; holds the daemon-minted id, shows the label. */
export function AccountChoiceList(props: AccountChoiceListProps): React.JSX.Element {
  const { reading, value } = props;
  const accountIds = reading.choices.map((choice) => choice.accountId);
  // Never the id: the registry was read, so an account it does not carry was removed.
  const labelFor = (accountId: string): string =>
    reading.choices.find((choice) => choice.accountId === accountId)?.label ?? "Removed account";
  return (
    <Combobox.Root
      items={accountIds}
      value={value ?? null}
      itemToStringLabel={labelFor}
      onValueChange={(next: string | null) => {
        props.onValueChange(next ?? undefined);
      }}
    >
      <Combobox.Trigger
        className="meridian-axis-field__trigger meridian-form__input"
        aria-labelledby={props.labelId}
      >
        <Combobox.Value />
      </Combobox.Trigger>
      {/* The primitive's anchored part keeps this list in the window's airspace; a field
          mounting its own portal would be painted over by the Preview pane's native view. */}
      <OverlayComboboxPopup
        container={props.overlayContainer}
        className="meridian-axis-field__popup"
      >
        <Combobox.Input
          className="meridian-axis-field__input meridian-form__input"
          aria-label="Filter provider accounts"
        />
        <Combobox.Empty className="meridian-axis-field__empty">No account matches.</Combobox.Empty>
        <Combobox.List className="meridian-axis-field__list">
          {reading.choices.map((choice) => (
            <Combobox.Item
              key={choice.accountId}
              value={choice.accountId}
              className="meridian-axis-field__option"
            >
              <span className="meridian-axis-field__option-label">
                {choice.label}
                {choice.isProviderDefault ? " · default" : ""}
              </span>
            </Combobox.Item>
          ))}
        </Combobox.List>
      </OverlayComboboxPopup>
    </Combobox.Root>
  );
}
