// Preview's pages on the shared tab strip: one tab per page, with the page's icon and its title
// (the host until the title arrives). It draws a reading and shows only at two or more pages, and
// carries no `+`: a page comes from the address line.

import { useMemo } from "react";

import type { PreviewPage, PreviewPageId } from "@ai-sidekicks/contracts/preview/methods";

import { TabStrip, type StripTab } from "#renderer/components/TabStrip/TabStrip.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { PageTabIcon } from "./PageTabIcon.js";
import { activePageOf, pagesOf, type PageListReading } from "../../page-list-reading.js";

/** The page reading a strip draws and the acts its controls dispatch. */
export interface PageTabStripProps {
  readonly reading: PageListReading;
  readonly onSelect: (pageId: PreviewPageId) => void;
  readonly onClose: (pageId: PreviewPageId) => void;
  /** Moves a page to `toIndex` in the list without it, answering the refusal if it was refused. */
  readonly onReorder: (pageId: PreviewPageId, toIndex: number) => Promise<Refusal | undefined>;
}

/** One tab per open page; draws nothing below two pages. */
export function PageTabStrip(props: PageTabStripProps): React.JSX.Element | null {
  const { reading, onSelect, onClose, onReorder } = props;
  const pages = pagesOf(reading);
  const clock = useClock();
  const tabs = useMemo(
    (): readonly StripTab<PreviewPageId>[] =>
      pages.map((page) => ({
        key: page.pageId,
        label: tabLabel(page),
        leading: <PageTabIcon page={page} />,
      })),
    [pages],
  );
  if (pages.length < 2) {
    return null;
  }
  return (
    <TabStrip
      tabs={tabs}
      activeKey={activePageOf(reading)?.pageId}
      clock={clock}
      onSelect={onSelect}
      onClose={onClose}
      onReorder={onReorder}
    />
  );
}

/** What a tab shows: the page's own title, then its host until the title arrives. */
function tabLabel(page: PreviewPage): string {
  return page.title.length > 0 ? page.title : page.host;
}
