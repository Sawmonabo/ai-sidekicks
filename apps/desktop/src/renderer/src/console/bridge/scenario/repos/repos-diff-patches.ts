// The two unified patches the repos scenario's diff artifacts carry.
//
// A MODULE OF THEIR OWN, because patch TEXT is bulk and the replies beside it are
// rules. `repos-diff-replies.ts` decides which arm answers with which artifact and what
// a request the scenario does not recognise is refused as; this file is the payload
// those answers hand back, and holding both together would have made a forty-line
// decision table read as a footnote to two hundred lines of literal text.
//
// THEY ARE REAL PATCHES AND NOT SKETCHES. `repos/diff-pane/patch-parse.ts` refuses a
// patch whose `@@` header count disagrees with the hunk count it parses, and it reads
// the extended headers a git patch states above its hunks — so a fixture writing
// approximate text would either be refused outright or would draw a file the parser
// could say nothing about. Each one below is the shape `git diff` emits, `diff --git`
// line included, and between them they cover the four extended-header facts the model
// carries: an ordinary textual change, a rename, a mode change, and a binary file.
//
// AND THEY SAY SOMETHING TRUE ABOUT THE SCENARIO. The run-attributed patch is the work
// the implementer's run did on the branch the worktree row names, taken between that
// root's branch context's own base and head; the workspace-fallback patch is a change
// sitting in the git workspace's own checkout, ahead of the shared branch, with no run
// to attribute it to — which is the condition that makes the
// fallback attribution mean: precise run attribution is unavailable, so the artifact is
// workspace-level and labelled as such. `repos-diff-replies.ts` scripts the ref pair
// each of these two is the comparison of, and answers no other pair.

/**
 * The change set the implementer's run produced, as `gitflow.diffArtifactCreate`
 * answers for the `run_attributed` arm.
 *
 * Two files and three hunks, one of them a rename with no textual change at all — the
 * case a renderer deriving its file notes from `hunks.length` reports as nothing
 * having happened.
 */
export const RUN_ATTRIBUTED_DIFF_PATCH: string = `diff --git a/packages/runtime-daemon/src/rate-limit/lease-store.ts b/packages/runtime-daemon/src/rate-limit/lease-store.ts
index 1f0a3c9..8b41d02 100644
--- a/packages/runtime-daemon/src/rate-limit/lease-store.ts
+++ b/packages/runtime-daemon/src/rate-limit/lease-store.ts
@@ -14,9 +14,12 @@ export class SubscriptionLeaseStore {
   readonly #capacity: number;

   public async claim(sessionId: string): Promise<LeaseClaim> {
-    const held = await this.#count(sessionId);
-    if (held >= this.#capacity) {
-      return { status: "refused", code: "ratelimit.exceeded" };
-    }
-    return { status: "granted", leaseId: this.#insert(sessionId) };
+    return this.#state.blockConcurrencyWhile(async () => {
+      await this.#pruneExpired(sessionId);
+      const held = await this.#count(sessionId);
+      if (held >= this.#capacity) {
+        return { status: "refused", code: "ratelimit.exceeded" };
+      }
+      return { status: "granted", leaseId: this.#insert(sessionId) };
+    });
   }
@@ -41,6 +43,7 @@ export class SubscriptionLeaseStore {
   }

   async #pruneExpired(sessionId: string): Promise<void> {
+    // The alarm re-arms itself, so a store with no traffic still sheds its rows.
     await this.#rows.delete({ sessionId, expiredBefore: this.#clock.now() });
   }
 }
diff --git a/packages/runtime-daemon/src/rate-limit/lease-clock.ts b/packages/runtime-daemon/src/rate-limit/lease-timing.ts
similarity index 100%
rename from packages/runtime-daemon/src/rate-limit/lease-clock.ts
rename to packages/runtime-daemon/src/rate-limit/lease-timing.ts
`;

/**
 * The change sitting in the git workspace's own checkout ahead of the shared branch,
 * as the same call answers for the `workspace_fallback` arm.
 *
 * Three files: a textual change, a mode change with no hunks, and a binary file the
 * patch declares and carries no text for. The last two are the reason `DiffFile` has
 * extended-header members at all — a file with no hunks is a file something happened
 * to, and both of these say what.
 */
export const WORKSPACE_FALLBACK_DIFF_PATCH: string = `diff --git a/apps/desktop/src/renderer/src/console/repos/repos.css b/apps/desktop/src/renderer/src/console/repos/repos.css
index 4c1e8a7..d90fe31 100644
--- a/apps/desktop/src/renderer/src/console/repos/repos.css
+++ b/apps/desktop/src/renderer/src/console/repos/repos.css
@@ -3,7 +3,7 @@
 .meridian-repo-section {
   display: flex;
   flex-direction: column;
-  gap: var(--meridian-space-2);
+  gap: var(--meridian-space-3);
 }

 .meridian-repo-section__summary {
diff --git a/scripts/prepare-execution-root.sh b/scripts/prepare-execution-root.sh
old mode 100644
new mode 100755
diff --git a/apps/desktop/resources/icon.png b/apps/desktop/resources/icon.png
index 6f1b2c8..a3d90e4 100644
Binary files a/apps/desktop/resources/icon.png and b/apps/desktop/resources/icon.png differ
`;
