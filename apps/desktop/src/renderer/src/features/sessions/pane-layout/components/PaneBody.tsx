// The registered body a pane resolves to, or the refusal that says why it has none. Its own
// module so "address or refusal" is a named predicate instead of a condition inside
// `SessionPaneSlot`'s ternary chain.

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { type Refusal } from "#renderer/lib/refusal/refusal.js";
import { type PaneContext } from "#renderer/registries/panes/pane-context.js";
import { type PaneDescriptor } from "#renderer/registries/panes/pane-registry.js";

/** The registered body, or the refusal that says why this pane has no address. */
export function PaneBody(props: {
  readonly descriptor: PaneDescriptor;
  readonly context: PaneContext | Refusal;
}): React.ReactNode {
  return isPaneContext(props.context) ? (
    props.descriptor.render(props.context)
  ) : (
    <InlineRefusal code={props.context.code} detail={props.context.detail} />
  );
}

/** Whether what the pane layout resolved for a pane is an address or a refusal. */
function isPaneContext(resolved: PaneContext | Refusal): resolved is PaneContext {
  return !("code" in resolved);
}
