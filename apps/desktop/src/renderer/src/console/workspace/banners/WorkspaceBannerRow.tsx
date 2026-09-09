// One raised refusal as the workspace renders it: the banner, and the count of the
// raises it stands for.
//
// Its own module rather than a second component inside `Workspace.tsx`, which is the
// console's standing rule — one component per module — and which the workspace's own
// surface would otherwise be the exception to.
//
// THE COUNT SITS BESIDE THE BANNER rather than inside it. `RefusalBanner` renders the
// code verbatim and the daemon's sentence unedited; a repeat count is neither. It is
// the console's own reading of how many times this room heard the same refusal, so it
// takes the derived figure's proportional face rather than the wire's mono one, and it
// is absent entirely at one — a "×1" would read as a figure about the refusal.

import { DerivedFigure, RefusalBanner } from "../../primitives/index.js";
import { workspaceBannerKey, type WorkspaceBanner } from "./workspace-banners.js";

/** One banner row, dismissed by the key the fold counted it under. */
export function WorkspaceBannerRow(props: {
  readonly banner: WorkspaceBanner;
  readonly onDismiss: (key: string) => void;
}): React.JSX.Element {
  const { refusal, repeatCount } = props.banner;
  return (
    <div className="meridian-workspace__banner">
      <RefusalBanner
        code={refusal.code}
        detail={refusal.detail}
        onDismiss={() => {
          props.onDismiss(workspaceBannerKey(refusal));
        }}
      />
      {repeatCount > 1 ? <DerivedFigure text={`×${String(repeatCount)}`} /> : null}
    </div>
  );
}
