//! Where a reply's markdown body is cut into the blocks the screen draws apart: where the parser's
//! own top-level children start, so every block parses alone as it does inside the whole text. A
//! text is read a window of whole lines at a time, a line ending at a line feed, a carriage return
//! or both; every child but the last two of a window is kept, since text after a window's end can
//! still change what they are, and the next window starts at the first one held back. A block
//! starts at the start of its child's first line. The text cut is the one the screen draws, its
//! escape sequences left out, and starts travel as UTF-16 offsets into it, as the desktop indexes
//! text, packed as little-endian `u32`s. A row whose reply is still arriving is cut the same way
//! with its last two children held back, so a start once sent never moves. A cut that fails fails
//! its row alone, which then carries why.

use std::borrow::Cow;
use std::error::Error;
use std::ops::ControlFlow;

use satteri_pulldown_cmark::{Options, parse_no_positions, parse_no_positions_into};
use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::transcript::content::{
    BlockCutFailure, BlockStarts, BodyBlockStart, TranscriptRowContent,
};

use crate::transcript::escape_sequences::{ESCAPE, EscapeSequenceStripper};

/// Top-level children held back at the end of a text that can still grow, behind which a child is
/// final: a setext underline turns the paragraph above it into a heading, and a later item turns
/// the blank line before it into the inside of a loose list. One child of lag closes the first,
/// two close both.
const SETTLE_LAG_BLOCKS: usize = 2;

/// The bytes of text one window parses first, cut back to whole lines; a window holding too few
/// children to keep one is parsed again twice as long.
const CUT_WINDOW_BYTES: usize = 65_536;

/// The parser features the desktop draws markdown with: GitHub's tables, footnotes,
/// strikethrough and task lists, and math, with no front matter.
const MARKDOWN_OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS)
    .union(Options::ENABLE_MATH)
    .union(Options::ENABLE_GFM);

/// The declared media types a body is drawn as markdown under; `text/x-markdown` is an older
/// spelling.
const MARKDOWN_MEDIA_TYPES: [&str; 2] = ["text/markdown", "text/x-markdown"];

/// The payload member naming a body's declared media type.
const CONTENT_TYPE_PAYLOAD_KEY: &str = "contentType";

const BYTE_ORDER_MARK: char = '\u{feff}';

/// One cut's parse: given a window's text as the parser reads it, it answers where each of the
/// window's top-level children starts, in that text's bytes.
pub(crate) type ChildStartsParse = Box<dyn FnMut(&str) -> Vec<usize>>;

/// Makes the parse one cut runs on each window it reads.
pub type BlockParse = fn() -> ChildStartsParse;

/// The parse of the markdown the desktop draws, each window's tree handed to the next parse,
/// which keeps its capacity.
pub const MARKDOWN_PARSE: BlockParse = markdown_parse;

fn markdown_parse() -> ChildStartsParse {
    let mut arena = None;
    Box::new(move |text| {
        let (tree, _) = match arena.take() {
            Some(reuse) => parse_no_positions_into(text, MARKDOWN_OPTIONS, reuse),
            None => parse_no_positions(text, MARKDOWN_OPTIONS),
        };
        // The root is the parse's first node.
        let child_starts = tree
            .get_children(0)
            .iter()
            .map(|&child| {
                usize::try_from(tree.get_node(child).start_offset).expect("an offset fits memory")
            })
            .collect();
        arena = Some(tree);
        child_starts
    })
}

/// Why a markdown cut failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BlockCutError {
    /// A block would end no later than the one before it, as no text should make it.
    #[error("the markdown block cut did not advance past byte {offset}")]
    Stalled {
        /// Where the cut stood.
        offset: usize,
    },
    /// The starts one piece froze do not fit one page.
    #[error("{count} block starts take more than one page")]
    OverPage {
        /// How many starts there were.
        count: usize,
    },
}

