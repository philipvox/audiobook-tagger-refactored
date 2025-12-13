// src-tauri/src/converter/mod.rs
// MP3 to M4B audiobook conversion module

pub mod types;
pub mod ffmpeg;
pub mod analyzer;
pub mod chapters;
pub mod encoder;

#[cfg(test)]
mod tests;

pub use types::*;
pub use ffmpeg::*;
pub use analyzer::*;
pub use chapters::*;
pub use encoder::*;
