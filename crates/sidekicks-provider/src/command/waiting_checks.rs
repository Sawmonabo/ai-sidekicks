//! Whether a running command waits for input, read on a schedule armed by its last output: cheap
//! checks 50, 100 and 200 ms after it and then every 500 ms, and once one passes the full read 1 s
//! later, the gaps doubling to 60 s and never more than six reads a minute; any output starts the
//! schedule over, so nothing is read while output flows. A command is marked waiting on the
//! system's word that it blocks reading its terminal, or that it waits in `select` or `poll`
//! there when its last output line reads as a prompt.

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use regex::RegexSet;
use sidekicks_platforms::{
    InputTerminal, InputWaitReading, Spawner, may_wait_for_input, read_input_wait,
};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// The cheap checks' delays after the last output; past the last, one comes every gap.
const CHEAP_CHECK_DELAYS: [Duration; 3] = [
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
];

/// The gap between cheap checks past their delays.
const CHEAP_CHECK_GAP: Duration = Duration::from_millis(500);

/// How long after a passed cheap check the first full read comes.
const FIRST_FULL_READ_DELAY: Duration = Duration::from_secs(1);

/// The longest gap the full reads' doubling reaches.
const LONGEST_FULL_READ_GAP: Duration = Duration::from_secs(60);

/// The most full reads in any minute.
const FULL_READS_A_MINUTE: usize = 6;

/// The minute the full reads are counted over.
const FULL_READ_WINDOW: Duration = Duration::from_secs(60);

/// The prompt endings a last line reads as: the editor's nine specific ones and its two broad
/// ones, then the agent's seven, each as the source spells it, case folded only where it was.
static PROMPT_LINE: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r#"\s*(?:\[[^\]]\][^\[]*)+(?:\(default is\s+"[^"]+"\):)?\s+$"#,
        r"(?i)(?:\(|\[)\s*(?:y(?:es)?\s*/\s*n(?:o)?|n(?:o)?\s*/\s*y(?:es)?)\s*(?:\]|\))\s+$",
        r"(?i)[?:]\s*(?:\(|\[)?\s*y(?:es)?\s*/\s*n(?:o)?\s*(?:\]|\))?\s+$",
        r"(?i)\(y\) +$",
        r":\s+\([^)]*\) +$",
        r"\(END\)$",
        r"(?i)password(?: for [^:]+)?:\s*$",
        r"(?i)press a(?:ny)? key",
        r"^(?:\s|\x1b\[[0-9;]*m)*\?.*[›❯▸▶]\s*$",
        r": +$",
        r"(?i)\? *(?:\([a-z\s]+\))? +$",
        r"(?i)\(y/n\)",
        r"(?i)\[y/n\]",
        r"(?i)\(yes/no\)",
        r"(?i)\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$",
        r"(?i)Press (?:any key|Enter)",
        r"(?i)Continue\?",
        r"(?i)Overwrite\?",
    ])
    .expect("the prompt patterns are valid")
});

/// When the cheap check numbered `checks_done` comes after the last output: 50, 100 and 200 ms,
/// then every 500 ms.
pub(crate) fn cheap_check_delay(checks_done: usize) -> Duration {
    if let Some(delay) = CHEAP_CHECK_DELAYS.get(checks_done) {
        return *delay;
    }
    let past = u32::try_from(checks_done + 1 - CHEAP_CHECK_DELAYS.len()).unwrap_or(u32::MAX);
    CHEAP_CHECK_DELAYS[CHEAP_CHECK_DELAYS.len() - 1] + CHEAP_CHECK_GAP * past
}

/// The line `output` leaves the cursor on, as a terminal shows it: its trailing line ends taken
/// off, the text after its last line break, then after its last carriage return, every escape
/// sequence removed.
fn last_line(output: &str) -> String {
    let ended = output.trim_end_matches(['\r', '\n']);
    let line = ended.rsplit('\n').next().unwrap_or(ended);
    let shown = line.rsplit('\r').next().unwrap_or(line);
    console::strip_ansi_codes(shown).into_owned()
}

