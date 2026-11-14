// What the payload fetch established, on each of its three arms. The body is text only: decoded
// bytes go whole into a `<pre>` as an escaped text node, and nothing here can interpret a
// payload (no `dangerously`, `src`, `href`, or element a media type could turn into a document).

import "./ArtifactPayloadSection.css";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { NO_PREVIEW_LINE } from "#renderer/lib/no-preview.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import type { ArtifactPayloadReading } from "#renderer/store/artifact-payload.js";

/** What the payload section draws. */
export interface ArtifactPayloadSectionProps {
  /** What the fetch has established so far. Absent until a fetch starts. */
  readonly payload: ArtifactPayloadReading | undefined;
}

/** The section, or nothing at all where nobody has asked for any bytes. */
export function ArtifactPayloadSection({
  payload,
}: ArtifactPayloadSectionProps): React.JSX.Element | null {
  if (payload === undefined) {
    return null;
  }
  return (
    <section className="meridian-artifact-payload" aria-label="Fetched payload">
      {renderPayloadArm(payload)}
    </section>
  );
}

function renderPayloadArm(payload: ArtifactPayloadReading): React.JSX.Element {
  switch (payload.status) {
    case "fetching":
      return <Nothing kind="not-loaded" placement="inline" title="Loading…" />;
    case "opaque":
      return <p className="meridian-artifact-payload__note">{NO_PREVIEW_LINE}</p>;
    case "text":
      return (
        <>
          <p className="meridian-artifact-payload__note">The whole payload.</p>
          <ArtifactPayloadPreview text={payload.text} />
        </>
      );
  }
}

/** The payload text in a box that scrolls under the overlay scrollbar. */
function ArtifactPayloadPreview(props: { readonly text: string }): React.JSX.Element {
  const previewScrollbarRef = useDrawOverlayScrollbar<HTMLPreElement>(undefined, {
    start: "on-first-interaction",
  });
  return (
    // A named tab stop, so a keyboard alone can scroll text that holds nothing focusable.
    <pre
      className="meridian-artifact-payload__preview meridian-focus-inset"
      ref={previewScrollbarRef}
      tabIndex={0}
      role="group"
      aria-label="Payload text"
    >
      {/* An element, not bare text: React writes a lone text child through `textContent`, which
          would delete the scrollbar drawn inside the box. */}
      <span>{props.text}</span>
    </pre>
  );
}