impl BlockCutError {
    /// The failure the row carries in place of its starts.
    pub(crate) fn failure(&self) -> BlockCutFailure {
        match self {
            Self::Stalled { .. } => BlockCutFailure::Stalled,
            Self::OverPage { .. } => BlockCutFailure::OverPage,
        }
    }

    /// Logs the failure the row will carry, so the service's log keeps its cause.
    pub(crate) fn logged(self) -> BlockCutFailure {
        tracing::warn!(
            error = &self as &(dyn Error + 'static),
            "a reply's markdown cut failed; its row goes out without block starts"
        );
        self.failure()
    }
}

/// How a reply body is drawn as markdown: by its declared media type, or with none declared, when
/// it is prose only while it holds no escape byte, which would make it command output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProseBody {
    /// A declared markdown body, whose escape sequences the screen leaves out.
    Declared,
    /// A body with no declared media type.
    Undeclared,
}

impl ProseBody {
    /// Whether `text`, the body or a piece of it, keeps the body drawn as markdown.
    pub(crate) fn admits(self, text: &str) -> bool {
        match self {
            Self::Declared => true,
            Self::Undeclared => !text.contains(ESCAPE),
        }
    }
}

/// How the body of a row of `event_type` whose payload is `payload` may be drawn as markdown: an
/// agent's reply declared markdown or declaring nothing; `None` for every other body.
pub(crate) fn prose_body_of(event_type: &str, payload: &Map<String, Value>) -> Option<ProseBody> {
    if event_type != SessionEventType::AgentMessageSent.as_str() {
        return None;
    }
    match payload
        .get(CONTENT_TYPE_PAYLOAD_KEY)
        .and_then(Value::as_str)
    {
        Some(declared) => {
            let essence = declared.split(';').next().unwrap_or_default().trim();
            MARKDOWN_MEDIA_TYPES
                .iter()
                .any(|media_type| essence.eq_ignore_ascii_case(media_type))
                .then_some(ProseBody::Declared)
        }
        None => Some(ProseBody::Undeclared),
    }
}

/// `content`, the inline body of a row whose body may be drawn as `prose`, with its block starts
/// when `parse` cuts it into blocks: every start once its reply `is_final`, else those no later
/// text can move. A cut that fails leaves the row its failure in place of starts.
pub(crate) fn with_block_starts(
    content: TranscriptRowContent,
    prose: Option<ProseBody>,
    is_final: bool,
    parse: BlockParse,
) -> TranscriptRowContent {
    match content {
        TranscriptRowContent::Available {
            body,
            content_length,
            block_starts: _,
            block_cut_failure: _,
        } => {
            let cut = prose.filter(|prose| prose.admits(body.as_str())).map(|_| {
                body_block_starts(body.as_str(), is_final, parse)
                    .and_then(|starts| packed(starts.iter().map(|start| start.drawn_offset)))
            });
            let (block_starts, block_cut_failure) = match cut {
                None => (None, None),
                Some(Ok(block_starts)) => (block_starts, None),
                Some(Err(error)) => (None, Some(error.logged())),
            };
            TranscriptRowContent::Available {
                body,
                content_length,
                block_starts,
                block_cut_failure,
            }
        }
        other @ (TranscriptRowContent::Unavailable { .. } | TranscriptRowContent::Large { .. }) => {
            other
        }
    }
}

/// The block starts of `body`, a prose body, as `parse` cuts it, each in the stored body and in
/// the drawn text: every start once its reply `is_final`, else those no later text can move. Fails
/// when the cut does not advance.
pub(crate) fn body_block_starts(
    body: &str,
    is_final: bool,
    parse: BlockParse,
) -> Result<Vec<BodyBlockStart>, BlockCutError> {
    let drawn = DrawnText::of(body);
    if drawn.text.is_empty() {
        return Ok(Vec::new());
    }
    let ends = block_ends_of(
        &drawn.text,
        is_final,
        CUT_WINDOW_BYTES,
        SETTLE_LAG_BLOCKS,
        parse,
    )?;
    let starts: Vec<usize> = std::iter::once(0)
        .chain(ends.into_iter().filter(|&end| end < drawn.text.len()))
        .collect();
    let drawn_offsets = utf16_offsets_of(&drawn.text, &starts, 0);
    Ok(starts
        .iter()
        .zip(drawn_offsets)
        .map(|(&start, drawn_offset)| BodyBlockStart {
            stored_offset: drawn.stored_offset_of(start),
            drawn_offset: u32::try_from(drawn_offset).expect("a body's UTF-16 offset fits 32 bits"),
        })
        .collect())
}

