use std::io;
use std::process::Stdio;

use process_wrap::tokio::ChildWrapper;
use rstest::rstest;
use sidekicks_contracts::provider::account::sign_in::ProviderSignInCancelStatus;
use tokio::io::{AsyncReadExt as _, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::child_ending::ChildEnding;
use crate::driver::claude::account::sign_in::{
    ClaudeSignInInput, ERROR_LINE_CAP, Flow, INPUT_CAPACITY, OutputScan, PROMPT_CAPACITY,
    STOP_GRACE, prompt_channel,
};
use crate::driver::contract::account::{ProviderSignInEnd, ProviderSignInInput as _};

/// A child that can never be asked to stop, and whose kill is refused too where
/// `is_kill_refused`.
#[derive(Debug)]
struct StopRefused {
    child: tokio::process::Child,
    is_kill_refused: bool,
}

impl ChildWrapper for StopRefused {
    fn inner(&self) -> &dyn ChildWrapper {
        &self.child
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        &mut self.child
    }

    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        Box::new(self.child)
    }

    fn start_kill(&mut self) -> io::Result<()> {
        if self.is_kill_refused {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.child.start_kill()
    }

    fn signal(&self, _signal: i32) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }
}

// Killed by a cancel whose stop could not be asked answered with that failure while the kill past
// the grace settles the flow failed (the reply and the record disagree), and by a flow that could
// be neither stopped nor killed answered or recorded as canceled.
#[rstest]
#[case::killed_past_the_grace(false)]
#[case::not_ended(true)]
#[tokio::test(start_paused = true)]
async fn a_cancel_ends_the_flow_where_its_stop_fails(#[case] is_kill_refused: bool) {
    let mut child = tokio::process::Command::new("/bin/sleep")
        .arg("600")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("the stand-in starts");
    let input = child.stdin.take().expect("its input is piped");
    let output = child.stdout.take().expect("its output is piped");
    let errors = child.stderr.take().expect("its error output is piped");
    let (prompts, _code_prompts) = prompt_channel::channel(PROMPT_CAPACITY);
    let (inputs, received) = mpsc::channel(INPUT_CAPACITY);
    let (end, completion) = oneshot::channel();
    let flow = Flow {
        child: Box::new(StopRefused {
            child,
            is_kill_refused,
        }),
        input,
        output,
        errors: BufReader::new(errors).take(ERROR_LINE_CAP),
        ending: ChildEnding::new(STOP_GRACE),
        scan: OutputScan::default(),
        prompts,
        inputs: received,
        end,
    };
    // The task ends with the test's runtime.
    let _running = tokio::spawn(flow.run());

    let canceled = ClaudeSignInInput { inputs }.cancel().await;

    if is_kill_refused {
        assert!(
            canceled.is_err(),
            "a flow left running was answered canceled"
        );
        assert!(
            tokio::time::timeout(STOP_GRACE * 12, completion)
                .await
                .is_err(),
            "a flow left running was recorded as ended"
        );
    } else {
        assert_eq!(
            canceled.expect("the cancel is answered once the flow ended"),
            ProviderSignInCancelStatus::Canceled
        );
        assert_eq!(
            completion.await.expect("the flow answers its end"),
            ProviderSignInEnd::Canceled
        );
    }
}
