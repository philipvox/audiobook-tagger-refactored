// src-tauri/src/pipeline/mod.rs
// Metadata Pipeline - centralized metadata processing
//
// Pipeline stages:
// 1. GATHER   - Collect data from all sources (ABS, Goodreads, Hardcover, etc.)
// 2. CONTEXT  - Fetch other books in series for GPT context
// 3. DECIDE   - GPT resolves conflicts and produces unified metadata
// 4. VALIDATE - Catch GPT mistakes, ensure data quality

pub mod types;
pub mod gather;
pub mod context;
pub mod decide;
pub mod validate;

pub use types::*;

use crate::config::Config;
use crate::scanner::BookMetadata;
use crate::scanner::types::{SeriesInfo, MetadataSource};
use tauri::Emitter;

/// Main pipeline orchestrator
pub struct MetadataPipeline {
    config: Config,
    client: reqwest::Client,
}

impl MetadataPipeline {
    pub fn new(config: Config) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("Failed to create HTTP client"),
            config,
        }
    }

    /// Process a single book through the full pipeline
    pub async fn process_book(
        &self,
        abs_id: &str,
        initial: SourceData,
    ) -> Result<BookMetadata, String> {
        let title_for_log = initial.title.clone().unwrap_or_else(|| "Unknown".to_string());
        println!("📚 Pipeline: Processing '{}'", title_for_log);

        // 1. GATHER - collect from all sources
        let mut sources = vec![initial];

        // Try to get fresh ABS metadata
        match gather::fetch_abs_metadata(&self.client, &self.config, abs_id).await {
            Ok(abs_meta) => {
                if abs_meta.has_data() {
                    println!("   ✓ Got fresh ABS metadata");
                    sources.push(abs_meta);
                }
            }
            Err(e) => println!("   ⚠ ABS metadata fetch failed: {}", e),
        }

        // Get title/author for custom provider search
        let title = sources
            .iter()
            .find_map(|s| s.title.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("");
        let author = sources
            .iter()
            .find_map(|s| s.authors.first())
            .map(|s| s.as_str())
            .unwrap_or("");

        // Fetch from custom providers
        if !title.is_empty() && self.has_custom_providers() {
            let custom = gather::fetch_custom_providers(&self.config, title, author).await;
            if !custom.is_empty() {
                println!("   ✓ Got {} custom provider results", custom.len());
                sources.extend(custom);
            }
        }

        // 2. Build aggregated data
        let series_names = context::extract_series_names(&sources);

        // 3. CONTEXT - fetch other books in series
        let series_context = if !series_names.is_empty() && !self.config.abs_base_url.is_empty() {
            let ctx = context::fetch_series_context(&self.client, &self.config, &series_names).await;
            if !ctx.is_empty() {
                println!("   ✓ Got {} series context books", ctx.len());
            }
            ctx
        } else {
            vec![]
        };

        let aggregated = AggregatedBookData {
            id: abs_id.to_string(),
            sources,
            series_context,
        };

        // 4. DECIDE - send to GPT (if API key available)
        let resolved = if self.has_gpt_key() {
            println!("   🤖 Sending to GPT...");
            match decide::resolve_with_gpt(&self.config, &aggregated).await {
                Ok(r) => {
                    println!("   ✓ GPT returned: '{}' by {}", r.title, r.author);
                    r
                }
                Err(e) => {
                    println!("   ⚠ GPT failed: {}, using fallback", e);
                    decide::fallback_resolution(&aggregated)
                }
            }
        } else {
            println!("   ⚠ No GPT key, using rule-based fallback");
            decide::fallback_resolution(&aggregated)
        };

        // 5. VALIDATE - catch GPT mistakes
        let validated = validate::validate_metadata(resolved, &aggregated)?;
        println!("   ✓ Validation passed");

        // Convert to BookMetadata
        Ok(self.to_book_metadata(validated))
    }

    /// Process multiple books with parallelism and progress updates via Tauri window
    pub async fn process_batch_with_window(
        &self,
        items: Vec<(String, SourceData)>,
        concurrency: usize,
        window: tauri::Window,
    ) -> Vec<(String, Result<BookMetadata, String>)>
    {
        use futures::stream::{self, StreamExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let total = items.len();
        let processed = Arc::new(AtomicUsize::new(0));
        let window = Arc::new(window);

        let results: Vec<_> = stream::iter(items)
            .map(|(id, source)| {
                let processed = Arc::clone(&processed);
                let window = Arc::clone(&window);
                let total = total;
                async move {
                    let result = self.process_book(&id, source).await;
                    let count = processed.fetch_add(1, Ordering::SeqCst) + 1;
                    // Emit progress event
                    let _ = window.emit("pipeline_progress", serde_json::json!({
                        "phase": "processing",
                        "message": format!("Processed {} of {}...", count, total),
                        "current": count,
                        "total": total
                    }));
                    println!("   📊 Progress: {}/{} books processed", count, total);
                    (id, result)
                }
            })
            .buffer_unordered(concurrency.min(150)) // Tier 3: 5000 RPM, 4M TPM
            .collect::<Vec<_>>()
            .await;

        results
    }

    /// Process multiple books with parallelism (callback version)
    pub async fn process_batch<F>(
        &self,
        items: Vec<(String, SourceData)>,
        concurrency: usize,
        mut progress_callback: F,
    ) -> Vec<(String, Result<BookMetadata, String>)>
    where
        F: FnMut(usize, usize),
    {
        use futures::stream::{self, StreamExt};

        let total = items.len();

        let results: Vec<_> = stream::iter(items)
            .map(|(id, source)| async move {
                let result = self.process_book(&id, source).await;
                (id, result)
            })
            .buffer_unordered(concurrency.min(150))
            .collect::<Vec<_>>()
            .await;

        progress_callback(total, total);
        results
    }

    fn has_custom_providers(&self) -> bool {
        self.config
            .custom_providers
            .iter()
            .any(|p| p.enabled)
    }

    fn has_gpt_key(&self) -> bool {
        self.config
            .openai_api_key
            .as_ref()
            .map(|k| !k.is_empty())
            .unwrap_or(false)
    }

    fn to_book_metadata(&self, resolved: ResolvedMetadata) -> BookMetadata {
        let mut meta = BookMetadata::default();

        meta.title = resolved.title;
        meta.subtitle = resolved.subtitle;
        meta.author = resolved.author;
        meta.authors = resolved.authors;
        meta.narrator = resolved.narrator;
        meta.narrators = resolved.narrators;
        meta.description = resolved.description;
        meta.publisher = resolved.publisher;
        meta.year = resolved.year;
        meta.genres = resolved.genres;
        meta.language = resolved.language;

        // Primary series goes to main fields
        if let Some(primary) = resolved.series.iter().find(|s| s.is_primary) {
            meta.series = Some(primary.name.clone());
            meta.sequence = primary.sequence.clone();
        } else if let Some(first) = resolved.series.first() {
            meta.series = Some(first.name.clone());
            meta.sequence = first.sequence.clone();
        }

        // All series
        meta.all_series = resolved
            .series
            .into_iter()
            .map(|s| SeriesInfo {
                name: s.name,
                sequence: s.sequence,
                source: Some(MetadataSource::Gpt),
            })
            .collect();

        // Themes and tropes
        meta.themes = resolved.themes;
        meta.tropes = resolved.tropes;
        if !meta.themes.is_empty() {
            meta.themes_source = Some("gpt".to_string());
        }
        if !meta.tropes.is_empty() {
            meta.tropes_source = Some("gpt".to_string());
        }

        // Mark sources
        meta.sources = Some(crate::scanner::types::MetadataSources {
            title: Some(MetadataSource::Gpt),
            author: Some(MetadataSource::Gpt),
            narrator: meta.narrator.as_ref().map(|_| MetadataSource::Gpt),
            series: meta.series.as_ref().map(|_| MetadataSource::Gpt),
            genres: if !meta.genres.is_empty() {
                Some(MetadataSource::Gpt)
            } else {
                None
            },
            description: meta.description.as_ref().map(|_| MetadataSource::Gpt),
            ..Default::default()
        });

        meta
    }
}
