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
use crate::age_rating_resolver::{resolve_age_rating, AgeRatingInput};
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

        // Get title/author for custom provider search (clone to owned strings)
        let title: String = sources
            .iter()
            .find_map(|s| s.title.as_ref())
            .cloned()
            .unwrap_or_default();
        let author: String = sources
            .iter()
            .find_map(|s| s.authors.first())
            .cloned()
            .unwrap_or_default();

        // Fetch from custom providers
        if !title.is_empty() && self.has_custom_providers() {
            let custom = gather::fetch_custom_providers(&self.config, &title, &author).await;
            if !custom.is_empty() {
                println!("   ✓ Got {} custom provider results", custom.len());
                sources.extend(custom);
            }
        }

        // 2. Pre-filter obviously bad series from all sources
        let sources = pre_filter_series(sources, &title, &author);

        // 3. Build aggregated data
        let series_names = context::extract_series_names(&sources);

        // 4. CONTEXT - fetch other books in series
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

        // 5. DECIDE - send to GPT (if API key available)
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

        // 6. VALIDATE - catch GPT mistakes
        let validated = validate::validate_metadata(resolved, &aggregated)?;
        println!("   ✓ Validation passed");

        // 7. AGE RATING - optional web search for accurate age categorization
        let validated = if self.config.enable_age_rating_lookup && self.has_gpt_key() {
            self.enrich_age_rating(validated).await
        } else {
            validated
        };

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

    /// Enrich metadata with age rating from API data + GPT synthesis
    async fn enrich_age_rating(&self, mut meta: ResolvedMetadata) -> ResolvedMetadata {
        println!("   🔍 Looking up age rating via API + GPT...");

        let input = AgeRatingInput {
            title: meta.title.clone(),
            author: meta.author.clone(),
            series: meta.series.first().map(|s| s.name.clone()),
            description: meta.description.clone(),
            genres: meta.genres.clone(),
            publisher: meta.publisher.clone(),
        };

        match resolve_age_rating(&self.config, &input).await {
            Ok(rating) => {
                println!("   ✓ Age rating: {} ({})", rating.age_category, rating.confidence);

                // Add age tags to the existing tags
                for tag in rating.age_tags {
                    if !meta.tags.contains(&tag) {
                        meta.tags.push(tag);
                    }
                }

                // Add age category as a genre if it's a children's/YA book
                let age_genre = match rating.age_category.as_str() {
                    "Children's 0-2" | "Children's 3-5" | "Children's 6-8" | "Children's 9-12" => {
                        Some(rating.age_category.clone())
                    }
                    "Teen 13-17" => Some("Teen 13-17".to_string()),
                    "Young Adult" => Some("Young Adult".to_string()),
                    _ => None,
                };

                if let Some(genre) = age_genre {
                    if !meta.genres.contains(&genre) {
                        // Add at position 1 (after primary genre) or at start
                        if meta.genres.is_empty() {
                            meta.genres.push(genre);
                        } else {
                            meta.genres.insert(1.min(meta.genres.len()), genre);
                        }
                    }
                }

                meta
            }
            Err(e) => {
                println!("   ⚠ Age rating lookup failed: {}", e);
                meta
            }
        }
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

        // Single series (we now only keep one)
        if let Some(series) = resolved.series.first() {
            meta.series = Some(series.name.clone());
            meta.sequence = series.sequence.clone();
            // Also populate all_series for consistency (just the one)
            meta.all_series = vec![SeriesInfo {
                name: series.name.clone(),
                sequence: series.sequence.clone(),
                source: Some(MetadataSource::Gpt),
            }];
        }

        // Themes, tropes, and tags
        meta.themes = resolved.themes;
        meta.tropes = resolved.tropes;
        meta.tags = resolved.tags;
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

/// Pre-filter obviously bad series from all sources BEFORE sending to GPT
/// This prevents GPT from even seeing bad data in the first place
fn pre_filter_series(sources: Vec<SourceData>, title: &str, author: &str) -> Vec<SourceData> {
    let title_lower = title.to_lowercase();
    let author_lower = author.to_lowercase();

    sources.into_iter().map(|mut source| {
        let original_count = source.series.len();

        source.series.retain(|s| {
            let name_lower = s.name.to_lowercase();

            // 1. Reject foreign language series (Turkish, German, etc.)
            if is_foreign_series(&name_lower) {
                println!("   🚫 Pre-filter: Rejecting foreign series '{}'", s.name);
                return false;
            }

            // 2. Reject adaptation/retelling series
            if is_adaptation_series(&name_lower, &title_lower) {
                println!("   🚫 Pre-filter: Rejecting adaptation series '{}'", s.name);
                return false;
            }

            // 3. Reject series that match the title exactly (GPT mistake)
            let name_normalized = normalize_for_compare(&name_lower);
            let title_normalized = normalize_for_compare(&title_lower);
            if name_normalized == title_normalized && s.sequence.is_none() {
                println!("   🚫 Pre-filter: Rejecting series '{}' - matches title", s.name);
                return false;
            }

            // 4. Reject generic/marketing series
            if is_generic_series(&name_lower) {
                println!("   🚫 Pre-filter: Rejecting generic series '{}'", s.name);
                return false;
            }

            // 5. Reject author-as-series (e.g., "Dr. Seuss" series for Dr. Seuss books)
            if is_author_as_series(&name_lower, &author_lower) {
                println!("   🚫 Pre-filter: Rejecting author-as-series '{}'", s.name);
                return false;
            }

            // 6. Reject known wrong-author series (cross-contamination)
            if is_wrong_author_series(&name_lower, &author_lower) {
                println!("   🚫 Pre-filter: Rejecting wrong-author series '{}'", s.name);
                return false;
            }

            // 7. Reject series that look like person names (narrator, etc.)
            if is_person_name_series(&name_lower) {
                println!("   🚫 Pre-filter: Rejecting person-name series '{}'", s.name);
                return false;
            }

            true
        });

        if source.series.len() < original_count {
            println!("   📋 Pre-filter: {} → {} series for source '{}'",
                original_count, source.series.len(), source.source);
        }

        source
    }).collect()
}

/// Check for foreign language patterns in series name
fn is_foreign_series(name: &str) -> bool {
    // Turkish patterns
    let turkish = ["tiyatro", "oyun dizisi", "dizisi", "serisi", "kitaplari",
                   "kitaplar", "hikaye", "hikayeler", "masallar", "romani"];
    if turkish.iter().any(|p| name.contains(p)) {
        return true;
    }

    // German patterns
    let german = ["sammlung", "reihe", "baumhaus", "magisches", "magische"];
    if german.iter().any(|p| name.contains(p)) {
        return true;
    }

    // French patterns
    let french = ["cabane magique", "collection"];
    if french.iter().any(|p| name.contains(p)) {
        return true;
    }

    // Check for foreign prefixes (articles)
    let prefixes = ["la ", "le ", "les ", "das ", "der ", "die ", "el ", "los ", "las "];
    if prefixes.iter().any(|p| name.starts_with(p)) {
        return true;
    }

    false
}

/// Check for adaptation/retelling patterns
fn is_adaptation_series(name: &str, _title: &str) -> bool {
    let adaptation_patterns = [
        "stories", "tales", "graphic", "illustrated", "retelling",
        "adaptation", "children's", "childrens", "kids", "young readers",
        "classics illustrated", "manga", "comic", "made easy", "simplified",
        "study guide", "cliffsnotes", "sparknotes", "reader's digest",
        "easy reader", "picture book", "board book", "for kids", "for children",
    ];

    let has_pattern = adaptation_patterns.iter().any(|p| name.contains(p));
    if !has_pattern {
        return false;
    }

    // Classic author names that often have adaptation series
    let classic_authors = [
        "shakespeare", "dickens", "austen", "twain", "homer", "virgil",
        "tolstoy", "dostoevsky", "chaucer", "milton", "dante", "cervantes",
    ];

    // If has adaptation word AND classic author name, likely wrong
    if classic_authors.iter().any(|a| name.contains(a)) {
        return true;
    }

    // Generic adaptation patterns
    let generic_adaptations = [
        "classic tales", "fairy tales", "folk tales", "illustrated classics",
        "graphic classics", "manga classics", "classical comics",
    ];
    if generic_adaptations.iter().any(|p| name.contains(p)) {
        return true;
    }

    // "[Word] Stories" or "[Word] Tales" patterns
    if (name.ends_with(" stories") || name.ends_with(" tales")) && name.split_whitespace().count() <= 2 {
        return true;
    }

    false
}

/// Check for generic/marketing series names
fn is_generic_series(name: &str) -> bool {
    let generic = [
        "audiobook", "unabridged", "abridged", "bestseller", "bestsellers",
        "audible originals", "kindle unlimited", "prime reading",
        "award winner", "award winners", "pulitzer", "new york times",
        "timeless classic", "timeless classics", "great books", "must read",
        "classic literature", "book", "novel", "fiction", "nonfiction",
    ];

    generic.iter().any(|g| name == *g || name.ends_with(&format!(" {}", g)))
}

/// Normalize string for comparison
fn normalize_for_compare(s: &str) -> String {
    s.replace("the ", "")
        .replace(" series", "")
        .replace(" novels", "")
        .replace(" books", "")
        .trim()
        .to_string()
}

/// Check if series name is just the author name (e.g., "Dr. Seuss" for Dr. Seuss books)
fn is_author_as_series(series_name: &str, author: &str) -> bool {
    if author.is_empty() {
        return false;
    }

    let series_normalized = series_name
        .replace("dr.", "dr")
        .replace(".", "")
        .replace(",", "")
        .trim()
        .to_lowercase();

    let author_normalized = author
        .replace("dr.", "dr")
        .replace(".", "")
        .replace(",", "")
        .trim()
        .to_lowercase();

    // Direct match
    if series_normalized == author_normalized {
        return true;
    }

    // Check if series is author's last name only
    let author_parts: Vec<&str> = author_normalized.split_whitespace().collect();
    if author_parts.len() >= 2 {
        let last_name = author_parts.last().unwrap();
        if series_normalized == *last_name {
            return true;
        }
    }

    // Known author-as-series patterns
    let author_series: &[(&str, &[&str])] = &[
        ("dr seuss", &["dr seuss", "seuss", "dr. seuss"]),
        ("audrey wood", &["audrey and don wood", "audrey wood", "don wood"]),
        ("eric carle", &["eric carle", "carle"]),
        ("mo willems", &["mo willems", "willems"]),
    ];

    for (author_pattern, series_patterns) in author_series {
        if author_normalized.contains(author_pattern) {
            if series_patterns.iter().any(|p| series_normalized.contains(p)) {
                return true;
            }
        }
    }

    false
}

/// Check if series belongs to a different author (known cross-contamination)
fn is_wrong_author_series(series_name: &str, author: &str) -> bool {
    // Map of series -> their actual authors
    let series_author_map: &[(&str, &[&str])] = &[
        // Kendra Michaels is by Iris Johansen/Roy Johansen
        ("kendra michaels", &["iris johansen", "roy johansen", "johansen"]),
        // 1920s Lady Traveler in Egypt is by Elizabeth Peters
        ("1920s lady traveler", &["elizabeth peters", "peters"]),
        ("amelia peabody", &["elizabeth peters", "peters"]),
        // Whitney Logan is NOT a series - it's a character name
        ("whitney logan", &[]),
        // Inspector Banks is by Peter Robinson
        ("inspector banks", &["peter robinson"]),
        ("alan banks", &["peter robinson"]),
        // Roy Grace is by Peter James
        ("roy grace", &["peter james"]),
        // William Monk / Inspector Monk is by Anne Perry
        ("william monk", &["anne perry"]),
        ("inspector monk", &["anne perry"]),
        ("charlotte and thomas pitt", &["anne perry"]),
        ("thomas pitt", &["anne perry"]),
        // Chief Inspector Gamache is by Louise Penny
        ("gamache", &["louise penny"]),
        ("three pines", &["louise penny"]),
        // DC Smith is by Peter Grainger
        ("dc smith", &["peter grainger"]),
    ];

    let series_lower = series_name.to_lowercase();
    let author_lower = author.to_lowercase();

    for (series_pattern, valid_authors) in series_author_map {
        if series_lower.contains(series_pattern) {
            // If valid_authors is empty, it's not a real series
            if valid_authors.is_empty() {
                return true;
            }
            // Check if current author matches any valid author
            let author_matches = valid_authors.iter().any(|va| author_lower.contains(va));
            if !author_matches {
                return true; // Wrong author for this series
            }
        }
    }

    false
}

/// Check if series name looks like a person's name (narrator, illustrator, etc.)
fn is_person_name_series(name: &str) -> bool {
    // Very short names that are likely person names
    let words: Vec<&str> = name.split_whitespace().collect();

    // Skip if has series-like words
    let series_indicators = ["series", "chronicles", "saga", "trilogy", "collection", "adventures", "mysteries", "stories"];
    if series_indicators.iter().any(|s| name.contains(s)) {
        return false;
    }

    // Two-word names like "First Last" are suspicious
    if words.len() == 2 {
        // Check for common name patterns
        let first = words[0];
        let second = words[1];

        // If both words are capitalized short words, likely a name
        let common_first_names = [
            "james", "john", "mary", "anne", "peter", "paul", "david", "michael",
            "robert", "william", "richard", "thomas", "charles", "george", "edward",
            "elizabeth", "margaret", "jennifer", "susan", "patricia", "linda", "barbara",
            "audrey", "don", "eric", "mo", "dr",
        ];

        if common_first_names.iter().any(|n| first.starts_with(n)) && second.len() > 2 {
            // Looks like "FirstName LastName"
            // But exclude known valid series that happen to be names (character-based mystery/thriller series)
            let valid_name_series = [
                // Major character series
                "harry potter", "percy jackson", "jack reacher", "jack ryan",
                "alex cross", "kinsey millhone", "kay scarpetta", "stephanie plum",
                "peter diamond", "william wisting", "john keller", "johnny merrimon",
                "peter pan", "mary russell", "adam dalgliesh", "cordelia gray",
                "elvis cole", "joe pike", "lucas davenport", "virgil flowers",
                "harry bosch", "mickey haller", "renee ballard", "lincoln rhyme",
                "amelia sachs", "cotton malone", "gray man", "mitch rapp",
                "scot harvath", "joe ledger", "john puller", "amos decker",
                "will trent", "faith mitchell", "sara linton", "jeffrey tolliver",
                "cormoran strike", "dave robicheaux", "easy rawlins", "spenser",
                "jesse stone", "sunny randall", "myron bolitar", "win lockwood",
            ];
            if !valid_name_series.iter().any(|vs| name.contains(vs)) {
                return true;
            }
        }
    }

    // Three-word patterns like "First Middle Last" or "First and Last"
    if words.len() == 3 && words[1] == "and" {
        // "Audrey and Don" pattern - likely illustrators/authors
        return true;
    }

    // Single generic words that aren't series
    let not_series = ["beginner", "classics", "classic", "collection", "anthology"];
    if words.len() == 1 && not_series.contains(&name) {
        return true;
    }

    false
}
