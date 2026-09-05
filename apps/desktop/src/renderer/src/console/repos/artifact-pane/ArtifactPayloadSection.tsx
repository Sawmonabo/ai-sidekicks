// What the payload fetch established, on whichever of its six arms it is.
//
// A COMPONENT OF ITS OWN RATHER THAN A HELPER IN THE PANE, because the pane was over
// the size at which one module is doing two jobs and this is the half with its own
// subject: six arms of one reading, none of which stands in for another, and a preview
// whose whole safety argument lives in one place.
//
// THE PREVIEW IS TEXT, AND ONLY TEXT. The decoded bytes go into a `<pre>` as a text node
// React escapes, bounded before they get here, with the truncation stated beside them.
// Nothing in this module can interpret a payload: there is no `dangerously` anything, no
// `src`, no `href`, and no element that a media type could turn into a document.

import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-bounds.js";
import { Nothing, RefusalCard, WireFigure } from "../../primitives/index.js";
import type { ArtifactPayloadReading } from "./artifact-payload.js";

export interface ArtifactPayloadSectionProps {
  readonly payload: ArtifactPayloadReading;
}

/** The section, or nothing at all where nobody has asked for any bytes. */
export function ArtifactPayloadSection({
  payload,
}: ArtifactPayloadSectionProps): React.JSX.Element | null {
  if (payload.status === "not-checked") {
    return null;
  }
  return (
    <section className="meridian-artifact-payload" aria-label="Fetched payload">
      {renderPayloadArm(payload)}
    </section>
  );
}

/** The one arm's own body. Total over the five arms a rendered payload can be on. */
function renderPayloadArm(payload: ArtifactPayloadReading): React.JSX.Element | null {
  switch (payload.status) {
    case "not-checked":
      return null;
    case "fetching":
      return <Nothing kind="not-loaded" placement="inline" title="Fetching this payload" />;
    case "refused":
      return <RefusalCard code={payload.refusal.code} detail={payload.refusal.detail} />;
    case "deferred":
      return (
        <>
          <p className="meridian-artifact-payload__note">
            The read answered with a handle rather than the bytes. It is the content-addressed key
            the payload is stored under, and no registered operation anywhere takes one — so the
            bytes are named here and not checked for.
          </p>
          <WireFigure value={payload.payloadHandle} />
        </>
      );
    case "opaque":
      return (
        <p className="meridian-artifact-payload__note">
          {payload.reason === "not-utf8"
            ? "These bytes are not text, so there is nothing to preview. They arrived whole and are unchanged."
            : "These bytes did not decode under the encoding the reply declared, so there is nothing to preview."}{" "}
          <WireFigure value={payload.encoding} />
        </p>
      );
    case "text":
      return (
        <>
          <p className="meridian-artifact-payload__note">
            {payload.truncated
              ? `The first ${String(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP)} characters. The payload continues past them.`
              : "The whole payload."}{" "}
            <WireFigure value={payload.encoding} />
          </p>
          <pre className="meridian-artifact-payload__preview">{payload.text}</pre>
        </>
      );
  }
}
