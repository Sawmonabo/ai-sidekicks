// A page tab's icon slot: a spinner while the page loads, else the page's favicon, else nothing.
// The favicon arrives as bytes and is drawn from a `data:` address, so nothing is fetched.

import type { PreviewPage } from "@ai-sidekicks/contracts/preview";

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
