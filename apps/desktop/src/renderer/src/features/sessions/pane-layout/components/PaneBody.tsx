// The registered body a pane resolves to, the refusal that says why it has none, or the pane's
// frame alone while the session has not opened. Its own module so "address or refusal" is a named
// predicate instead of a condition inside `SessionPaneSlot`. The refusal wears the pane's own
// chrome, so it is dragged by its header like every pane and its words can be selected. A body
// that throws while drawing reads as one line with `Retry` under the pane's own header, so the
// pane can still be closed and every other region keeps drawing.

import { ErrorBoundary } from "#renderer/components/ErrorBoundary/ErrorBoundary.js";
import { PaneFrame, TITLE_BY_PANE_KIND } from "#renderer/components/PaneFrame/PaneFrame.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneDescriptor } from "#renderer/registries/panes/registry.js";
import { paneEntityKey } from "#renderer/routing/panes/entity-record.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

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
  const clock = useClock();
  if (!isPaneContext(context)) {
    // No session: the address that would name one is what could not be read.
    return (
      <PaneFrame kind={descriptor.kind} sessionId={undefined}>
        {props.isSessionOpen ? <InlineRefusal code={context.code} detail={context.detail} /> : null}
      </PaneFrame>
    );
  }
  const entity = "entity" in context ? context.entity : undefined;
  if (!props.isSessionOpen) {
    return <PaneFrame kind={descriptor.kind} sessionId={props.sessionId} entity={entity} />;
  }
  return (
    <ErrorBoundary
      // A failure line leaves with the subject that threw; a re-pointed body drawing well stays.
      subjectKey={paneEntityKey(entity)}
      regionName={TITLE_BY_PANE_KIND[descriptor.kind]}
      clock={clock}
      frame={(line) => (
        <PaneFrame kind={descriptor.kind} sessionId={props.sessionId} entity={entity}>
          {line}
        </PaneFrame>
      )}
    >
      <RegisteredBody descriptor={descriptor} context={context} />
    </ErrorBoundary>
  );
}

/** The registered body, drawn from its own render so a throw in `render` lands in the boundary. */
function RegisteredBody(props: {
  readonly descriptor: PaneDescriptor;
  readonly context: PaneContext;
}): React.ReactNode {
  return props.descriptor.render(props.context);
}

/** Whether what the pane layout resolved for a pane is an address or a refusal. */
function isPaneContext(resolved: PaneContext | Refusal): resolved is PaneContext {
  return !("code" in resolved);
}
