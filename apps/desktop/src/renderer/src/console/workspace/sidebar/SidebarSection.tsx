// One sidebar section: a real button in tab order, and its body only while it is open.
//
// Its own module for the one-component rule, and the disclosure contract is what the
// split makes legible: `aria-expanded` on the button, `aria-controls` naming the
// region it opens, and the body mounted inside that region rather than hidden with
// CSS — hiding it would leave the section's read running behind the fold.

import type { ConsoleBridge } from "../../bridge/index.js";
import { Nothing } from "../../primitives/index.js";
import { type SessionStore } from "../../store/index.js";
import {
  type ConsolePaneOpener,
  type SidebarSectionId,
  type SidebarSectionRegistry,
} from "../../seats/index.js";
import {
  SECTION_HEADER_ATTRIBUTE,
  SIDEBAR_SECTION_LABELS,
  type SidebarSectionAttention,
} from "./sidebar-model.js";

export interface SidebarSectionProps {
  readonly sectionId: SidebarSectionId;
  readonly isOpen: boolean;
  readonly attention: SidebarSectionAttention | undefined;
  readonly registry: SidebarSectionRegistry;
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  readonly openPane: ConsolePaneOpener;
  readonly onPress: (sectionId: SidebarSectionId) => void;
}

/** The section's header, and its body only while it is open. */
export function SidebarSection(props: SidebarSectionProps): React.JSX.Element {
  const { sectionId } = props;
  const headerId = `meridian-sidebar-header-${sectionId}`;
  const regionId = `meridian-sidebar-region-${sectionId}`;
  const render = props.registry.descriptorFor(sectionId)?.render;

  return (
    <li className="meridian-sidebar__section">
      <button
        type="button"
        id={headerId}
        className="meridian-sidebar__header"
        aria-expanded={props.isOpen}
        aria-controls={regionId}
        {...{ [SECTION_HEADER_ATTRIBUTE]: sectionId }}
        {...(props.attention === undefined ? {} : { "data-attention": props.attention })}
        onClick={() => {
          props.onPress(sectionId);
        }}
      >
        {SIDEBAR_SECTION_LABELS[sectionId]}
      </button>
      {!props.isOpen ? null : (
        <div
          id={regionId}
          role="region"
          aria-labelledby={headerId}
          className="meridian-sidebar__body"
        >
          {render === undefined ? (
            <Nothing
              kind="not-checked"
              placement="surface"
              title="Nothing has filled this section yet."
              detail="No part of this console has registered a body for it in this window, so nothing has been asked."
            />
          ) : (
            render({
              sessionStore: props.sessionStore,
              bridge: props.bridge,
              openPane: props.openPane,
              isOpen: true,
            })
          )}
        </div>
      )}
    </li>
  );
}
