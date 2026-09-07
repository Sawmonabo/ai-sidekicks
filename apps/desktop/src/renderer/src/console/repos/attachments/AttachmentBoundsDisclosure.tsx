// What can be attached, and how much — the one disclosure both surfaces that ask the
// question render.
//
// TWO SURFACES, ONE COMPONENT, AND THE SECOND ONE IS WHY IT EXISTS. The artifact pane
// carried this as a private render helper, so the ATTACH AFFORDANCE — the picker a
// person actually chooses a file with — said nothing at all about what it would accept:
// a bare file input, with the allow-list and all four bounds complete on a different
// surface one click away. `Spec-014 §Bounds (normative defaults; operator-tunable)`
// puts the hint on the picker, so the picker is where it goes, and a second copy of the
// same list would be two answers to one question the first time either changed.
//
// THE SOURCE IS NAMED, ALWAYS. An operator override replaces the list WHOLESALE with no
// merge semantics, so a hint that showed a list without saying whether it is the
// deployment's or the shipped default would be a hint about a deployment the console
// cannot see. The `shipped-default` arm additionally carries the refusal that kept the
// effective read from answering, where the caller has one.
//
// THE COUNT BOUND CARRIES WHAT HAPPENS AT IT. `Spec-014` refuses the whole carrier at
// acceptance and leaves every artifact an earlier ingest minted untouched, which is the
// difference between "your upload was wasted" and "take one off and send" — and it is
// stated here, ahead of the refusal, rather than only in the refusal's own copy. It is
// a statement of the daemon's rule and not a reading of this carrier: nothing here
// counts what is attached and no control is withdrawn.

import { Chip, DerivedFigure, WireFigure, formatByteQuantity } from "../../primitives/index.js";
import { ATTACHMENT_CHUNK_BYTE_CAP } from "../../core/index.js";
import type { AttachmentAllowlistReading } from "./attachment-bounds.js";
import { attachmentCarrierFill } from "./attachment-bounds.js";
import {
  TOO_MANY_ATTACHMENTS_CODE,
  artifactRefusalRecovery,
} from "../artifacts/artifact-refusal-copy.js";

export interface AttachmentBoundsDisclosureProps {
  readonly allowlist: AttachmentAllowlistReading;
}

/** The allow-list and the four bounds, one click away from wherever they are needed. */
export function AttachmentBoundsDisclosure(
  props: AttachmentBoundsDisclosureProps,
): React.JSX.Element {
  const { allowlist } = props;
  const maximumFigure = formatByteQuantity(allowlist.maximumByteLength);
  const chunkFigure = formatByteQuantity(ATTACHMENT_CHUNK_BYTE_CAP);
  // The count bound with nothing attached: the ALLOWANCE is what this row states, and
  // the running count against it is the affordance's own always-visible line rather
  // than something folded behind a disclosure.
  const countAllowance = attachmentCarrierFill(0).allowance;
  const wholeCarrierRefusal = artifactRefusalRecovery(TOO_MANY_ATTACHMENTS_CODE);
  return (
    <details className="meridian-ingest-bounds">
      <summary className="meridian-ingest-bounds__summary">
        What can be attached, and how much
      </summary>
      <p className="meridian-ingest-bounds__source">
        {allowlist.source === "effective"
          ? "This deployment's effective allow-list, as the daemon reports it."
          : "The shipped default. This deployment's effective list could not be read, and an operator override replaces the default wholesale rather than adding to it — so what is admitted here may differ."}
      </p>
      {allowlist.refusal === undefined ? null : (
        <p className="meridian-ingest-bounds__refusal">
          <WireFigure value={allowlist.refusal.code} /> {allowlist.refusal.detail}
        </p>
      )}
      <ul className="meridian-ingest-bounds__types">
        {allowlist.mediaTypes.map((mediaType) => (
          <li key={mediaType}>
            <Chip label={mediaType} mono />
          </li>
        ))}
      </ul>
      <dl className="meridian-ingest-bounds__caps">
        <div className="meridian-ingest-bounds__cap">
          <dt>Per attachment</dt>
          <dd>
            <WireFigure value={maximumFigure.text} title={String(allowlist.maximumByteLength)} />
          </dd>
        </div>
        <div className="meridian-ingest-bounds__cap">
          <dt>Per carrier</dt>
          <dd>
            <DerivedFigure text={`${String(countAllowance)} attachments`} />
            {wholeCarrierRefusal?.meaning === undefined ? null : (
              <span className="meridian-ingest-bounds__consequence">
                {wholeCarrierRefusal.meaning}
              </span>
            )}
          </dd>
        </div>
        <div className="meridian-ingest-bounds__cap">
          <dt>Per chunk</dt>
          <dd>
            <WireFigure value={chunkFigure.text} title={String(ATTACHMENT_CHUNK_BYTE_CAP)} />
          </dd>
        </div>
        <div className="meridian-ingest-bounds__cap">
          <dt>Per upload</dt>
          <dd>
            <DerivedFigure text="six hours from the moment the stream opens" />
          </dd>
        </div>
      </dl>
    </details>
  );
}
