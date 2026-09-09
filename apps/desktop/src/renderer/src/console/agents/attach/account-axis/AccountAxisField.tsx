// The attach form's provider-account axis: a picker over the node's registry, with
// what the registry stored about the chosen account beside it.
//
// A SECOND COMBOBOX BESIDE `AxisCombobox` AND NOT A WIDENING OF IT. That component
// renders a provider-published vocabulary of bare strings and takes exactly one
// disposition for an absent one — no vocabulary, no control — which is right for an
// axis the daemon will refuse to set at all. This axis is three things it is not: its
// choices carry a LABEL a person recognises beside the opaque handle the wire takes,
// its advisory is composed per chosen account rather than fixed by the caller, and
// "nothing to choose" is a state that still has to say WHY — a registry not yet read,
// a read refused, a driver naming no provider this build knows, and a provider with
// no accounts are four different answers, and a picker that simply vanished would
// report all four as the same absence.
//
// THE READ IS OPENED HERE, WHICH IS WHY THE FIELD TAKES A BRIDGE. `bridge/quotas/`
// holds the node's ONE account-plane reading and opens it when the first watcher
// arrives; this field is that watcher and it is mounted only while the attach dialog
// is open, so a window that never attaches holds no registry subscription and a
// dialog that closes gives it up. A read hoisted to the column above would be held
// for the life of every agent console instead, for a picker most of them never draw.
//
// AND IT IS OPTIONAL, WHICH IS WHY IT CAN BE CLEARED. An absent account resolves at
// the daemon to the provider's registered default; a pinned one that has left the
// registry refuses rather than falling back. Both are legible states, so the field
// offers the way back to the first and says what the second costs — and it does
// neither by removing the caller's own value, which is theirs and not this form's.
//
// BUT "CLEARED" IS THE WIRE'S WORD AND NOT THIS FORM'S. Dropping the caller's own
// entry does not always reach the provider default: the registered request has no
// null arm for this member, so an absent member means "take the definition's value"
// rather than "take no value". The four states that follow from that are what
// {@link AccountAxisProvenance} names, and the reset control below is rendered — and
// labelled — from them rather than from whether the field happens to hold a string.
//
// AND THE READINGS FOLLOW THE ACCOUNT THE ATTACH WILL USE, NOT ONLY THE ONE IT PINS.
// Pinning nothing is the state a person meets this field in, and it is a request for
// the provider's registered default — an account the readiness entry already names. A
// field that spoke only for a pinned value therefore said nothing at all in the common
// case, so a known-unhealthy default stayed silent until the daemon refused. Which
// account a list is about is said before the list, because a default's health read as
// a pinned one's is the one confusion this addition could introduce.
//
// NOTHING HERE GATES AND NOTHING HERE IS A COMMAND. Readiness is advisory against the
// unchanged spawn probe, and the remedy is named as an ACT — never as the provider's
// own sign-in invocation or the credential home it writes into, which reach the
// operator surface that owns them and no form.

import { useCallback, useId } from "react";

