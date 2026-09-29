// The visible-text monotonicity recorder — one role, for every streaming surface.
//
// WHAT IT CLAIMS, AND WHY IT IS A RECORDER RATHER THAN AN ASSERTION. The reveal
// engine's contract is that published text never regresses, and the honest way to
// check that is not to read the final string: a lane that showed "hello wor", then
// "hello", then "hello world" ends correct and was wrong in the middle, and nothing
// that samples the end can tell the two apart. So the subject is watched through a
// `MutationObserver` and every record is compared against the text before it — the
// per-mutation-record claim the streaming stack is specified to hold.
//
// THE CLAIM IS PREFIX-GROWTH, NOT LENGTH-GROWTH. A length comparison admits
// "abcde" becoming "vwxyz", which is a lane that replaced everything on screen and
// grew by nothing; prefix-growth is what "the reader's eye keeps its place" means,
// and it implies the length claim. The one declared exception the engine documents
// — an out-of-band rebase, which withdraws published text and announces a
// diagnostic — is deliberately NOT excused here: a caller that expects one asserts
// the diagnostic and reads `regressions` for the retraction it names, so the
// exception stays visible instead of being folded into the rule.
//
// WHY IT LIVES BESIDE THE TIER DIRECTORIES RATHER THAN INSIDE ONE. It is a console
// test ROLE, and `apps/desktop/AGENTS.md` puts roles in the flat files of
// `test/console/`: any surface that reveals text incrementally — a row body, a tool
// result, a reasoning tail — wants this same watcher, and a second copy under a
// tier directory is the duplicate that file rejects.
//
// IT IS A BROWSER-TIER ROLE IN PRACTICE, and the reason is the same one
// `vitest.config.ts` gives for splitting the tiers at all: under a DOM shim the
// records arrive from a simulated tree, so a green run says the shim delivered what
// the shim was asked to. Under real Chromium the records come from the engine that
// actually paints.

/** One place the visible text went backwards, with the record that carried it. */
export interface VisibleTextRegression {
  /** What was on screen before the record. */
  readonly before: string;
  /** What the record left on screen. */
  readonly after: string;
  /** `characterData`, `childList`, or `attributes`, from the record itself. */
  readonly mutationKind: MutationRecordType;
}

/**
 * Watch one element's visible text and record every regression.
 *
 * A class rather than a pair of functions because the watcher owns three pieces of
 * state that only make sense together — the observer, the last text, and the
 * findings — and a module holding them would be the module-level mutable the
 * structure rules reject.
 */
export class VisibleTextMonotonicityRecorder {
  readonly #subject: HTMLElement;
  readonly #regressions: VisibleTextRegression[] = [];
  #observer: MutationObserver | undefined;
  #lastText: string;
  #recordCount = 0;

  /**
   * @param subject - The element whose text is watched. Its whole subtree is
   *   observed, because a settled block is handed back by keyed remount and the
   *   text therefore moves between nodes without the visible string changing.
   */
  public constructor(subject: HTMLElement) {
    this.#subject = subject;
    this.#lastText = subject.textContent ?? "";
  }

  /** Begin watching. Idempotent: a second call keeps the one observer. */
  public start(): void {
    if (this.#observer !== undefined) {
      return;
    }
    const observer = new MutationObserver((records) => {
      this.#takeRecords(records);
    });
    observer.observe(this.#subject, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    this.#observer = observer;
  }

  /**
   * Stop watching, after draining whatever the platform is still holding.
   *
   * `takeRecords` is what makes the drain honest: a `MutationObserver` delivers on a
   * microtask, so records queued by the last mutation before a `disconnect` are
   * dropped — and dropping exactly the last frame's records is dropping the frame a
   * regression is most likely to be in.
   */
  public stop(): void {
    const observer = this.#observer;
    if (observer === undefined) {
      return;
    }
    this.#takeRecords(observer.takeRecords());
    observer.disconnect();
    this.#observer = undefined;
  }

  /**
   * Fold in whatever the platform is holding without stopping.
   *
   * The caller between two frames wants the records of the first frame before it
   * drives the second, and waiting for a microtask turn to get them makes the test
   * depend on scheduling rather than on the subject.
   */
  public drain(): void {
    const observer = this.#observer;
    if (observer !== undefined) {
      this.#takeRecords(observer.takeRecords());
    }
  }

  /** Every regression seen so far, oldest first. Empty is the passing reading. */
  public get regressions(): readonly VisibleTextRegression[] {
    return this.#regressions;
  }

  /**
   * How many records have been folded in.
   *
   * The negative control every clean result needs: zero regressions over zero
   * records is a watcher that was never attached, and a case that does not read
   * this cannot tell that apart from a lane that behaved.
   */
  public get recordCount(): number {
    return this.#recordCount;
  }

  /** The text the last folded record left on screen. */
  public get visibleText(): string {
    return this.#lastText;
  }

  #takeRecords(records: readonly MutationRecord[]): void {
    for (const record of records) {
      this.#recordCount += 1;
      const before = this.#lastText;
      const after = this.#subject.textContent ?? "";
      if (!after.startsWith(before)) {
        this.#regressions.push({ before, after, mutationKind: record.type });
      }
      this.#lastText = after;
    }
  }
}