/// A body as the screen draws it, its escape sequences left out, with where each kept run sits in
/// the stored body.
struct DrawnText<'body> {
    text: Cow<'body, str>,
    /// Each kept run's start in the drawn text and in the stored body; empty when nothing was left
    /// out.
    runs: Vec<(usize, usize)>,
}

impl<'body> DrawnText<'body> {
    fn of(body: &'body str) -> Self {
        if !body.contains(ESCAPE) {
            return Self {
                text: Cow::Borrowed(body),
                runs: Vec::new(),
            };
        }
        let mut text = String::with_capacity(body.len());
        let mut runs = Vec::new();
        for (stored_start, run) in EscapeSequenceStripper::default().kept_runs(body) {
            runs.push((text.len(), stored_start));
            text.push_str(run);
        }
        Self {
            text: Cow::Owned(text),
            runs,
        }
    }

    /// Where the character at `drawn`, a byte offset into the drawn text, sits in the stored body.
    fn stored_offset_of(&self, drawn: usize) -> usize {
        let run = self
            .runs
            .partition_point(|&(drawn_start, _)| drawn_start <= drawn)
            .checked_sub(1)
            .and_then(|index| self.runs.get(index));
        run.map_or(drawn, |&(drawn_start, stored_start)| {
            stored_start + drawn - drawn_start
        })
    }
}

/// Where each block of `source` cut by `parse` so far ends, in bytes, ascending, the first block
/// starting at the text's start. A text that is `is_final` keeps every child of its last window;
/// any other keeps back its last `lag_blocks`, whose bounds more text may still move. Fails when a
/// block would end no later than the one before it.
fn block_ends_of(
    source: &str,
    is_final: bool,
    window_bytes: usize,
    lag_blocks: usize,
    parse: BlockParse,
) -> Result<Vec<usize>, BlockCutError> {
    let mut block_ends = Vec::new();
    let mut window_bytes = window_bytes;
    let mut from = 0;
    let mut child_starts_of = parse();
    while from < source.len() {
        let to = window_end_of(source, from, window_bytes);
        let is_last = to == source.len();
        let window = &source[from..to];
        let parsed = ParsedWindow::of(window);
        let child_starts: Vec<usize> = child_starts_of(parsed.text(window))
            .into_iter()
            .map(|start| parsed.window_offset_of(start))
            .collect();
        let kept_count = if is_last && is_final {
            child_starts.len()
        } else {
            child_starts.len().saturating_sub(lag_blocks)
        };
        if kept_count == 0 {
            if is_last {
                break;
            }
            window_bytes *= 2;
            continue;
        }
        let mut last_end = from;
        for index in 1..=kept_count {
            let end = match child_starts.get(index) {
                Some(&start) => from + line_start_of(window, start, 0),
                None => source.len(),
            };
            if end <= last_end {
                return Err(BlockCutError::Stalled { offset: last_end });
            }
            block_ends.push(end);
            last_end = end;
        }
        from = last_end;
        if is_last {
            break;
        }
    }
    Ok(block_ends)
}

/// Where the window from `from` ends: after the last whole line within `window_bytes`, a carriage
/// return's line feed with it; a line longer than the window is cut inside it, at a character.
fn window_end_of(source: &str, from: usize, window_bytes: usize) -> usize {
    let to = source.floor_char_boundary(from.saturating_add(window_bytes).min(source.len()));
    if to == source.len() {
        return to;
    }
    let last_line_start = line_start_of(source, to, from);
    if last_line_start == from {
        return to.max(source.ceil_char_boundary(from + 1));
    }
    let bytes = source.as_bytes();
    if bytes[last_line_start - 1] == b'\r' && bytes.get(last_line_start) == Some(&b'\n') {
        last_line_start + 1
    } else {
        last_line_start
    }
}

