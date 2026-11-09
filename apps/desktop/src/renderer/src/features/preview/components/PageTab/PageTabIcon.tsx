// A page tab's icon slot: a spinner while the page loads, else the page's favicon, else nothing.
// The favicon arrives as bytes and is drawn from an object address over them, so nothing is
// fetched; the address is let go when the icon changes or the tab goes.

import { useEffect, useState } from "react";

import type { PreviewFavicon, PreviewPage } from "@ai-sidekicks/contracts/preview/methods";

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
  return <FaviconImage favicon={favicon} />;
}

function FaviconImage(props: { readonly favicon: PreviewFavicon }): React.JSX.Element | null {
  const { favicon } = props;
  const [address, setAddress] = useState<string | undefined>(undefined);
  useEffect(() => {
    // Copied once, since a blob takes only bytes over a plain buffer.
    const shown = URL.createObjectURL(
      new Blob([new Uint8Array(favicon.data)], { type: favicon.mediaType }),
    );
    setAddress(shown);
    return () => {
      URL.revokeObjectURL(shown);
    };
  }, [favicon]);
  if (address === undefined) {
    return null;
  }
  return <img className="meridian-preview-tab__favicon" src={address} alt="" />;
}
