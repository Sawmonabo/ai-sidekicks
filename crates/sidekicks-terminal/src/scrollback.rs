//! One shell's scrollback window: its newest output, bounded in bytes. Once full it drops its
//! oldest whole lines, so it starts at the first whole line it holds and a redraw never begins
//! mid-line.

use std::collections::VecDeque;

use bytes::Bytes;

/// The most output one shell's scrollback window holds, in bytes.
pub(crate) const SCROLLBACK_WINDOW_BYTES: usize = 1024 * 1024;

/// One appended chunk and where its first line feed is, so a trim finds the next line's start
/// without scanning the whole window again.
struct ScrollbackChunk {
    bytes: Bytes,
    first_line_feed: Option<usize>,
}

impl ScrollbackChunk {
    fn new(bytes: Bytes) -> Self {
        let first_line_feed = bytes.iter().position(|&byte| byte == b'\n');
        Self {
            bytes,
            first_line_feed,
        }
    }

    /// Drops the chunk's first `count` bytes.
    fn cut_front(&mut self, count: usize) {
        *self = Self::new(self.bytes.slice(count..));
    }
}

/// A shell's scrollback window, appended in output order. A burst larger than the window keeps its
/// tail from its first whole line; a window holding no line break keeps its last bytes from the
/// first character that starts in them.
pub(crate) struct ScrollbackWindow {
    chunks: VecDeque<ScrollbackChunk>,
    byte_count: usize,
}

impl ScrollbackWindow {
    /// An empty window.
    pub(crate) fn new() -> Self {
        Self {
            chunks: VecDeque::new(),
            byte_count: 0,
        }
    }

    /// Appends `output`, dropping the oldest whole lines past the window's bound.
    pub(crate) fn append(&mut self, output: Bytes) {
        if output.is_empty() {
            return;
        }
        self.byte_count += output.len();
        self.chunks.push_back(ScrollbackChunk::new(output));
        if self.byte_count > SCROLLBACK_WINDOW_BYTES {
            self.drop_oldest(self.byte_count - SCROLLBACK_WINDOW_BYTES);
        }
    }

    /// The window's bytes, oldest first.
    pub(crate) fn read(&self) -> Vec<u8> {
        let mut window = Vec::with_capacity(self.byte_count);
        for chunk in &self.chunks {
            window.extend_from_slice(&chunk.bytes);
        }
        window
    }

    /// How many bytes the window holds.
    pub(crate) fn byte_count(&self) -> usize {
        self.byte_count
    }

    /// At most `max` of the window's bytes, starting `skip` bytes in; empty when `skip` reaches
    /// its end. Copies only the bytes it returns.
    pub(crate) fn read_range(&self, skip: usize, max: usize) -> Vec<u8> {
        let mut range = Vec::with_capacity(max.min(self.byte_count.saturating_sub(skip)));
        let mut to_skip = skip;
        for chunk in &self.chunks {
            if range.len() == max {
                break;
            }
            let bytes = &chunk.bytes[..];
            if to_skip >= bytes.len() {
                to_skip -= bytes.len();
                continue;
            }
            let taken = &bytes[to_skip..];
            to_skip = 0;
            let room = max - range.len();
            range.extend_from_slice(&taken[..taken.len().min(room)]);
        }
        range
    }

    /// Drops `excess` bytes from the front, then, unless they ended a line, on through the end of
    /// the line they cut into.
    fn drop_oldest(&mut self, excess: usize) {
        let mut remaining = excess;
        let mut last_dropped = None;
        while remaining > 0
            && let Some(head) = self.chunks.front_mut()
        {
            let head_length = head.bytes.len();
            if head_length > remaining {
                last_dropped = Some(head.bytes[remaining - 1]);
                head.cut_front(remaining);
                self.byte_count -= remaining;
                break;
            }
            last_dropped = head.bytes.last().copied();
            remaining -= head_length;
            self.byte_count -= head_length;
            self.chunks.pop_front();
        }
        if last_dropped != Some(b'\n') {
            self.drop_through_cut_line();
        }
    }

