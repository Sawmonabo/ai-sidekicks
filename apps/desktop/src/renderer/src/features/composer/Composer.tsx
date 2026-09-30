// The composer host: the region, its accessible framing, and the zones it mounts in order.
// It reads no wire itself and draws no Send control: Enter keeps the draft as typed and
// sends nothing. It owns the provider-command enumeration holder and hands it to the command
// list, whose enumeration is read live and never cached.

import { useId, useRef } from "react";

import { type ComposerProps } from "@renderer/registries/composer/composer-registry.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { ComposerToolbar } from "./components/ComposerToolbar.js";
import { CommandList } from "./command-list/components/CommandList.js";
import { ProviderCommandEnumeration } from "./command-list/provider-command-enumeration.js";
import { DraftLine } from "./draft-line/components/DraftLine.js";
import "./Composer.css";

/** Module-level so the resource holder is handed a stable opener. */
function openEnumeration(): ProviderCommandEnumeration {
  return new ProviderCommandEnumeration();
}

/**
 * Releases the enumeration without ending it: `close()` supersedes any outstanding read and a
 * later `open()` reads again, so there is no closed state to report. Module-level so hook
 * dependency lists see one identity.
 */
const enumerationDisposal: SubjectScopedDisposal<ProviderCommandEnumeration> = {
  release: (enumeration: ProviderCommandEnumeration): void => {
    enumeration.close();
  },
};

/**
 * The composer for one session. The session id sits in a visually hidden description so that
 * two windows on two sessions do not announce identically.
 */
export function MessageComposer(props: ComposerProps): React.JSX.Element {
  const descriptionId = useId();
  const regionRef = useRef<HTMLElement | null>(null);
  // One holder per addressed composer, never shared across sessions (the enumeration is not
  // cached). It survives a bridge swap under the same session: the holder's key compares the
  // bridge by identity, so a replaced bridge re-reads instead of serving the old catalog. Held as
  // a resource, not a `useMemo`: React may discard a memoized value and re-run the factory, which
  // would leave a holder with an open read that nothing ever closes.
  const { value: commandEnumeration } = useSubjectScopedResource<ProviderCommandEnumeration>(
    props.sessionStore,
    props.sessionStore.sessionId,
    openEnumeration,
    enumerationDisposal,
  );
  return (
    <section
      className="meridian-composer"
      aria-label="Message composer"
      aria-describedby={descriptionId}
      ref={regionRef}
    >
      <p className="meridian-visually-hidden" id={descriptionId}>
        Composing in session {props.sessionStore.sessionId}.
      </p>
      <DraftLine {...props} />
      <CommandList {...props} region={regionRef} commandEnumeration={commandEnumeration} />
      <ComposerToolbar {...props} />
    </section>
  );
}
