// The account picker itself, over the accounts this driver's provider carries.
//
// A MODULE OF ITS OWN rather than a private declaration beside its one caller: a
// `.tsx` file declares exactly one component, private ones counted, which is the rule
// that keeps a component's identity and its file name the same fact.
//
// THE HANDLE IS THE ITEM AND THE LABEL IS A PROJECTION OF IT. What the request
// carries is the daemon-minted opaque `accountId`, so that is what the combobox holds
// and hands back — a picker whose items were labels would put the operator's own
// mutable word where the wire's identity belongs, and two accounts relabelled alike
// would become indistinguishable to it. The label is what a person reads, filters on,
// and sees in the trigger, and it is resolved through the library's own label seam
// rather than by a second list beside the items.
//
// AND THE FIELD'S OWN NAME COMES IN, because it is not this module's to invent. The
// trigger renders as `role="combobox"`, which takes no name from its own content, and
// the visible "Provider account" word belongs to the field that composes this picker
// beside four other absences. So the caller mints the id and this points at it.

import { Combobox } from "@base-ui/react/combobox";

import { OverlayComboboxPopup, WireFigure } from "../../../primitives/index.js";
import type { AttachAccountAxisReading } from "./account-axis.js";

export interface AccountChoiceListProps {
  readonly reading: Extract<AttachAccountAxisReading, { kind: "served" }>;
  readonly value: string | undefined;
  readonly onValueChange: (accountId: string | undefined) => void;
  /** The id of the field's visible label, which is what names the trigger. */
  readonly labelId: string;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function AccountChoiceList(props: AccountChoiceListProps): React.JSX.Element {
  const { reading, value } = props;
  const accountIds = reading.choices.map((choice) => choice.accountId);
  // An id the registry does not carry falls back to ITSELF rather than to an empty
  // string, so a value this form is holding is never rendered blank — an empty
  // trigger over a set member would read as "no account pinned", which is the one
  // thing it is not.
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
      {/* The anchored part of the tree is the primitive's, which is what puts this
          list in the window's airspace: a field that mounted its own portal would be
          a popup a native browser-pane view paints over and takes the input of. */}
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
