//! `question.resolve`: the person's answers to every question of one record, from the calling
//! device, an answer kept while no process held its session continuing its held lead.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::question::QuestionResolve;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_queue::service::RunQueue;
use sidekicks_session::questions::service::QuestionsService;

/// Registers `question.resolve`, answered through `questions`, a kept answer continuing its held
/// lead through `queue`. A call with no calling device is a fault in the daemon, answered as an
/// internal error; a kept answer is answered once it is recorded, its lead's continue run after on
/// the queue's own task. Fails the start when the method is already registered.
pub(crate) fn register_question_resolve(
    registry: &mut MethodRegistryBuilder,
    questions: Arc<QuestionsService>,
    queue: Arc<RunQueue>,
) -> Result<(), RegistrationError> {
    registry.register::<QuestionResolve, _>(move |request, context: HandlerContext| {
        let (questions, queue) = (Arc::clone(&questions), Arc::clone(&queue));
        async move {
            let device_id = context.calling_device(QuestionResolve::DESCRIPTOR.method)?;
            let resolved = questions.resolve_question(request, device_id).await?;
            if let Some((session_id, run_id)) = resolved.kept {
                queue.continue_after_answer(session_id, run_id, RunStateEntry::WaitingForInput);
            }
            Ok(resolved.response)
        }
        .boxed()
    })
}
