// One raised refusal as the session screen renders it: the banner, and the count of the
// raises it stands for.
//
// Its own module rather than a second component inside `SessionScreen.tsx`, which is the
// console's standing rule — one component per module — and which the session screen
// would otherwise be the exception to.
//
// THE COUNT SITS BESIDE THE BANNER rather than inside it. `RefusalBanner` renders the
// code verbatim and the daemon's sentence unedited; a repeat count is neither. It is
// the console's own reading of how many times this room heard the same refusal, so it
// takes the derived figure's proportional face rather than the wire's mono one, and it
// is absent entirely at one — a "×1" would read as a figure about the refusal.

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { RefusalBanner } from "@renderer/components/Refusal/RefusalBanner.js";
import { sessionBannerKey, type SessionBanner } from "../session-banners.js";

/** One banner row, dismissed by the key the fold counted it under. */
export function SessionBannerRow(props: {
  readonly banner: SessionBanner;
  readonly onDismiss: (key: string) => void;
}): React.JSX.Element {
  const { refusal, repeatCount } = props.banner;
  return (
    <div className="meridian-session-screen__banner">
      <RefusalBanner
        code={refusal.code}
        detail={refusal.detail}
        onDismiss={() => {
          props.onDismiss(sessionBannerKey(refusal));
        }}
      />
      {repeatCount > 1 ? <DerivedFigure text={`×${String(repeatCount)}`} /> : null}
    </div>
  );
}
