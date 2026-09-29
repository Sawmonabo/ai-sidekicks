import { vi, type Mock } from "vitest";

import type { PaneLayoutActs } from "./pane-layout-acts.js";

/** A fresh set of spying acts. */
export function createSpyingPaneLayoutActs(): SpyingPaneLayoutActs {
  return {
    focusNextPane: vi.fn<() => void>(),
    focusPreviousPane: vi.fn<() => void>(),
    closeFocusedPane: vi.fn<() => void>(),
    moveFocusedPaneLeft: vi.fn<() => void>(),
    moveFocusedPaneRight: vi.fn<() => void>(),
  };
}

/** One pane layout's acts, each a spy, so a case can say which layout performed. */
interface SpyingPaneLayoutActs extends PaneLayoutActs {
  readonly focusNextPane: Mock<() => void>;
  readonly focusPreviousPane: Mock<() => void>;
  readonly closeFocusedPane: Mock<() => void>;
  readonly moveFocusedPaneLeft: Mock<() => void>;
  readonly moveFocusedPaneRight: Mock<() => void>;
}
