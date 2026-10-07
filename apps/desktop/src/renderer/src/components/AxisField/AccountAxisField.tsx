// The provider-account axis: a picker over the node's registry, with what it stored about the
// chosen account beside it. Not a widening of `AxisCombobox`: a choice is held by its opaque id
// and shown by its label, advisories are per account, and "nothing to choose" must say why. The
// caller owns the registry reading; readiness is advisory and never a gate or a command.

import "./AxisField.css";

import { useId } from "react";

import {
  accountAdvisoriesFor,
  unresolvedDefaultAdvisoryIn,
} from "#renderer/lib/provider-binding/account/advisories.js";
import {
  advisoryChoiceIn,
  accountAxisReadingFor,
  registryCarriesAccount,
  type AccountRegistryReading,
} from "#renderer/lib/provider-binding/account/axis.js";
import { AccountChoiceEmptyState } from "./AccountChoiceEmptyState.js";
import { AccountChoiceList } from "./AccountChoiceList.js";

/** What the account field reads from the caller, and what it hands back. */
export interface AccountAxisFieldProps {
  /** The node's account registry, as the caller last read it. */
  readonly registry: AccountRegistryReading;
  /** Asks the caller to read the registry again. Pressed from the empty states. */
  readonly onReopenRegistry: () => void;
  /** The driver the form resolved to, entered or inherited. Decides the provider. */
  readonly driverName: string | undefined;
  /** The account the form currently carries, entered or inherited. */
  readonly value: string | undefined;
  /** `undefined` drops the caller's own entry; what that RESOLVES to is the form's. */
  readonly onValueChange: (accountId: string | undefined) => void;
  /**
   * What the axis falls back to once the caller's entry is dropped: the definition's pinned
   * account, or `undefined` where the daemon resolves the provider's default. Supplied by the
   * form, the same per-field resolution {@link value} came through.
   */
  readonly inheritedValue: string | undefined;
  /** Marks the field as carrying a caller edit over a definition's value. */
  readonly isOverridden: boolean;
  /** Where popups portal. The frame's overlay root; `undefined` is its own window's body. */
  readonly overlayContainer?: HTMLElement | null | undefined;
  /** The machine's clock locale, which the stored reading's instant is written in. */
  readonly clockLocale: string;
}

/** The provider-account axis: a picker over the registry, or why there is none. */
export function AccountAxisField(props: AccountAxisFieldProps): React.JSX.Element {
  const { registry, value } = props;
  const reading = accountAxisReadingFor(registry, props.driverName);
  const provenance = accountAxisProvenanceOf(props);
  const isPinned = provenance !== "unpinned";
  // The pin as the provenance read it, not the raw member: the form clears an axis with the
  // empty string, so the raw value has two spellings of "pins nothing".
  const pinnedAccountId = isPinned ? value : undefined;
  const advisoryChoice = advisoryChoiceIn(reading, pinnedAccountId);
  const unresolvedDefaultAdvisory = unresolvedDefaultAdvisoryIn(reading, pinnedAccountId);
  // The root is a `div`, not a `<label>`, and `role="combobox"` takes no name from its content,
  // so the trigger is named explicitly. Minted because two fields can share a window.
  const labelId = useId();

  return (
    <div className="meridian-axis-field meridian-form__field">
      <span className="meridian-form__label" id={labelId}>
        Provider account
        {props.isOverridden ? (
          <span className="meridian-axis-field__overridden meridian-form__label-note">
            {" "}
            overridden
          </span>
        ) : null}
      </span>

      {reading.kind === "served" && reading.choices.length > 0 ? (
        <AccountChoiceList
          reading={reading}
          value={value}
          onValueChange={props.onValueChange}
          labelId={labelId}
          overlayContainer={props.overlayContainer}
        />
      ) : (
        <AccountChoiceEmptyState reading={reading} onReopen={props.onReopenRegistry} />
      )}

      {isPinned && !registryCarriesAccount(reading, value ?? "") ? (
        <span className="meridian-axis-field__advisory">
          This provider&rsquo;s registry does not carry that account.
        </span>
      ) : null}

      {/* Says which account the readings are about: an unpinned axis asks for the provider's
          default, and naming it here does not pin it or write the value. */}
      {advisoryChoice === undefined ? null : (
        <>
          <span className="meridian-axis-field__advisory">
            {isPinned
              ? `What follows is about ${advisoryChoice.label}, the account this form pins.`
              : "Nothing is pinned, so this run resolves to " +
                `${advisoryChoice.label}. What follows is that account’s ` +
                "reading, and the request still names no account."}
          </span>
          <ul className="meridian-axis-field__advisories">
            {accountAdvisoriesFor(advisoryChoice, props.clockLocale).map((advisory) => (
              <li key={advisory} className="meridian-axis-field__advisory">
                {advisory}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Unpinned and unresolved: no row can carry the remedy, so it is said here. */}
      {unresolvedDefaultAdvisory === undefined ? null : (
        <span className="meridian-axis-field__advisory">{unresolvedDefaultAdvisory}</span>
      )}

      <span className="meridian-axis-field__advisory">
        Readiness here is advisory and never a gate — a run validates the account for itself when it
        starts.
      </span>

      {/* The label names what a press resolves to, which the registered request decides: an
          absent member means "take the definition's value" (there is no null arm for the
          account), so dropping an entry over a definition returns that account and only an
          entry over nothing reaches the provider default. Over a definition's own account
          there is no entry to drop, so the control is absent rather than disabled. */}
      {provenance === "unpinned" || provenance === "inherited" ? null : (
        <button
          type="button"
          className="meridian-axis-field__clear"
          onClick={() => {
            props.onValueChange(undefined);
          }}
        >
          {provenance === "entered-over-definition"
            ? "Use the definition’s account"
            : "Use the provider’s default account"}
        </button>
      )}

      {provenance === "inherited" ? (
        <span className="meridian-axis-field__advisory">
          This account is the definition&rsquo;s. Choosing another overrides it for this sidekick —
          including whichever the registry marks default.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Where the account this field shows came from. The reset control's label and the field's
 * explanatory sentence both read it, so they cannot disagree.
 */
type AccountAxisProvenance =
  /** Nothing pinned. The daemon resolves the provider's registered default. */
  | "unpinned"
  /** The caller's entry, standing over nothing. Dropping it reaches that default. */
  | "entered-over-nothing"
  /** The caller's entry over a definition's. Dropping it returns the definition's. */
  | "entered-over-definition"
  /** The definition's own, which no member of this request can unset. */
  | "inherited";

/**
 * Which provenance this field is in. `isOverridden` is presence of an entry, not value
 * inequality: a caller who retyped the definition's own account has still said it.
 */
function accountAxisProvenanceOf(props: AccountAxisFieldProps): AccountAxisProvenance {
  if (props.value === undefined || props.value === "") {
    return "unpinned";
  }
  if (!props.isOverridden && props.inheritedValue !== undefined) {
    return "inherited";
  }
  return props.inheritedValue === undefined ? "entered-over-nothing" : "entered-over-definition";
}