/// Whether `line`, a last line as [`last_line`] reads it, reads as a prompt.
fn reads_as_prompt(line: &str) -> bool {
    PROMPT_LINE.is_match(line)
}

/// Whether a command whose wait reads `reading`, its output ending in `output_tail`, waits for
/// input: blocked reading its terminal, or waiting in `select` or `poll` with a prompt for its
/// last line.
fn is_marked_waiting(reading: InputWaitReading, output_tail: &str) -> bool {
    reading.is_waiting || (reading.is_waiting_in_select && reads_as_prompt(&last_line(output_tail)))
}

/// Which read a check makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckKind {
    /// The cheap read that rules a wait out.
    Cheap,
    /// The full read that says where the command waits.
    Full,
}

/// When the next check comes and which it is, as the last output, the checks so far and the full
/// reads of the last minute set it.
struct CheckSchedule {
    /// The last output, which the cheap checks count from.
    armed_at: Instant,
    cheap_checks_done: usize,
    /// The next full read and the gap that set it, once a cheap check passed.
    next_full_read: Option<(Instant, Duration)>,
    /// The full reads of the last minute, oldest first.
    full_reads: VecDeque<Instant>,
}

impl CheckSchedule {
    fn new(now: Instant) -> Self {
        Self {
            armed_at: now,
            cheap_checks_done: 0,
            next_full_read: None,
            full_reads: VecDeque::new(),
        }
    }

    /// Starts the schedule over from output printed at `now`; the minute's full reads still
    /// count.
    fn output_printed(&mut self, now: Instant) {
        self.armed_at = now;
        self.cheap_checks_done = 0;
        self.next_full_read = None;
    }

    /// The next check and when it comes; a full read waits until the minute holds fewer than six.
    fn next_check(&self) -> (Instant, CheckKind) {
        match self.next_full_read {
            Some((due, _)) => {
                let room = (self.full_reads.len() >= FULL_READS_A_MINUTE)
                    .then(|| {
                        self.full_reads
                            .front()
                            .map(|oldest| *oldest + FULL_READ_WINDOW)
                    })
                    .flatten();
                (room.map_or(due, |room| room.max(due)), CheckKind::Full)
            }
            None => (
                self.armed_at + cheap_check_delay(self.cheap_checks_done),
                CheckKind::Cheap,
            ),
        }
    }

    /// Counts a cheap check made at `now`, which arms the first full read when it `passed`.
    fn cheap_checked(&mut self, now: Instant, passed: bool) {
        self.cheap_checks_done += 1;
        if passed {
            self.next_full_read = Some((now + FIRST_FULL_READ_DELAY, FIRST_FULL_READ_DELAY));
        }
    }

    /// Counts a full read made at `now` and arms the next at twice the gap, at most a minute.
    fn full_read(&mut self, now: Instant) {
        self.full_reads.push_back(now);
        while self
            .full_reads
            .front()
            .is_some_and(|oldest| now.duration_since(*oldest) >= FULL_READ_WINDOW)
        {
            self.full_reads.pop_front();
        }
        let gap = self
            .next_full_read
            .map_or(FIRST_FULL_READ_DELAY, |(_, gap)| gap * 2)
            .min(LONGEST_FULL_READ_GAP);
        self.next_full_read = Some((now + gap, gap));
    }
}

/// Reads whether a command waits on its terminal: the cheap read that may rule a wait out, and the
/// full read.
pub(crate) trait InputWaitReader: Send + Sync {
    /// Whether the command may wait on `terminal`; `false` rules a wait out. Fails when the system
    /// refuses a read.
    fn may_wait<'a>(&'a self, terminal: &'a InputTerminal) -> BoxFuture<'a, io::Result<bool>>;

    /// Where the command waits on `terminal`. Fails when the system refuses a read.
    fn read<'a>(
        &'a self,
        terminal: &'a InputTerminal,
    ) -> BoxFuture<'a, io::Result<InputWaitReading>>;
}

