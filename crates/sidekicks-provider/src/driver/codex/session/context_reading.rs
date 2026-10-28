//! A Codex session's context reading, composed from each usage report of its own conversation:
//! the window Codex reports, the last request's totals against it, and the compaction stops. The
//! top stop is where Codex compacts, the limit the calibration measured, else Codex's own default
//! point; the bottom stop is the session's fixed start, the first report's input, plus a tenth of
//! the window, unknown until that report.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::{
    SessionCompactionBound, SessionContextBreakdown, SessionContextReading, SessionContextUsage,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;

use crate::driver::codex::notification_routing::CodexContextWindowReading;
use crate::driver::context_window::{BOTTOM_STOP_HEADROOM_PERCENT, share_percent};
use crate::usage_delta_accountant::WindowTelemetry;

/// Where Codex compacts when no calibration measured it: nine tenths of the window.
const CODEX_DEFAULT_COMPACTION_PERCENT: f64 = 90.0;

/// What a context reading is composed from beyond the usage report itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexContextStops {
    /// The calibrated compaction limit, in tokens, `None` while it is unknown.
    pub(crate) compaction_limit_tokens: Option<u64>,
    /// The input of the session's first usage report, its fixed start, in tokens.
    pub(crate) fixed_start_tokens: Option<u64>,
}

/// The session `session_id`'s context reading from `reading`, `None` for a report that names no
/// window. The session's own bound follows the top stop and is never its own.
pub(crate) fn compose_codex_context_reading(
    session_id: SessionId,
    reading: &CodexContextWindowReading,
    stops: CodexContextStops,
) -> Option<SessionContextReading> {
    let WindowTelemetry::Counted {
        window_used_tokens,
        window_max_tokens,
        ..
    } = reading.window
    else {
        return None;
    };
    let window_tokens = SafeInt::<1>::new(window_max_tokens)?;
    let top_stop = stops
        .compaction_limit_tokens
        .map_or(CODEX_DEFAULT_COMPACTION_PERCENT, |limit| {
            share_percent(limit, window_max_tokens)
        });
    let top_stop_percent = Percent::new(top_stop)?;
    let bottom_stop_percent = stops.fixed_start_tokens.and_then(|fixed_start| {
        let bottom = (share_percent(fixed_start, window_max_tokens) + BOTTOM_STOP_HEADROOM_PERCENT)
            .ceil()
            .min(top_stop);
        Percent::new(bottom)
    });
    let breakdown = reading.breakdown;
    let count = |tokens: Option<u64>| SafeInt::<0>::new(tokens.unwrap_or(0));
    let usage = SessionContextUsage {
        used_tokens: SafeInt::new(window_used_tokens)?,
        used_percent: Percent::new(share_percent(window_used_tokens, window_max_tokens))?,
        breakdown: SessionContextBreakdown::Totals {
            cached_input_tokens: count(breakdown.cached_input)?,
            input_tokens: count(breakdown.input)?,
            output_tokens: count(breakdown.output)?,
            reasoning_tokens: count(breakdown.reasoning_output)?,
        },
    };
    Some(SessionContextReading {
        session_id,
        window_tokens,
        compaction: SessionCompactionBound {
            bound_percent: top_stop_percent,
            top_stop_percent,
            bottom_stop_percent,
            session_override: false,
        },
        usage: Some(usage),
    })
}
