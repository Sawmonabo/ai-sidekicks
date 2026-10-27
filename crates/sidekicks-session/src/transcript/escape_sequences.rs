//! Terminal escape sequences in a body drawn as markdown, removed as the desktop removes them
//! before it draws, so offsets the service measures land on the text the screen shows. A scanner
//! of the standard's sequence kinds, each one branch: a two-byte escape, an escape with
//! intermediate bytes, CSI, OSC (ended by BEL or the string terminator) and the string controls
//! DCS, SOS, PM and APC.

/// The byte that opens every escape sequence.
pub(crate) const ESCAPE: char = '\u{1b}';

/// The BEL that ends an OSC sequence.
const BELL: char = '\u{7}';

/// The C1 string terminator, the one-character spelling of `ESC \`. It ends a sequence but never
/// opens one.
const STRING_TERMINATOR: char = '\u{9c}';

/// The introducers of the string controls whose payload runs until a terminator: DCS, SOS, PM and
/// APC. OSC has its own state because BEL also ends it.
const STRING_CONTROL_INTRODUCERS: [char; 4] = ['P', 'X', '^', '_'];

/// Where a scan stands: in text, just past an ESC, in an OSC payload, in a string control's
/// payload, among a CSI's parameter bytes, or among intermediate bytes, which one final character
/// of any kind ends.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ScanState {
    #[default]
    Text,
    Escape,
    OscPayload,
    StringControlPayload,
    CsiParameters,
    Intermediates,
}

/// Removes escape sequences from a text read a piece at a time: where a piece ends inside a
/// sequence is carried to the next, so a sequence cut between two pieces is removed whole.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct EscapeSequenceStripper {
    state: ScanState,
}

impl EscapeSequenceStripper {
    /// The runs of `piece` outside every escape sequence, in order, none empty, each with its byte
    /// offset in `piece`.
    pub(crate) fn kept_runs<'piece>(&mut self, piece: &'piece str) -> Vec<(usize, &'piece str)> {
        let mut kept = Vec::new();
        let mut cursor = 0;
        while cursor < piece.len() {
            if self.state != ScanState::Text {
                let character = piece[cursor..]
                    .chars()
                    .next()
                    .expect("a cursor short of the end has a character");
                self.state = state_after(self.state, character);
                cursor += character.len_utf8();
                continue;
            }
            let escape_at = piece[cursor..].find(ESCAPE).map(|index| cursor + index);
            let run_end = escape_at.unwrap_or(piece.len());
            if run_end > cursor {
                kept.push((cursor, &piece[cursor..run_end]));
            }
            if escape_at.is_some() {
                self.state = ScanState::Escape;
            }
            cursor = run_end + ESCAPE.len_utf8();
        }
        kept
    }
}

/// Where a scan in `state` stands once it reads `character`. An escape inside a string control
/// ends the control and opens whatever it introduces, so `ESC \` also ends it.
fn state_after(state: ScanState, character: char) -> ScanState {
    match state {
        ScanState::Text => ScanState::Text,
        ScanState::Escape => state_after_introducer(character),
        ScanState::OscPayload | ScanState::StringControlPayload => {
            if character == ESCAPE {
                ScanState::Escape
            } else if character == STRING_TERMINATOR
                || (state == ScanState::OscPayload && character == BELL)
            {
                ScanState::Text
            } else {
                state
            }
        }
        ScanState::CsiParameters => {
            if ('0'..='?').contains(&character) {
                state
            } else if is_intermediate(character) {
                ScanState::Intermediates
            } else {
                ScanState::Text
            }
        }
        ScanState::Intermediates => {
            if is_intermediate(character) {
                state
            } else {
                ScanState::Text
            }
        }
    }
}

/// Where a scan stands once it reads the character after an ESC.
fn state_after_introducer(introducer: char) -> ScanState {
    if introducer == ']' {
        ScanState::OscPayload
    } else if STRING_CONTROL_INTRODUCERS.contains(&introducer) {
        ScanState::StringControlPayload
    } else if introducer == '[' {
        ScanState::CsiParameters
    } else if is_intermediate(introducer) {
        // `ESC ( B` and its kind end at their final character.
        ScanState::Intermediates
    } else {
        ScanState::Text
    }
}

/// Whether a character is an intermediate byte, which may follow an escape or a CSI's parameters.
fn is_intermediate(character: char) -> bool {
    (' '..='/').contains(&character)
}
