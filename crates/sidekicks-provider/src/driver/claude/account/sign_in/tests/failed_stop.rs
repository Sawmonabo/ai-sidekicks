use rstest::rstest;
use sidekicks_contracts::provider::account::sign_in::ProviderSignInCancelStatus;
use sidekicks_platforms::StopRefusingChild;
use tokio::io::{AsyncReadExt as _, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::child_ending::ChildEnding;
use crate::driver::claude::account::sign_in::{
    ClaudeSignInInput, ERROR_LINE_CAP, Flow, INPUT_CAPACITY, OutputScan, PROMPT_CAPACITY,
    STOP_GRACE, prompt_channel,
};
use crate::driver::contract::account::{ProviderSignInEnd, ProviderSignInInput as _};

// Killed by a cancel whose stop could not be asked answered with that failure while the kill past
// the grace settles the flow failed (the reply and the record disagree), and by a flow that could
// be neither stopped nor killed answered or recorded as canceled, at the first cancel or a later
// one.
#[rstest]
#[case::killed_past_the_grace(false)]
#[case::not_ended(true)]
#[tokio::test(start_paused = true)]
async fn a_cancel_ends_the_flow_where_its_stop_fails(#[case] is_kill_refused: bool) {
    let mut child = StopRefusingChild::start(is_kill_refused).expect("the stand-in starts");
    let input = child.child_mut().stdin.take().expect("its input is piped");
    let output = child
        .child_mut()
        .stdout
        .take()
        .expect("its output is piped");
    let errors = child
        .child_mut()
        .stderr
        .take()
        .expect("its error output is piped");
    let (prompts, _code_prompts) = prompt_channel::channel(PROMPT_CAPACITY);
    let (inputs, received) = mpsc::channel(INPUT_CAPACITY);
    let (end, completion) = oneshot::channel();
    let flow = Flow {
        child: Box::new(child),
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

    let input = ClaudeSignInInput { inputs };
    let canceled = input.cancel().await;

    if is_kill_refused {
        assert!(
            canceled.is_err(),
            "a flow left running was answered canceled"
        );
        assert!(
            input.cancel().await.is_err(),
            "a later cancel of a flow left running was answered canceled"
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
