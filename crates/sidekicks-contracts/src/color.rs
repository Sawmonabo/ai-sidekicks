//! A color as the wire carries it: sRGB written `#rrggbb`, either case.

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::pattern_text;

pattern_text! {
    /// An sRGB color written `#rrggbb`, either case.
    pub struct HexColor("^#[0-9a-fA-F]{6}$");
}

ts_constants! {
    /// The pattern every color field checks, as text: an sRGB color written `#rrggbb`, either case.
    HEX_COLOR_PATTERN = HexColor::PATTERN;
}

/// The TypeScript module of the color.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "color",
    doc: "A color as the wire carries it: sRGB written `#rrggbb`, either case.",
    definitions: &[Definition::read::<HexColor>().checked()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
