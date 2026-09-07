// The relay step's seat for the connection detail, and the shell standing in it.
//
// WHAT THIS CONSOLE OWNS AND WHAT IT DOES NOT. The step above this seat is chrome:
// the three options, what each one means for a session's traffic, what each one will
// ask for, and the one primary action. The CONNECTION — the relay address, the
// admin-issued join token, the first-connection fingerprint confirmation, and the
// hosted account's browser sign-in — belongs to the plan that owns the first-run
// flow, and every one of those is either a secret or a browser hand-off that
// `Spec-026 §Pitfalls To Avoid` puts in the main process because rendering the
// admin-token field in a renderer has already leaked it once.
//
// SO THE BODY IS NOT MERELY UNBUILT HERE — IT IS UNBUILDABLE HERE. That is why the
// seat exists at all rather than a form: a form authored in this window would be the
// exact implementation that section names as the defect.
//
// AND THE SHELL RENDERS WHAT THE FLOW WAS TOLD, rather than a reservation. What comes
// back from the main-process dialog is an identifier and, where the option needed a
// secret, an opaque handle that names one without carrying it. Both are facts a
// person should see — which option is now in force, and whether a credential is being
// held for it — so the shell renders them, and renders the handle as PRESENCE and
// never as a value. There is no control here and no field: the shell states, and the
// step's own action is what advances.
//
// The seat's MOUNT is `RelayConnectionMount.tsx` beside this file: what a seat holds
// and what happens where nothing has been chosen are two components, and this tree
// gives each `.tsx` module exactly one.

import { WireFigure } from "../../primitives/index.js";
import type { OwnerSlotContract, OwnerSlotProps } from "../../seats/index.js";
import { RELAY_METHOD_OPTIONS, type RelayMethodId } from "./relay-choice.js";

/** What the step hands the connection body once a method has been chosen. */
export interface RelayConnectionBodyProps {
  readonly methodId: RelayMethodId;
  /**
   * The address this node relays through, as the daemon's own config holds it.
   *
   * A VALUE and not a presence flag, which is what separates it from the handle
   * below: `Spec-026 §Persistence` keeps `relay_url` in plaintext config beside the
   * choice id, and `Spec-026 §Three-Way Choice Semantics` requires the current
   * published address to be DISPLAYED for the default option rather than described.
   */
  readonly relayUrl: string;
  /**
   * Whether main is holding a secret for this connection.
   *
   * A boolean and never the handle itself. The handle names a value this window may
   * not read, and rendering an opaque string a person cannot act on would be noise
   * that looks like a credential.
   */
  readonly hasCredentialHandle: boolean;
}

/** The connection body, as a render function — the shape every seat in this tree uses. */
export type RelayConnectionBody = (props: RelayConnectionBodyProps) => React.ReactNode;

/**
 * Who owns the body, what this step owes it, and where the shell dies.
 *
 * Developer-facing and never rendered: every member is prose naming governance work,
 * and no console surface displays one.
 */
export const RELAY_CONNECTION_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the first-run plan's relay-connection orchestration (its main-process modules)",
  mountObligation:
    "The step supplies the chosen relay identifier, the address it resolved to, and whether a credential handle came back, and mounts the body only after a choice has resolved. Every input the connection needs — the relay address, the join token, the fingerprint confirmation, the hosted sign-in — is collected in the main process; this window neither collects nor forwards any of them.",
  deleteShellIn:
    "The first-run task that authors the connection body deletes this shell rather than leaving it beside the body.",
};

/**
 * The stand-in body: what the flow was told, and nothing it was not.
 *
 * It renders scenario data rather than a reservation, because there IS an answer to
 * render — the choice resolved and something came back — and a reservation here would
 * hide a fact the walkthrough already holds behind a sentence about unbuilt work.
 */
export function RelayConnectionShell(props: RelayConnectionBodyProps): React.JSX.Element {
  const option = RELAY_METHOD_OPTIONS[props.methodId];
  return (
    <div className="meridian-onboarding__connection">
      <p className="meridian-onboarding__note">{option.consequence}</p>
      <p className="meridian-onboarding__note">
        This node relays through <WireFigure value={props.relayUrl} />.
      </p>
      <p className="meridian-onboarding__note">
        {props.hasCredentialHandle
          ? "A credential for this relay is held by the host process. It was typed in a window this one cannot read and never reached here."
          : "This option needed no secret, so none is held."}
      </p>
    </div>
  );
}

/** The seat, with the shell in it. Filled rather than reserved — see the header. */
export const RELAY_CONNECTION_SLOT: OwnerSlotProps<RelayConnectionBody> = {
  contract: RELAY_CONNECTION_SLOT_CONTRACT,
  body: RelayConnectionShell,
};
