// What stands in the relay step's connection seat before a choice has resolved.
//
// The seat itself, its contract, and the shell that fills it are
// `RelayConnectionShell.tsx` beside this file. This module answers a different
// question — what the step renders when there is no connection to describe yet — and
// it is a component of its own because this tree gives each `.tsx` module exactly one.

import { Nothing } from "../../primitives/index.js";
import type { OwnerSlotProps } from "../../seats/index.js";
import type { RelayConnectionBody } from "./RelayConnectionShell.js";
import type { RelayMethodId } from "./relay-choice.js";

export interface RelayConnectionMountProps extends OwnerSlotProps<RelayConnectionBody> {
  /** `undefined` until a choice has resolved — nothing to connect with yet. */
  readonly methodId: RelayMethodId | undefined;
  /** Absent for the same reason as the method: no choice, no resolved address. */
  readonly relayUrl: string | undefined;
  readonly hasCredentialHandle: boolean;
}

/**
 * Mount the connection body, or say that nothing has been chosen yet.
 *
 * `not-checked` and not `empty`: "no relay is in force" would be a claim about this
 * node, and until a choice resolves nothing has asked the question at all.
 */
export function RelayConnectionMount(props: RelayConnectionMountProps): React.JSX.Element {
  const { body, methodId, relayUrl } = props;
  if (body === undefined || methodId === undefined || relayUrl === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="No relay has been chosen yet."
        detail="Choosing one opens a window this console does not draw, where anything the option needs is supplied. What comes back is the choice and, where there was a secret, a handle that names it."
      />
    );
  }
  return <>{body({ methodId, relayUrl, hasCredentialHandle: props.hasCredentialHandle })}</>;
}