/// The reads the platforms crate makes, its helper programs started on the daemon's one spawner.
#[expect(
    dead_code,
    reason = "the daemon's start hands it to each conversation's channel"
)]
pub(crate) struct SystemInputWaitReader {
    /// The thread every helper program starts from.
    pub(crate) spawner: Spawner,
}

impl InputWaitReader for SystemInputWaitReader {
    fn may_wait<'a>(&'a self, terminal: &'a InputTerminal) -> BoxFuture<'a, io::Result<bool>> {
        may_wait_for_input(&self.spawner, terminal).boxed()
    }

    fn read<'a>(
        &'a self,
        terminal: &'a InputTerminal,
    ) -> BoxFuture<'a, io::Result<InputWaitReading>> {
        read_input_wait(&self.spawner, terminal).boxed()
    }
}

/// What a check found: whether the command waits for input, and whether its echo is off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WaitingState {
    /// Whether the command waits for input.
    pub(crate) is_waiting: bool,
    /// Whether the terminal's echo is off.
    pub(crate) is_echo_off: bool,
}

/// What the checks read from: how many outputs came, and the terminal and output tail the
/// command's wrapper last reported.
#[derive(Clone, Default)]
struct CheckInputs {
    outputs: u64,
    terminal: Option<InputTerminal>,
    output_tail: String,
}

/// One command's checks, run as a task until it drops.
pub(crate) struct WaitingChecks {
    inputs: watch::Sender<CheckInputs>,
    checking: JoinHandle<()>,
}

impl WaitingChecks {
    /// Starts the checks, reading through `reader` and handing each finding to `on_state`; they
    /// read nothing until the command's terminal is reported.
    pub(crate) fn start(
        reader: Arc<dyn InputWaitReader>,
        on_state: impl Fn(WaitingState) + Send + 'static,
    ) -> Self {
        let (inputs, followed) = watch::channel(CheckInputs::default());
        let checking = tokio::spawn(run_checks(reader, followed, on_state));
        Self { inputs, checking }
    }

    /// Starts the schedule over: the command printed output.
    pub(crate) fn output_printed(&self) {
        self.inputs.send_modify(|inputs| inputs.outputs += 1);
    }

    /// Takes the command's terminal as its wrapper last read it and the tail of its output.
    pub(crate) fn terminal_read(&self, terminal: InputTerminal, output_tail: String) {
        self.inputs.send_modify(|inputs| {
            inputs.terminal = Some(terminal);
            inputs.output_tail = output_tail;
        });
    }
}

impl Drop for WaitingChecks {
    fn drop(&mut self) {
        self.checking.abort();
    }
}

