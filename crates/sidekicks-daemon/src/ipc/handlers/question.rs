//! `question.resolve`: the person's answers to every question of one record, from the calling
//! device.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::question::QuestionResolve;

use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::questions::service::QuestionsService;

/// Registers `question.resolve`, answered through `questions`. A call with no calling device is a
/// fault in the daemon, answered as an internal error. Fails the start when the method is already
/// registered.
pub(crate) fn register_question_resolve(
    registry: &mut MethodRegistryBuilder,
    questions: Arc<QuestionsService>,
) -> Result<(), RegistrationError> {
    registry.register::<QuestionResolve, _>(move |request, context: HandlerContext| {
        let questions = Arc::clone(&questions);
        async move {
            let device_id = context.calling_device(QuestionResolve::DESCRIPTOR.method)?;
            Ok(questions.resolve_question(request, device_id).await?)
        }
        .boxed()
    })
}