/// Where the line holding `offset` starts in `text`, looking back no further than `floor`.
fn line_start_of(text: &str, offset: usize, floor: usize) -> usize {
    text.as_bytes()[floor..offset]
        .iter()
        .rposition(|&byte| byte == b'\n' || byte == b'\r')
        .map_or(floor, |index| floor + index + 1)
}

/// A window as the parser reads it, parsed as the desktop parses a text: each NUL replaced by
/// U+FFFD, and a byte order mark the window opens on read as text, by a line feed put ahead of it.
struct ParsedWindow {
    /// The text the parser reads, when it differs from the window.
    rewritten: Option<String>,
    /// The bytes put ahead of the window.
    lead_length: usize,
    /// Where each NUL of the window sits.
    nul_offsets: Vec<usize>,
}

impl ParsedWindow {
    fn of(window: &str) -> Self {
        let lead = if window.starts_with(BYTE_ORDER_MARK) {
            "\n"
        } else {
            ""
        };
        let nul_offsets: Vec<usize> = window.match_indices('\0').map(|(index, _)| index).collect();
        let rewritten = (!lead.is_empty() || !nul_offsets.is_empty())
            .then(|| format!("{lead}{}", window.replace('\0', "\u{fffd}")));
        Self {
            rewritten,
            lead_length: lead.len(),
            nul_offsets,
        }
    }

    fn text<'text>(&'text self, window: &'text str) -> &'text str {
        self.rewritten.as_deref().unwrap_or(window)
    }

    /// The window's offset of `parsed`, an offset in the parsed text, where each NUL is widened to
    /// the three bytes of U+FFFD.
    fn window_offset_of(&self, parsed: usize) -> usize {
        let parsed = parsed - self.lead_length;
        let widened_before = self
            .nul_offsets
            .iter()
            .enumerate()
            .take_while(|(index, offset)| **offset + 2 * index < parsed)
            .count();
        parsed - 2 * widened_before
    }
}

/// `starts`, byte offsets of `text` ascending, as UTF-16 offsets counted from `utf16_base`, read
/// in one pass.
fn utf16_offsets_of(text: &str, starts: &[usize], utf16_base: u64) -> Vec<u64> {
    let mut offsets = Vec::with_capacity(starts.len());
    let mut units = utf16_base;
    let mut next = starts.iter().peekable();
    for (index, character) in text.char_indices() {
        while next.next_if(|&&start| start <= index).is_some() {
            offsets.push(units);
        }
        units += u64::try_from(character.len_utf16()).expect("a character is one or two units");
    }
    offsets.extend(next.map(|_| units));
    offsets
}

/// `starts`, UTF-16 offsets, packed as the wire carries them, each a little-endian `u32`; `None`
/// for none. Fails when they take more than one page.
fn packed(starts: impl Iterator<Item = u32>) -> Result<Option<BlockStarts>, BlockCutError> {
    let bytes: Vec<u8> = starts.flat_map(u32::to_le_bytes).collect();
    if bytes.is_empty() {
        return Ok(None);
    }
    let count = bytes.len() / 4;
    BlockStarts::new(bytes.into())
        .map(Some)
        .ok_or(BlockCutError::OverPage { count })
}

