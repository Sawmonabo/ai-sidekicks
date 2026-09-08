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
// NOTHING HERE GATES AND NOTHING HERE IS A COMMAND. Readiness is advisory against the
// unchanged spawn probe, and the remedy is named as an ACT — never as the provider's
// own sign-in invocation or the credential home it writes into, which reach the
// operator surface that owns them and no form.

import { useCallback } from "react";

import {
  useProviderAccountRefresh,
  useProviderQuotas,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { WireFigure } from "../../../primitives/index.js";
import {
  accountAdvisoriesFor,
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
  /** `undefined` clears the pin, which is what asks for the provider's default. */
  readonly onValueChange: (accountId: string | undefined) => void;
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
  const isPinned = value !== undefined && value !== "";
  // The REASON is this call site's and never inferred downstream: a person pressing
  // "Try again" is a participant request, and stamping it as anything else would
  // report an act somebody performed as a window event nobody did.
  const reopenRegistry = useCallback((): void => {
    refreshRegistry("participant-request");
  }, [refreshRegistry]);

  return (
    <div className="meridian-axis-field">
      <span className="meridian-axis-field__label">
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

      {chosen === undefined ? null : (
        <ul className="meridian-axis-field__advisories">
          {accountAdvisoriesFor(chosen).map((advisory) => (
            <li key={advisory} className="meridian-axis-field__advisory">
              {advisory}
            </li>
          ))}
        </ul>
      )}

      <span className="meridian-axis-field__advisory">
        Readiness here is advisory and never a gate — a run validates the account for itself when it
        starts.
      </span>

      {isPinned ? (
        <button
          type="button"
          className="meridian-axis-field__clear"
          onClick={() => {
            props.onValueChange(undefined);
          }}
        >
          Use the provider&rsquo;s default account
        </button>
      ) : null}
    </div>
  );
}