// Runs one command's checks on their schedule until the inputs' sender drops.
async fn run_checks(
    reader: Arc<dyn InputWaitReader>,
    mut followed: watch::Receiver<CheckInputs>,
    on_state: impl Fn(WaitingState),
) {
    let mut schedule = CheckSchedule::new(Instant::now());
    let mut outputs_seen = 0;
    loop {
        let (due, kind) = schedule.next_check();
        tokio::select! {
            () = tokio::time::sleep_until(due) => {}
            changed = followed.changed() => {
                if changed.is_err() {
                    return;
                }
                let inputs = followed.borrow_and_update().clone();
                if inputs.outputs != outputs_seen {
                    outputs_seen = inputs.outputs;
                    schedule.output_printed(Instant::now());
                    on_state(WaitingState {
                        is_waiting: false,
                        is_echo_off: inputs
                            .terminal
                            .is_some_and(|terminal| !terminal.master.is_echo_on),
                    });
                }
                continue;
            }
        }
        let inputs = followed.borrow().clone();
        let now = Instant::now();
        let Some(terminal) = inputs.terminal else {
            schedule.cheap_checked(now, false);
            continue;
        };
        let is_echo_off = !terminal.master.is_echo_on;
        match kind {
            CheckKind::Cheap => {
                let passed = reader.may_wait(&terminal).await.unwrap_or_else(|error| {
                    tracing::debug!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a command's input wait could not be read"
                    );
                    false
                });
                schedule.cheap_checked(now, passed);
                if !passed {
                    on_state(WaitingState {
                        is_waiting: false,
                        is_echo_off,
                    });
                }
            }
            CheckKind::Full => {
                schedule.full_read(now);
                match reader.read(&terminal).await {
                    Ok(reading) => on_state(WaitingState {
                        is_waiting: is_marked_waiting(reading, &inputs.output_tail),
                        is_echo_off: reading.is_echo_off,
                    }),
                    Err(error) => tracing::debug!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a command's input wait could not be read"
                    ),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::Read as _;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use sidekicks_platforms::{
        InputTerminal, InputWaitReading, POSIX_SHELL, SELECT_READER_SCRIPT, Spawner,
        TerminalDevice, TerminalMasterReading, blocking_terminal_master, read_input_wait,
        read_terminal_master, start_inner_terminal, terminal_options,
    };
    use sidekicks_std::mutex_lock::lock;
    use tokio::time::Instant;

    use super::{
        CheckKind, InputWaitReader, WaitingChecks, is_marked_waiting, last_line, reads_as_prompt,
    };

    // Fails when the trailing line ends are kept (the `\n` row), when a carriage return is deleted
    // rather than the text before it dropped (the `50%` row), or when one family is dropped.
    #[rstest]
    #[case::yes_no_parens("Continue? (y/n) ", true)]
    #[case::yes_no_brackets("Overwrite? [Y/n]", true)]
    #[case::password("Password: ", true)]
    #[case::default_in_parens("package name: (test) ", true)]
    #[case::pager_end("(END)", true)]
    #[case::are_you_sure("Are you sure you want to delete it? ", true)]
    #[case::press_enter("Press Enter to continue", true)]
    #[case::picker("? Pick a color \u{203a} ", true)]
    #[case::colon("Enter your name: ", true)]
    #[case::ended_by_a_line_break("Continue? (y/n)\n", true)]
    #[case::redrawn_over_progress("50%\r? Pick a color \u{203a} ", true)]
    #[case::colored_picker("\u{1b}[32m?\u{1b}[0m Pick one \u{276f} ", true)]
    #[case::done("done.", false)]
    #[case::percent("100%", false)]
    #[case::log_line("[INFO] Starting", false)]
    #[case::question_then_arrow("What happened? \u{203a}", false)]
    #[case::prompt_scrolled_away("Password: \nok", false)]
    #[case::nothing("", false)]
    fn a_last_line_reads_as_a_prompt_only_where_a_peer_reads_one(
        #[case] output: &str,
        #[case] is_prompt: bool,
    ) {
        assert_eq!(reads_as_prompt(&last_line(output)), is_prompt, "{output:?}");
    }

    /// A reader that may always wait and never waits, noting each read and when it came.
    #[derive(Default)]
    struct NotingReader {
        reads: Mutex<Vec<(Instant, CheckKind)>>,
    }

    impl NotingReader {
        fn full_reads_after(&self, start: Instant) -> Vec<Duration> {
            lock(&self.reads)
                .iter()
                .filter(|(_, kind)| *kind == CheckKind::Full)
                .map(|(at, _)| at.duration_since(start))
                .collect()
        }

        fn note(&self, kind: CheckKind) {
            lock(&self.reads).push((Instant::now(), kind));
        }
    }

    impl InputWaitReader for NotingReader {
        fn may_wait<'a>(
            &'a self,
            _terminal: &'a InputTerminal,
        ) -> BoxFuture<'a, std::io::Result<bool>> {
            self.note(CheckKind::Cheap);
            async { Ok(true) }.boxed()
        }

        fn read<'a>(
            &'a self,
            _terminal: &'a InputTerminal,
        ) -> BoxFuture<'a, std::io::Result<InputWaitReading>> {
            self.note(CheckKind::Full);
            async { Ok(InputWaitReading::default()) }.boxed()
        }
    }

    /// A terminal whose program waits on nothing the schedule's reads look at.
    fn terminal() -> InputTerminal {
        // Every member a system's reading holds, so the one form reads on each.
        let master: TerminalMasterReading = serde_json::from_value(serde_json::json!({
            "session_leader": 1,
            "foreground_group": 1,
            "queued_input_bytes": 0,
            "unread_output_bytes": 0,
            "is_echo_on": true,
            "is_canonical": true,
        }))
        .expect("a master reading");
        InputTerminal {
            device: TerminalDevice(0),
            master,
        }
    }

    fn millis(values: &[u64]) -> Vec<Duration> {
        values.iter().copied().map(Duration::from_millis).collect()
    }

    // Fails on a fixed gap, on output that does not start the schedule over, and on a seventh full
    // read inside one minute.
    #[tokio::test(start_paused = true)]
    async fn full_reads_double_to_a_minute_start_over_on_output_and_keep_to_six_a_minute() {
        // Quiet output: the cheap check 50 ms after it passes, the first full read a second later,
        // then gaps doubling to a minute.
        let quiet = Arc::new(NotingReader::default());
        let start = Instant::now();
        let quiet_checks = WaitingChecks::start(Arc::clone(&quiet) as _, |_state| {});
        quiet_checks.terminal_read(terminal(), String::new());
        tokio::time::sleep(Duration::from_secs(190)).await;
        assert_eq!(
            quiet.full_reads_after(start),
            millis(&[
                1_050, 3_050, 7_050, 15_050, 31_050, 63_050, 123_050, 183_050
            ])
        );

        // Output every two seconds: each starts the schedule over, so a full read follows each by
        // 1.05 s until six fill the minute, and the seventh waits for the first to leave it.
        let busy = Arc::new(NotingReader::default());
        let start = Instant::now();
        let busy_checks = WaitingChecks::start(Arc::clone(&busy) as _, |_state| {});
        busy_checks.terminal_read(terminal(), String::new());
        for _ in 0..10 {
            busy_checks.output_printed();
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        tokio::time::sleep(Duration::from_secs(42)).await;
        assert_eq!(
            busy.full_reads_after(start),
            millis(&[1_050, 3_050, 5_050, 7_050, 9_050, 11_050, 61_050])
        );
    }

    // Fails when a `select` sleeper is marked waiting without a prompt for its last line, or not
    // marked with one.
    #[tokio::test]
    async fn a_select_reader_is_marked_waiting_with_a_prompt_line_and_not_without_one() {
        let options = terminal_options(
            POSIX_SHELL.to_owned(),
            vec!["-c".to_owned(), SELECT_READER_SCRIPT.to_owned()],
            None,
            HashMap::new(),
        );
        let window = alacritty_terminal::event::WindowSize {
            num_lines: 24,
            num_cols: 80,
            cell_width: 0,
            cell_height: 0,
        };
        let inner = start_inner_terminal(&options, window).expect("the reader starts");
        let mut master = blocking_terminal_master(&inner.pty).expect("the master opens");
        let mut shown = Vec::new();
        let mut buffer = [0_u8; 256];
        while !String::from_utf8_lossy(&shown).contains("ready") {
            let count = master.read(&mut buffer).expect("the reader prints");
            assert_ne!(count, 0, "the reader ended before it was ready");
            shown.extend_from_slice(&buffer[..count]);
        }
        // The reader enters `select` just after it prints.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        let terminal = InputTerminal {
            device: inner.device,
            master: read_terminal_master(&inner.pty, &std::sync::Once::new())
                .expect("the master reads"),
        };
        let reading = read_input_wait(&spawner, &terminal)
            .await
            .expect("the wait reads");
        assert!(reading.is_waiting || reading.is_waiting_in_select);
        assert!(is_marked_waiting(
            reading,
            "ready\n? Pick a color \u{203a} "
        ));
        if !reading.is_waiting {
            assert!(!is_marked_waiting(reading, "ready\n"));
        }
    }
}
