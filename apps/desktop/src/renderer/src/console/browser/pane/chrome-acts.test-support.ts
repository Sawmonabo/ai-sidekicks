// A chrome act table that records instead of dispatching.
//
// Three co-located suites drive a chrome surface — the file control, the page picker,
// and the overflow control — and each needs the same thing: the real
// `BrowserChromeActs` shape, with every call recorded so a case can assert WHICH act a
// control dispatched. Written three times it would drift the moment the interface
// grows a member, and the copy that forgot it would still compile because each suite
// only reads the members it asserts on.
//
// It is a recorder and not a stub with behaviour: the acts themselves are tested where
// they are declared, and a suite that made this table do something would be testing its
// own helper.

import type { BrowserChromeActs } from "./chrome-acts.js";

/** One dispatched act: which member the surface called, and with what. */
export interface RecordedChromeAct {
  readonly member: keyof BrowserChromeActs;
  readonly argument: string | number | undefined;
}

export interface RecordingChromeActs {
  readonly acts: BrowserChromeActs;
  readonly recorded: readonly RecordedChromeAct[];
}

/**
 * A chrome act table whose every member records the call and does nothing else.
 *
 * The recorded array is the same reference throughout, so a case reads it after the
 * interaction rather than re-reading a getter.
 */
export function recordingChromeActs(): RecordingChromeActs {
  const recorded: RecordedChromeAct[] = [];
  // Two recorders and not one variadic one, because a nullary act's handler is wired
  // straight onto a control and React hands it the click event. A recorder that
  // forwarded whatever it received would put a synthetic event in `argument` for
  // exactly the acts that take none, so each recorder takes the arity its member
  // declares and nothing else reaches the record.
  const recordNullary = (member: keyof BrowserChromeActs) => (): void => {
    recorded.push({ member, argument: undefined });
  };
  const recordPageId =
    (member: keyof BrowserChromeActs) =>
    (pageId: string): void => {
      recorded.push({ member, argument: pageId });
    };
  const recordUrl =
    (member: keyof BrowserChromeActs) =>
    (url: string): void => {
      recorded.push({ member, argument: url });
    };
  const acts: BrowserChromeActs = {
    navigate: recordUrl("navigate"),
    goBack: recordNullary("goBack"),
    goForward: recordNullary("goForward"),
    reload: recordNullary("reload"),
    stopLoading: recordNullary("stopLoading"),
    selectPage: recordPageId("selectPage"),
    closePage: recordPageId("closePage"),
    createPage: recordNullary("createPage"),
    reorderPage: (pageId: string, toIndex: number): void => {
      recorded.push({ member: "reorderPage", argument: pageId });
      recorded.push({ member: "reorderPage", argument: toIndex });
    },
    showPage: recordPageId("showPage"),
    hidePage: recordNullary("hidePage"),
    openDevtools: recordPageId("openDevtools"),
    revealPageFile: recordPageId("revealPageFile"),
    pickElement: recordNullary("pickElement"),
    clearSiteData: recordNullary("clearSiteData"),
    openLocalFile: recordPageId("openLocalFile"),
  };
  return { acts, recorded };
}
