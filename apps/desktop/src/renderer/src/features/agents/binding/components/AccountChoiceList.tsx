// The account picker over the accounts this driver's provider carries. The combobox holds the
// daemon-minted `accountId` and resolves the label through the library's label seam, so a
// relabeled account never changes the wire identity. The caller mints the label id because
// `role="combobox"` takes no name from its own content.

import { Combobox } from "@base-ui/react/combobox";

import { OverlayComboboxPopup } from "../../components/OverlayComboboxPopup/OverlayComboboxPopup.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { AccountAxisReading } from "../account-axis.js";

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
  // An id the registry does not carry falls back to itself, so a held value never renders as
  // a blank trigger, which would read as "no account pinned".
  const labelFor = (accountId: string): string =>
    reading.choices.find((choice) => choice.accountId === accountId)?.displayLabel ?? accountId;
  return (
    <Combobox.Root
      items={accountIds}
      value={value ?? null}
      itemToStringLabel={labelFor}
      onValueChange={(next: string | null) => {
        props.onValueChange(next ?? undefined);
      }}
    >
      <Combobox.Trigger className="meridian-axis-field__trigger" aria-labelledby={props.labelId}>
        <Combobox.Value />
      </Combobox.Trigger>
      {/* The primitive's anchored part keeps this list in the window's airspace; a field
          mounting its own portal would be painted over by a native browser-pane view. */}
      <OverlayComboboxPopup
        container={props.overlayContainer}
        positionerClassName="meridian-axis-field__positioner"
        className="meridian-axis-field__popup"
      >
        <Combobox.Input
          className="meridian-axis-field__input"
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
                {choice.displayLabel}
                {choice.isProviderDefault ? " · default" : ""}
              </span>
              <WireFigure value={choice.accountId} />
            </Combobox.Item>
          ))}
        </Combobox.List>
      </OverlayComboboxPopup>
    </Combobox.Root>
  );
}
