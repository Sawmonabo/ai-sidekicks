// A page tab's icon slot: a turning mark while the page loads, else the page's own
// icon, else nothing. The icon arrives as the image's bytes, so it is drawn from a
// `data:` address and nothing is fetched. Styled by `PageTabStrip.css`, which the strip
// imports.

import type { PreviewPage } from "@ai-sidekicks/contracts";

/** The page whose icon slot is drawn. */
export interface PageTabIconProps {
  readonly page: PreviewPage;
}

/** The icon slot of one page tab. */
export function PageTabIcon(props: PageTabIconProps): React.JSX.Element | null {
  const { loadState, favicon } = props.page;
  if (loadState.kind === "loading") {
    return (
      <>
        <span className="meridian-preview-tab__spinner" aria-hidden="true" />
        <span className="meridian-visually-hidden">Loading</span>
      </>
    );
  }
  if (favicon === null) {
    return null;
  }
  return (
    <img
      className="meridian-preview-tab__favicon"
      src={`data:${favicon.mediaType};base64,${favicon.data}`}
      alt=""
    />
  );
}