/// A row's cut while its pieces stream in: the drawn text after its last frozen start, that start
/// as a UTF-16 offset into the row's drawn body, and where the text's kept runs sit in the stored
/// body. Frozen starts never move.
#[derive(Debug)]
pub(crate) struct StreamingBlockCut {
    /// How the row's body is drawn as markdown.
    prose: ProseBody,
    /// The parse the cut runs on each window.
    parse: BlockParse,
    /// Where the row's text stands among escape sequences, so one cut between pieces is removed
    /// whole.
    stripper: EscapeSequenceStripper,
    /// The row's drawn text from its last frozen start on.
    tail: String,
    /// Each kept run of the tail: its start in the tail and in the stored body, ascending.
    tail_runs: Vec<(usize, usize)>,
    /// The stored bytes received so far.
    stored_length: usize,
    /// The last frozen start.
    frozen_utf16: u64,
    /// Whether the row's first start went out.
    has_started: bool,
    /// The tail's length when a parse of it past one window last froze nothing; the tail is parsed
    /// again only once it has doubled that, so one block streamed in many frames is parsed a
    /// bounded number of times over, never once a frame. Zero while no such parse stands.
    unsplit_length: usize,
}

impl StreamingBlockCut {
    /// The cut by `parse` of a row drawn as `prose` that has received nothing yet.
    pub(crate) fn new(prose: ProseBody, parse: BlockParse) -> Self {
        Self {
            prose,
            parse,
            stripper: EscapeSequenceStripper::default(),
            tail: String::new(),
            tail_runs: Vec::new(),
            stored_length: 0,
            frozen_utf16: 0,
            has_started: false,
            unsplit_length: 0,
        }
    }

    /// The cut by `parse` of a row drawn as `prose` whose text `received` a reader already holds
    /// with its starts, as a read of the row still arriving gave them, so only starts frozen after
    /// them go out and the ones it froze are never packed. Fails when the cut does not advance.
    pub(crate) fn seeded(
        prose: ProseBody,
        received: &str,
        parse: BlockParse,
    ) -> Result<Self, BlockCutError> {
        let mut cut = Self::new(prose, parse);
        cut.advance(received)?;
        Ok(cut)
    }

    /// How the row's body is drawn as markdown.
    pub(crate) fn prose(&self) -> ProseBody {
        self.prose
    }

    /// Adds a piece's `text` and answers the starts it froze. Fails when the cut does not advance
    /// or the starts take more than one page.
    pub(crate) fn push(&mut self, text: &str) -> Result<Option<BlockStarts>, BlockCutError> {
        let starts = self.advance(text)?;
        packed(starts.iter().map(|start| start.drawn_offset))
    }

    /// Adds `text` and answers the starts it froze.
    fn advance(&mut self, text: &str) -> Result<Vec<BodyBlockStart>, BlockCutError> {
        let mut starts = Vec::new();
        for (stored_start, run) in self.stripper.kept_runs(text) {
            self.tail_runs
                .push((self.tail.len(), self.stored_length + stored_start));
            self.tail.push_str(run);
        }
        self.stored_length += text.len();
        if !self.has_started && !self.tail.is_empty() {
            starts.push(self.start_at(0, 0));
            self.has_started = true;
        }
        if self.tail.len() < self.unsplit_length.saturating_mul(2) {
            return Ok(starts);
        }
        let ends = block_ends_of(
            &self.tail,
            false,
            CUT_WINDOW_BYTES,
            SETTLE_LAG_BLOCKS,
            self.parse,
        )?;
        let Some(&last_end) = ends.last() else {
            if self.tail.len() > CUT_WINDOW_BYTES {
                self.unsplit_length = self.tail.len();
            }
            return Ok(starts);
        };
        let utf16_ends = utf16_offsets_of(&self.tail, &ends, self.frozen_utf16);
        starts.extend(
            ends.iter()
                .zip(&utf16_ends)
                .map(|(&end, &utf16)| self.start_at(end, utf16)),
        );
        self.frozen_utf16 = *utf16_ends.last().expect("a frozen end was just added");
        self.drain_tail(last_end);
        self.unsplit_length = 0;
        Ok(starts)
    }

