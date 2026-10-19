//! A shell's integration: the startup scripts that load beside the person's own startup files and
//! report the shell's prompt and command marks with a nonce minted for that shell alone, how each
//! shell is started with them, and the reader that takes the marks out of the shell's output.

pub(crate) mod injection;
pub(crate) mod marks;
pub(crate) mod zsh_startup;
