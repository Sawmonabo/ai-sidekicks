// The app's markdown trees as a suite reads them, through the app's one parser: the in-process
// stand-in in the renderer unit tier, the real worker in a browser tier.

import type { Root } from "mdast";

import { appMarkdownTrees } from "./trees.js";

/** `source`'s tree, parsed by the app's parser against `definitionPreamble`. */
export function parseTree(source: string, definitionPreamble = ""): Promise<Root> {
  return new Promise((resolve, reject) => {
    appMarkdownTrees.requestTree(source, definitionPreamble, (outcome) => {
      if (outcome.status === "failed") {
        reject(new Error(outcome.reason));
        return;
      }
      resolve(outcome.root);
    });
  });
}