    /// Starts the window after the first line feed it holds, or, with none, at its first whole
    /// character.
    fn drop_through_cut_line(&mut self) {
        let first_line = self
            .chunks
            .iter()
            .enumerate()
            .find_map(|(position, chunk)| {
                chunk.first_line_feed.map(|line_feed| (position, line_feed))
            });
        let Some((line_chunk, line_feed)) = first_line else {
            self.trim_to_character_start();
            return;
        };
        for dropped in self.chunks.drain(..line_chunk) {
            self.byte_count -= dropped.bytes.len();
        }
        // The chunk holding the line feed is now the head.
        let head = &mut self.chunks[0];
        head.cut_front(line_feed + 1);
        self.byte_count -= line_feed + 1;
        if head.bytes.is_empty() {
            self.chunks.pop_front();
        }
    }

    /// Drops the continuation bytes the window starts with, so it starts at a character's start.
    fn trim_to_character_start(&mut self) {
        while let Some(head) = self.chunks.front_mut() {
            let continuation_bytes = head
                .bytes
                .iter()
                .take_while(|&&byte| (byte & 0xC0) == 0x80)
                .count();
            if continuation_bytes < head.bytes.len() {
                head.cut_front(continuation_bytes);
                self.byte_count -= continuation_bytes;
                return;
            }
            // A chunk of continuation bytes alone goes whole, and the next chunk is checked.
            self.byte_count -= head.bytes.len();
            self.chunks.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use rstest::rstest;

    use super::{SCROLLBACK_WINDOW_BYTES, ScrollbackWindow};

    /// One burst of eleven-byte lines past the window's bound.
    fn burst_of_lines() -> Vec<Vec<u8>> {
        vec![b"0123456789\n".repeat(SCROLLBACK_WINDOW_BYTES / 11 + 2)]
    }

    /// One burst of three-byte characters and no line break, past the bound by two bytes, so the
    /// cut lands inside a character.
    fn burst_without_line_breaks() -> Vec<Vec<u8>> {
        vec!["€".repeat(SCROLLBACK_WINDOW_BYTES / 3 + 1).into_bytes()]
    }

    /// Numbered hundred-byte lines appended one at a time up to the bound, then one
    /// two-hundred-byte line that pushes the window past it.
    fn lines_then_one_past_the_bound() -> Vec<Vec<u8>> {
        let mut appends: Vec<Vec<u8>> = (0..SCROLLBACK_WINDOW_BYTES / 100)
            .map(|number| format!("{number:099}\n").into_bytes())
            .collect();
        appends.push(format!("{}\n", "c".repeat(199)).into_bytes());
        appends
    }

    #[rstest]
    // 95,327 eleven-byte lines; the cut lands inside the second, so the window keeps the last
    // 95,325 whole lines.
    #[case::a_burst_keeps_its_tail_from_its_first_whole_line(burst_of_lines(), 95_325 * 11)]
    // The cut drops two bytes of a character, so the window skips its third and keeps whole ones.
    #[case::without_a_line_break_the_window_starts_at_a_character(
        burst_without_line_breaks(),
        349_525 * 3
    )]
    // The excess drops the first line whole and cuts into the second, which goes whole too.
    #[case::an_append_past_the_bound_drops_the_oldest_whole_lines(
        lines_then_one_past_the_bound(),
        10_483 * 100 + 200
    )]
    fn the_window_keeps_its_newest_output_from_a_whole_line_or_character(
        #[case] appends: Vec<Vec<u8>>,
        #[case] expected_length: usize,
    ) {
        let output = appends.concat();
        let mut window = ScrollbackWindow::new();
        for chunk in appends {
            window.append(Bytes::from(chunk));
        }
        let kept = window.read();
        assert_eq!(kept.len(), expected_length);
        assert_eq!(kept, output[output.len() - expected_length..]);
        assert!(std::str::from_utf8(&kept).is_ok());
    }
}
