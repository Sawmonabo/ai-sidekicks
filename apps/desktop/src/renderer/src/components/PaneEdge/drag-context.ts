// Whether one of the pane edges around a view is being dragged, carried as React context. The pane
// layout provides it around the conversation, whose transcript holds its follow of the bottom
// while it is on, so text arriving mid-drag cannot pull the text under the hand.

import { createContext } from "react";

/** Whether a pane edge or the stack divider is being dragged; `false` outside any pane layout. */
export const PaneEdgeDragContext: React.Context<boolean> = createContext(false);
