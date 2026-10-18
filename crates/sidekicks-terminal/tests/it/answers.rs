//! The screen copy's answers to a program that asks its terminal far more than it reads stop at
//! their bound, while a keystroke after them still arrives.

use std::io;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use bytes::Bytes;
use sidekicks_terminal::{ANSWER_BYTES_LIMIT, ScreenListener, TerminalAnswers};

use crate::helpers::{KeepAllOutput, read_past_line, read_to_exit, request, terminals};

/// How many times the program asks for its terminal's device attributes, whose answers come to
/// far more than their bound.
const QUESTION_COUNT: usize = 30_000;

/// What the screen copy answers each question with: a VT102's device attributes.
const DEVICE_ATTRIBUTES: &[u8] = b"\x1b[?6c";

/// The warning a dropped answer logs.
const DROP_WARNING: &str = "later answers are dropped";

/// Hands the screen copy's answers to the terminal, as the daemon's listener does.
#[derive(Clone)]
struct AnswerToTerminal(TerminalAnswers);

impl EventListener for AnswerToTerminal {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(answer) = event {
            self.0.queue(Bytes::from(answer));
        }
    }
}

impl ScreenListener for AnswerToTerminal {
    fn find_questions(&mut self, _output: &[u8], _ends: &mut Vec<usize>) {}

    fn answer_question(&mut self) {}
}

/// Every line the test's process logs, for counting the drop's warning of the test's shell.
#[derive(Clone, Default)]
struct LogLines(Arc<Mutex<Vec<u8>>>);

impl io::Write for LogLines {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("no test panics while holding the log")
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_stop_at_their_bound_and_a_keystroke_after_them_arrives() {
    let log = LogLines::default();
    let writer = log.clone();
    // The read loop logs on whichever thread runs it, so the capture is global, and only the lines
    // in this shell's read loop span are counted.
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .finish(),
    )
    .expect("the test sets its process's one subscriber");
    let terminals = terminals();
    let program = sidekicks_platforms::device_attribute_asker(QUESTION_COUNT);
    let mut spawned = terminals
        .spawn(request(program), AnswerToTerminal, KeepAllOutput)
        .await
        .expect("the shell starts");
    read_past_line(&mut spawned.output, "asked").await;

    terminals
        .queue_write(spawned.handle, Bytes::from_static(b"Z"))
        .expect("the keystroke is handed over")
        .taken()
        .await
        .expect("the keystroke is taken");
    let (text, _exit) = read_to_exit(&mut spawned.output).await;

    let counts: Vec<usize> = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("read "))
        .and_then(|counts| {
            let (read, keys) = counts.split_once(" key ")?;
            Some(vec![read.parse().ok()?, keys.parse().ok()?])
        })
        .unwrap_or_else(|| panic!("the program reports what it read: {text:?}"));
    let answered = counts[0] - 1;
    assert_eq!(counts[1], 1, "the keystroke after the answers arrives once");
    assert!(
        answered < QUESTION_COUNT * DEVICE_ATTRIBUTES.len(),
        "answers past the bound are dropped: {answered} bytes answered"
    );
    // The bound, plus what the terminal's own input buffer took before the bound filled.
    assert!(
        answered <= 2 * ANSWER_BYTES_LIMIT,
        "answers stop at their bound: {answered} bytes answered"
    );
    let logged = String::from_utf8_lossy(&log.0.lock().expect("no test panicked")).into_owned();
    let handle = spawned.handle.to_string();
    let drops = logged
        .lines()
        .filter(|line| {
            line.contains("terminal read loop{")
                && line.contains(&handle)
                && line.contains(DROP_WARNING)
        })
        .count();
    assert_eq!(drops, 1, "{logged}");
}
