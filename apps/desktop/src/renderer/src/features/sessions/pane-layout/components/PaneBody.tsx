// The registered body a pane resolves to, the refusal that says why it has none, or the pane's
// frame alone while the session has not opened. Its own module so "address or refusal" is a named
// predicate instead of a condition inside `SessionPaneSlot`. The refusal wears the pane's own
// chrome, so it is dragged by its header like every pane and its words can be selected.

import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneDescriptor } from "#renderer/registries/panes/registry.js";

/**
 * The registered body, the refusal that says why this pane has no address, or, before the session
 * opens, the frame alone.
 */
export function PaneBody(props: {
  readonly descriptor: PaneDescriptor;
  readonly context: PaneContext | Refusal;
  /**
   * Whether the session's store has opened. Until it has, the pane draws its frame alone, at its
   * place with its address's trail, since its body reads the session.
   */
  readonly isSessionOpen: boolean;
  /** The session the pane is about, which its frame names while it draws no body. */
  readonly sessionId: string | undefined;
}): React.ReactNode {
  const { context, descriptor } = props;
  if (!isPaneContext(context)) {
    // No session: the address that would name one is what could not be read.
    return (
      <PaneFrame kind={descriptor.kind} sessionId={undefined}>
        {props.isSessionOpen ? <InlineRefusal code={context.code} detail={context.detail} /> : null}
      </PaneFrame>
    );
  }
  if (!props.isSessionOpen) {
    return (
      <PaneFrame
        kind={descriptor.kind}
        sessionId={props.sessionId}
        entity={"entity" in context ? context.entity : undefined}
      />
    );
  }
  return descriptor.render(context);
}

/** Whether what the pane layout resolved for a pane is an address or a refusal. */
function isPaneContext(resolved: PaneContext | Refusal): resolved is PaneContext {
  return !("code" in resolved);
}