    // The start at `drawn`, a byte offset into the tail, whose UTF-16 offset in the drawn body is
    // `utf16`.
    fn start_at(&self, drawn: usize, utf16: u64) -> BodyBlockStart {
        let run = self
            .tail_runs
            .partition_point(|&(drawn_start, _)| drawn_start <= drawn)
            .checked_sub(1)
            .map(|index| self.tail_runs[index]);
        BodyBlockStart {
            stored_offset: run.map_or(self.stored_length, |(drawn_start, stored_start)| {
                stored_start + drawn - drawn_start
            }),
            drawn_offset: u32::try_from(utf16).expect("a body's UTF-16 offset fits 32 bits"),
        }
    }

    // Drops the tail's text before `end`, a frozen start, and the runs that held only it.
    fn drain_tail(&mut self, end: usize) {
        self.tail.drain(..end);
        let first_kept = self
            .tail_runs
            .partition_point(|&(drawn_start, _)| drawn_start <= end)
            .saturating_sub(1);
        self.tail_runs.drain(..first_kept);
        for (drawn_start, stored_start) in &mut self.tail_runs {
            if *drawn_start < end {
                *stored_start += end - *drawn_start;
                *drawn_start = 0;
            } else {
                *drawn_start -= end;
            }
        }
    }

    /// The starts the row's whole text leaves unsent once it ends. Fails when the cut does not
    /// advance.
    fn final_starts(&self) -> Result<Vec<BodyBlockStart>, BlockCutError> {
        let ends = block_ends_of(
            &self.tail,
            true,
            CUT_WINDOW_BYTES,
            SETTLE_LAG_BLOCKS,
            self.parse,
        )?;
        let inner: Vec<usize> = ends
            .into_iter()
            .filter(|&end| end < self.tail.len())
            .collect();
        let utf16_starts = utf16_offsets_of(&self.tail, &inner, self.frozen_utf16);
        Ok(inner
            .iter()
            .zip(utf16_starts)
            .map(|(&start, utf16)| self.start_at(start, utf16))
            .collect())
    }

    /// The starts the row's whole text leaves unsent once it ends. Fails when the cut does not
    /// advance or the starts take more than one page.
    pub(crate) fn finish(&self) -> Result<Option<BlockStarts>, BlockCutError> {
        packed(self.final_starts()?.iter().map(|start| start.drawn_offset))
    }
}

/// The cut of an ended reply's body handed in a stretch at a time, so the body is never held
/// whole: the starts [`body_block_starts`] gives the whole text once it is final, or not cut where
/// a stretch keeps the body from being drawn as markdown.
pub(crate) struct EndedBodyCut {
    cut: StreamingBlockCut,
    starts: Vec<BodyBlockStart>,
    is_drawn_as_markdown: bool,
}

impl EndedBodyCut {
    /// The cut by `parse` of a body drawn as `prose`, handed nothing yet.
    pub(crate) fn new(prose: ProseBody, parse: BlockParse) -> Self {
        Self {
            cut: StreamingBlockCut::new(prose, parse),
            starts: Vec::new(),
            is_drawn_as_markdown: true,
        }
    }

    /// Adds the body's next stretch, `text`, breaking once the stretches so far keep the body
    /// from being drawn as markdown, when no later stretch changes the cut. Fails when the cut
    /// does not advance.
    pub(crate) fn push(&mut self, text: &str) -> Result<ControlFlow<()>, BlockCutError> {
        if !self.is_drawn_as_markdown {
            return Ok(ControlFlow::Break(()));
        }
        if !self.cut.prose().admits(text) {
            self.is_drawn_as_markdown = false;
            self.starts = Vec::new();
            return Ok(ControlFlow::Break(()));
        }
        let starts = self.cut.advance(text)?;
        self.starts.extend(starts);
        Ok(ControlFlow::Continue(()))
    }

    /// Every start of the whole body, ascending; `None` where it is not drawn as markdown. Fails
    /// when the cut does not advance.
    pub(crate) fn finish(mut self) -> Result<Option<Vec<BodyBlockStart>>, BlockCutError> {
        if !self.is_drawn_as_markdown {
            return Ok(None);
        }
        let last = self.cut.final_starts()?;
        self.starts.extend(last);
        Ok(Some(self.starts))
    }
}

#[cfg(test)]
mod tests;
