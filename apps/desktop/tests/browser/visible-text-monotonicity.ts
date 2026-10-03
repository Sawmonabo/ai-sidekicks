// The visible-text monotonicity recorder: one role, for every streaming view.
//
// The reveal engine's contract is that published text never regresses. Reading the final string
// cannot check that: a lane that showed "hello wor", then "hello", then "hello world" ends
// correct and was wrong in the middle. So the subject is watched through a `MutationObserver`
// and every record is compared against the text before it.
//
// The claim is prefix growth, not length growth: a length check admits "abcde" becoming
// "vwxyz", a lane that replaced everything on screen. An out-of-band rebase, which withdraws
// published text and announces a diagnostic, is not excused here; a caller that expects one
// asserts the diagnostic and reads `regressions` for the retraction it names.
//
// It is one shared module because any view that reveals text incrementally (a row body, a tool
// result, a reasoning tail) wants the same watcher, and it is used from the browser tier because
// under a DOM shim the records come from a simulated tree, not the engine that paints.

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
 * Watch one element's visible text and record every regression. A class because the observer,
 * the last text and the findings only make sense together.
 */
export class VisibleTextMonotonicityRecorder {
  readonly #subject: HTMLElement;
  readonly #regressions: VisibleTextRegression[] = [];
  #observer: MutationObserver | undefined;
  #lastText: string;
  #recordCount = 0;

  /**
   * @param subject - The element whose text is watched. Its whole subtree is observed because
   *   a settled block is handed back by keyed remount, so text moves between nodes without the
   *   visible string changing.
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
   * Stop watching, after draining whatever the platform is still holding: a
   * `MutationObserver` delivers on a microtask, so `disconnect` alone would drop the last
   * frame's records.
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

  /** Fold in whatever the platform is holding without stopping, so no microtask turn is awaited. */
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

  /** How many records have been folded in; zero over zero records is a watcher never attached. */
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
