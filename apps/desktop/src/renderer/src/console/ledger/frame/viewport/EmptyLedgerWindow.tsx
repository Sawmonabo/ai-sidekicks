// What an empty ledger window draws.
//
// Its own module for the one-component rule, and it earns one: the viewport beside it
// arranges elements and deliberately decides nothing, while this answers a question
// with two inputs — what the window is a log OF, and whether this session's sidekicks
// may reach each other at all.

import { Nothing } from "../../../primitives/index.js";
import { emptyLedgerWords, type LedgerScope } from "./empty-window-words.js";

export interface EmptyLedgerWindowProps {
  /** What this window is a log of. A channel's emptiness is not the session's. */
  readonly scope: LedgerScope;
  /** The projected grant, or `undefined` where the read did not report one. */
  readonly peerInvocationEnabled?: boolean | undefined;
}

/**
 * The window with nothing in it, in the console's own shape for an absence.
 *
 * A component rather than three lines inside the viewport's return, because what it
 * says is a decision with two inputs and that function is the one place in this family
 * that deliberately makes none — every other element there is arrangement.
 */
export function EmptyLedgerWindow(props: EmptyLedgerWindowProps): React.JSX.Element {
  const words = emptyLedgerWords(props.scope, props.peerInvocationEnabled);
  return <Nothing kind="empty" placement="surface" title={words.title} detail={words.detail} />;
}
