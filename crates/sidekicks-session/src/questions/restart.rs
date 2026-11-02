//! The questions a restart leaves: those the tool-server client asked under requests the restart
//! ended, which no server will ever answer.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::port::question::is_tool_server_request_id;
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::questions::service::{QuestionError, QuestionsService};
use crate::questions::store::read_unsettled_of_requests;

impl QuestionsService {
    /// Withdraws every question of `session_id` the tool-server client asked, open or waiting for
    /// its run: an open one canceled in the write that moves its run back to `running`, one
    /// waiting for its run in a write of its own, each `interrupted` when its run has an interrupt
    /// recorded, else `withdrawn`, with no held request needed. Fails as a read or a write fails,
    /// the questions before the failure staying withdrawn.
    pub async fn withdraw_tool_server_questions(
        &self,
        session_id: SessionId,
    ) -> Result<(), QuestionError> {
        let requested = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QuestionError>(read_unsettled_of_requests(reader, &session_id)?)
            })
            .await?;
        for question in requested
            .into_iter()
            .filter(|question| is_tool_server_request_id(&question.request_id))
        {
            let _question_hold = self.question_lock.acquire(question.question_id).await;
            self.cancel_withdrawn_question(question.question_id, session_id, question.run_id)
                .await?;
        }
        Ok(())
    }
}