import {
  useProviderAccountRefresh,
  useProviderQuotas,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { WireFigure } from "../../../primitives/index.js";
import { accountAdvisoriesFor, unresolvedDefaultAdvisoryIn } from "./account-advisories.js";
import {
  advisoryChoiceIn,
  attachAccountAxisReadingFor,
  chosenAccountIn,
  registryCarriesAccount,
} from "./account-axis.js";
import { AccountChoiceAbsence } from "./AccountChoiceAbsence.js";
import { AccountChoiceList } from "./AccountChoiceList.js";

export interface AccountAxisFieldProps {
  readonly bridge: ConsoleBridge;
  /** The driver the form resolved to, entered or inherited. Decides the provider. */
  readonly driverName: string | undefined;
  /** The account the form currently carries, entered or inherited. */
  readonly value: string | undefined;
  /** `undefined` drops the caller's own entry; what that RESOLVES to is the form's. */
  readonly onValueChange: (accountId: string | undefined) => void;
  /**
   * What this axis falls back to once the caller's entry is dropped.
   *
   * The chosen definition's pinned account, or `undefined` where dropping the entry
   * leaves the axis unset and the daemon resolves the provider's registered default.
   * Supplied by the form rather than derived here, because it is the same per-field
   * resolution the displayed {@link value} came through.
   */
  readonly inheritedValue: string | undefined;
  /** Marks the field as carrying a caller edit over a definition's value. */
  readonly isOverridden: boolean;
  /** Where popups portal. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function AccountAxisField(props: AccountAxisFieldProps): React.JSX.Element {
  const { bridge, value } = props;
  const registry = useProviderQuotas(bridge);
  const refreshRegistry = useProviderAccountRefresh(bridge);
  const reading = attachAccountAxisReadingFor(registry, props.driverName);
  const chosen = chosenAccountIn(reading, value);
  const provenance = accountAxisProvenanceOf(props);
  const isPinned = provenance !== "unpinned";
  // THE PIN AS THE PROVENANCE READ IT, and never the raw member. The form clears an
  // axis by entering the empty string, so `value` carries two spellings of "pins
  // nothing" and the provenance above is where that is decided — passing the member
  // instead would put a second reading of emptiness in this file and let the field's
  // own sentence and its advisories disagree about whether anything is pinned.
  const pinnedAccountId = isPinned ? value : undefined;
  const advisoryChoice = advisoryChoiceIn(reading, pinnedAccountId);
  const unresolvedDefaultAdvisory = unresolvedDefaultAdvisoryIn(reading, pinnedAccountId);
  // The REASON is this call site's and never inferred downstream: a person pressing
  // "Try again" is a participant request, and stamping it as anything else would
  // report an act somebody performed as a window event nobody did.
  const reopenRegistry = useCallback((): void => {
    refreshRegistry("participant-request");
  }, [refreshRegistry]);

  // THE FIELD NAMES ITS OWN CONTROL, EXPLICITLY. This field's root is a `div` rather
  // than the `<label>` its sibling axes use — it has to hold a reset control, a retry
  // control, and four absence states, none of which belongs inside a label element —
  // so nothing about the markup would have associated the visible word with the
  // combobox, and `role="combobox"` forbids a name taken from the trigger's own
  // content. In the state a person meets first, no account pinned, the trigger's
  // content is empty besides, so the control had no name at all. Minted rather than
  // written out because two of these fields can share one window.
  const labelId = useId();

  return (
    <div className="meridian-axis-field">
      <span className="meridian-axis-field__label" id={labelId}>
        Provider account
        {props.isOverridden ? (
          <span className="meridian-axis-field__overridden"> overridden</span>
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
        <AccountChoiceAbsence reading={reading} onReopen={reopenRegistry} />
      )}

      {/* THE CALLER'S OWN VALUE, WHEREVER THE PICKER CANNOT SHOW IT. A definition can
          supply an account under a driver whose registry has not been read, and a
          field that rendered nothing there would hide a member the request will
          carry. It is shown as the wire figure it is, never as a label this console
          could not resolve. */}
      {isPinned && chosen === undefined ? (
        <span className="meridian-axis-field__advisory">
          This form is carrying <WireFigure value={value ?? ""} />.
        </span>
      ) : null}

      {isPinned && !registryCarriesAccount(reading, value ?? "") ? (
        <span className="meridian-axis-field__advisory">
          This provider&rsquo;s registry does not carry that account. The attach refuses rather than
          falling back to a default, so nothing silently changes who pays.
        </span>
      ) : null}

      {/* WHICH ACCOUNT THE READINGS BELOW ARE ABOUT, SAID BEFORE THEM. An axis that
          pins nothing asks the daemon for the provider's registered default, so the
          readings that bear on this attach are that account's — and a list opening
          with them unannounced would read as the health of an account the form had
          pinned. Naming the account this attach resolves to is not the same act as
          pinning it: nothing here writes the value, and the request still carries no
          account from this path. */}
      {advisoryChoice === undefined ? null : (
        <>
          <span className="meridian-axis-field__advisory">
            {isPinned
              ? `What follows is about ${advisoryChoice.displayLabel}, the account this form pins.`
              : `Nothing is pinned, so this attach resolves to ${advisoryChoice.displayLabel}. What follows is that account’s reading, and the request still names no account.`}
          </span>
          <ul className="meridian-axis-field__advisories">
            {accountAdvisoriesFor(advisoryChoice).map((advisory) => (
              <li key={advisory} className="meridian-axis-field__advisory">
                {advisory}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* THE STATE THAT RENDERED NOTHING AT ALL. Where nothing is pinned and
          resolution reached no account, there is no row whose readings could carry
          the remedy — so the form went on asking for a default that does not exist
          and the daemon's refusal was the first thing to say so. */}
      {unresolvedDefaultAdvisory === undefined ? null : (
        <span className="meridian-axis-field__advisory">{unresolvedDefaultAdvisory}</span>
      )}

      <span className="meridian-axis-field__advisory">
        Readiness here is advisory and never a gate — a run validates the account for itself when it
        starts.
      </span>

      {/* WHY THE LABEL IS WHAT IT IS, AND WHY THERE IS SOMETIMES NO CONTROL AT ALL.
          The label names the value this press RESOLVES TO, which the registered
          request decides rather than this field: an explicitly-present member
          overrides that axis alone, an absent one means "take the definition's
          value", and the attach request carries no null arm for the account the way
          `agent.configUpdate` carries one for the default node. So dropping an entry
          made over a definition that pins an account returns THAT account, and only
          an entry standing over nothing reaches the provider's registered default.
          On a definition's own inherited account there is no entry to drop and the
          control is ABSENT rather than disabled — a press could not have reached the
          provider default, and a control saying so was promising an act no member of
          this request can carry. */}
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
          This account is the definition&rsquo;s. Choosing another overrides it for this agent —
          including whichever the registry marks default — but an attach from a definition cannot
          ask for no account at all.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Where the account this field is showing came from — the closed set of four.
 *
 * Declared once and read by both the reset control and the sentence beside it, so
 * the control's label and the field's explanation of itself can never disagree.
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
 * Which of the four this field is in.
 *
 * `isOverridden` is PRESENCE of an entry rather than value inequality, which is what
 * separates the two entered arms from `inherited`: a caller who retyped the
 * definition's own account has still explicitly said it, and the form sends it.
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
