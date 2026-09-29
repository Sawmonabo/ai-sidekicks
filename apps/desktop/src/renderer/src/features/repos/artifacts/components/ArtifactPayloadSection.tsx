// What the payload fetch established, on whichever of its arms it is.
//
// A component of its own because its subject is the fetched bytes: four arms of one
// reading, none of which stands in for another, and a preview whose whole safety argument
// lives in one place.
//
// The preview is text, and only text. The decoded bytes go into a `<pre>` as a text node
// React escapes, bounded before they get here, with the truncation stated beside them.
// Nothing in this module can interpret a payload: there is no `dangerously` anything, no
// `src`, no `href`, and no element that a media type could turn into a document.

import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "@renderer/store/artifacts/artifact-payload.js";
import "./artifact.css";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { ArtifactPayloadReading } from "@renderer/store/artifacts/artifact-payload.js";

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

/** The one arm's own body. Total over the arms a payload can be on. */
function renderPayloadArm(payload: ArtifactPayloadReading): React.JSX.Element {
  switch (payload.status) {
    case "fetching":
      return <Nothing kind="not-loaded" placement="inline" title="Fetching this payload" />;
    case "deferred":
      return (
        <>
          <p className="meridian-artifact-payload__note">
            The read answered with a handle rather than the bytes. It is the content-addressed key
            the payload is stored under.
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
