//! The queued answers of a question its agent does not wait for.

use super::{Fixture, write_queued_answers};

// A question its agent does not wait for stays open while a send naming it is queued, stays open
// when that item is withdrawn, and is answered when the agent takes a queued answer; of two
// devices' answers the first taken wins and unpairs the other, and an item that answers nothing
// answers nothing. Killed by answering at send time and by answering on another item's admission.
#[tokio::test]
async fn queued_answers_settle_a_question_its_agent_does_not_wait_for() {
    let fixture = Fixture::new().await;

    let written = write_queued_answers(&fixture).await;

    assert_eq!(written.after_send, "open");
    assert_eq!(written.after_withdrawal, "open");
    assert_eq!(fixture.state(written.unwaited), "answered");
    assert_eq!(fixture.state(written.withdrawn), "canceled");
    assert_eq!(fixture.state(written.withdrawn_waiting), "canceled");
    assert_eq!(fixture.state(written.opened), "answered");
    let paired_items: i64 = fixture
        .database
        .reader()
        .query_row("SELECT COUNT(*) FROM question_answer_items", [], |row| {
            row.get(0)
        })
        .expect("the answer items count");
    assert_eq!(paired_items, 0, "the first taken answer unpairs the other");
}
