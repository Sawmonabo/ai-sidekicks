//! A cut of text to a bound counted in code points, as the wire's text caps count, that never
//! leaves half a character.

/// `text` cut to at most `max_code_points` code points, so the result always ends on a whole
/// character.
pub fn cut_to_code_points(text: &str, max_code_points: usize) -> &str {
    text.char_indices()
        .nth(max_code_points)
        .map_or(text, |(end, _)| &text[..end])
}
