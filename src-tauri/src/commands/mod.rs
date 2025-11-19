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

// Re-export all commands for easy access
// pub use config::*;
// pub use scan::*;
// pub use tags::*;
// pub use rename::*;
// pub use abs::*;
// pub use maintenance::*;
// pub use audible::*;
