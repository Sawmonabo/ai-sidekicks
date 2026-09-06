// A sidebar board a test owns, with this family's sections already filled.
//
// `registerCollaborationSections` takes the board it writes into, so every test that
// needs a filled section has to build one first. That is two lines, and five call
// sites repeating them is five places to get the ownership wrong — the failure being
// silent, because reaching for `sidebarSectionRegistry` instead still passes while
// leaking one test's registration into the next one's assertions.
//
// One builder, so the board a test asserts against is always the board that test
// filled.

import { SidebarSectionRegistry } from "../seats/index.js";
import { registerCollaborationSections } from "./sections.js";

/** A fresh sidebar board carrying this family's sections and nothing else. */
export function sectionsRegisteredForTest(): SidebarSectionRegistry {
  const sections = new SidebarSectionRegistry();
  registerCollaborationSections(sections);
  return sections;
}
