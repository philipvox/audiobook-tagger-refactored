// commands/mod.rs
// Central module for all Tauri commands

pub mod config;
pub mod scan;
pub mod tags;
pub mod rename;
pub mod abs;
pub mod maintenance;
pub mod audible;
pub mod covers;
pub mod export;
pub mod chapters;
pub mod folder_fixer;
pub mod smart_rename;
pub mod duplicates;
pub mod genres;
pub mod converter;
pub mod custom_providers;
pub mod pipeline;
pub mod bulk_covers;
pub mod abs_cache;
pub mod title_resolver;
pub mod alignment;
pub mod validation;
pub mod series_analysis;
pub mod age_rating;
pub mod isbn;
pub mod book_dna;
pub mod classify;
pub mod gather;
pub mod authors;

// Re-export all commands for easy access
// pub use config::*;
// pub use scan::*;
// pub use tags::*;
// pub use rename::*;
// pub use abs::*;
// pub use maintenance::*;
// pub use audible::*;
