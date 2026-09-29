// The registered body a pane resolves to, or the refusal that says why it has none.
//
// Its own module for the one-component rule, and the narrowing is what earns the
// split: whether the deck resolved an address or a refusal is a named predicate here
// rather than a condition inside the slot's ternary chain, which already has three
// arms of its own.

import { InlineRefusal } from "@renderer/console/primitives/index.js";
import { type ConsoleRefusal } from "@renderer/lib/refusal.js";
import {
  type ConsolePaneContext,
  type ConsolePaneDescriptor,
} from "@renderer/console/seats/index.js";

/** The registered body, or the refusal that says why this pane has no address. */
export function PaneBody(props: {
  readonly descriptor: ConsolePaneDescriptor;
  readonly context: ConsolePaneContext | ConsoleRefusal;
}): React.ReactNode {
  return isPaneContext(props.context) ? (
    props.descriptor.render(props.context)
  ) : (
    <InlineRefusal code={props.context.code} detail={props.context.detail} />
  );
}

/** Whether what the deck resolved for a pane is an address or a refusal. */
function isPaneContext(
  resolved: ConsolePaneContext | ConsoleRefusal,
): resolved is ConsolePaneContext {
  return !("code" in resolved);
}
