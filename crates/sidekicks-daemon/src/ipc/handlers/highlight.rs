//! `highlight.read`: the color spans of one piece of code, from the daemon's one colorer. Spans go
//! out as the flat `[offset, length, class]` list the colorer keeps. The reply's check refuses a
//! list too big for one reply frame, so an oversized reply fails the read instead of closing the
//! connection.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::highlight::{
    HIGHLIGHT_SPAN_WIDTH, HighlightRead, HighlightReadRequest, HighlightReadResponse,
    HighlightSpan, HighlightSpanClass, HighlightSpans,
};
use sidekicks_contracts::wire::integer::SafeInt;
use strum::VariantArray as _;

use crate::highlight::colorer::CodeHighlighter;
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

/// Registers `highlight.read` over `highlighter`, refusing a read a newer one for the same block
/// replaced. Fails the start when the method is already registered.
pub(crate) fn register_highlight_read(
    registry: &mut MethodRegistryBuilder,
    highlighter: Arc<CodeHighlighter>,
) -> Result<(), RegistrationError> {
    registry.register::<HighlightRead, _>(
        move |request: HighlightReadRequest, context: HandlerContext| {
            let read = highlighter.read_spans(
                request.source.into_string(),
                request.language,
                context.transport_id,
                request
                    .block_id
                    .map(|block_id| Arc::from(block_id.into_string())),
            );
            async move {
                let packed = read.await?;
                Ok(HighlightReadResponse {
                    spans: unpacked_spans(&packed),
                })
            }
            .boxed()
        },
    )
}

// The colorer's packed `[offset, length, class]` triples as spans; the colorer packs only whole
// triples, each of a non-zero length and a listed class.
fn unpacked_spans(packed: &[u32]) -> HighlightSpans {
    HighlightSpans(
        packed
            .as_chunks::<HIGHLIGHT_SPAN_WIDTH>()
            .0
            .iter()
            .map(|&[offset, length, class]| HighlightSpan {
                offset: SafeInt::new(u64::from(offset)).expect("a 32-bit offset is a safe integer"),
                length: SafeInt::new(u64::from(length)).expect("the colorer packs no empty span"),
                class: *usize::try_from(class)
                    .ok()
                    .and_then(|index| HighlightSpanClass::VARIANTS.get(index))
                    .expect("the colorer packs a listed class"),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::highlight::HIGHLIGHT_SOURCE_MAX_BYTES;

    use super::register_highlight_read;
    use crate::highlight::colorer::{CodeHighlighter, CodeHighlighterOptions};
    use crate::ipc::call_fixtures::{context, request};
    use crate::ipc::registry::{Dispatch as _, DispatchError, MethodRegistryBuilder, Reply};

    /// A JSON array of ones on lines of a hundred, whose every number is a span: its span list
    /// measures past the reply's bound while its source stays inside the request's.
    fn many_numbers_source() -> String {
        let line = format!("{}\n", ["1"; 100].join(","));
        let line_count = HIGHLIGHT_SOURCE_MAX_BYTES * 9 / 10 / (line.len() + 1);
        format!("[{}1]", line.repeat(line_count).replace('\n', ",\n"))
    }

    /// A read whose spans fit answers them; one whose spans measure past the reply's bound fails
    /// that read alone, as a broken answer, and the next read on the connection still answers.
    /// Mutation: let the reply's check pass an oversized list.
    #[tokio::test]
    async fn spans_past_the_reply_bound_fail_the_read_and_the_next_read_answers() {
        let highlighter = Arc::new(
            CodeHighlighter::start(CodeHighlighterOptions::for_this_machine())
                .expect("the system gives the colorer its thread"),
        );
        let mut builder = MethodRegistryBuilder::new();
        register_highlight_read(&mut builder, Arc::clone(&highlighter))
            .expect("highlight.read registers once");
        let registry = builder.freeze();
        let read = |source: String| {
            registry.dispatch(
                request(
                    "highlight.read",
                    Some(&json!({ "language": "json", "source": source })),
                ),
                context(1),
            )
        };

        let oversized = read(many_numbers_source()).await;
        assert!(
            matches!(oversized, Err(DispatchError::ResultInvalid { .. })),
            "an oversized span list fails its read"
        );

        let Ok(Reply::Result(answer)) = read("[1, 2]".to_owned()).await else {
            panic!("the next read on the connection answers");
        };
        let answer: serde_json::Value =
            serde_json::from_slice(&answer.json).expect("the answer is JSON");
        assert!(
            answer["spans"]
                .as_array()
                .is_some_and(|spans| !spans.is_empty()),
            "the numbers are colored"
        );
        highlighter.stop();
    }
}
