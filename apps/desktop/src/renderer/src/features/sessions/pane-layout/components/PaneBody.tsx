// The registered body a pane resolves to, or the refusal that says why it has none. Its own
// module so "address or refusal" is a named predicate instead of a condition inside
// `SessionPaneSlot`'s ternary chain. The refusal wears the pane's own chrome, so it is dragged by
// its header like every pane and its words can be selected.

import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneDescriptor } from "#renderer/registries/panes/registry.js";

/** The registered body, or the refusal that says why this pane has no address. */
export function PaneBody(props: {
  readonly descriptor: PaneDescriptor;
  readonly context: PaneContext | Refusal;
}): React.ReactNode {
  return isPaneContext(props.context) ? (
    props.descriptor.render(props.context)
  ) : (
    // No session: the address that would name one is what could not be read.
    <PaneFrame kind={props.descriptor.kind} sessionId={undefined}>
      <InlineRefusal code={props.context.code} detail={props.context.detail} />
    </PaneFrame>
  );
}

/** Whether what the pane layout resolved for a pane is an address or a refusal. */
function isPaneContext(resolved: PaneContext | Refusal): resolved is PaneContext {
  return !("code" in resolved);
}
