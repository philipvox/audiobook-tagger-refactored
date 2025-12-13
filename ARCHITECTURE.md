# AUDIOBOOK TAGGER - COMPREHENSIVE TECHNICAL DOCUMENTATION

Based on thorough exploration of the codebase, here is the complete technical architecture and design documentation for the Audiobook Tagger application.

---

## **1. PROJECT OVERVIEW**

**Audiobook Tagger** is a Tauri-based desktop application (Rust backend + React frontend) for automatically tagging and organizing audiobook files using multi-source metadata enrichment (Audible, Google Books, AudiobookShelf APIs, and optional GPT processing).

**Key Stats:**
- **Type**: Cross-platform desktop app (macOS, Windows, Linux support)
- **Frontend**: React 18 with Vite + TailwindCSS
- **Backend**: Rust with Tokio async runtime
- **UI Framework**: Tauri 2.0
- **Audio Tagging Library**: lofty 0.19 (MP3, FLAC, OGG) + mp4ameta (M4A/M4B)

---

## **2. PROJECT STRUCTURE**

```
audiobook-tagger-refactored/
├── src/                              # React frontend
│   ├── main.jsx                      # React entry point
│   ├── App.jsx                       # Main app component with tabs
│   ├── context/AppContext.jsx        # Global state management
│   ├── pages/
│   │   ├── ScannerPage.jsx          # Main scanning interface
│   │   ├── MaintenancePage.jsx      # Cache/genre management
│   │   ├── SettingsPage.jsx         # Config management
│   │   ├── FolderFixerPage.jsx      # Folder organization
│   │   ├── SmartRenamePage.jsx      # File renaming
│   │   └── DuplicateFinderPage.jsx  # Duplicate detection
│   ├── components/
│   │   ├── scanner/
│   │   │   ├── BookList.jsx         # Virtualized book list
│   │   │   ├── MetadataPanel.jsx    # Metadata display
│   │   │   ├── ActionBar.jsx        # Action buttons
│   │   │   └── ProgressBar.jsx      # Progress indicator
│   │   ├── modals/
│   │   │   ├── EditMetadataModal.jsx
│   │   │   ├── BulkEditModal.jsx
│   │   │   ├── CoverSearchModal.jsx
│   │   │   ├── RenamePreviewModal.jsx
│   │   │   ├── ExportImportModal.jsx
│   │   │   └── RescanModal.jsx
│   │   ├── GlobalProgressBar.jsx    # App-wide progress
│   │   └── RawTagInspector.jsx      # Tag debugging tool
│   └── hooks/
│       ├── useScan.js               # Scanning logic
│       ├── useTagOperations.js      # Write/push operations
│       └── useFileSelection.js      # Selection management
│
└── src-tauri/
    ├── src/
    │   ├── main.rs                  # Tauri app entry point
    │   ├── config.rs                # Configuration management
    │   ├── cache.rs                 # Sled-based caching
    │   ├── progress.rs              # Progress tracking
    │   │
    │   ├── commands/                # Tauri IPC commands
    │   │   ├── mod.rs              # Command registry
    │   │   ├── scan.rs             # Scanning commands
    │   │   ├── tags.rs             # Tag writing (JSON)
    │   │   ├── abs.rs              # AudiobookShelf integration
    │   │   ├── covers.rs           # Cover search/download
    │   │   ├── chapters.rs         # Chapter management
    │   │   ├── rename.rs           # File renaming
    │   │   ├── config.rs           # Config get/save
    │   │   ├── audible.rs          # Audible CLI wrapper
    │   │   ├── maintenance.rs      # Cache/genre cleanup
    │   │   ├── export.rs           # CSV/JSON export
    │   │   ├── genres.rs           # Genre normalization
    │   │   ├── folder_fixer.rs     # Folder organization
    │   │   ├── smart_rename.rs     # Smart file renaming
    │   │   └── duplicates.rs       # Duplicate detection
    │   │
    │   ├── scanner/                 # Core scanning logic
    │   │   ├── mod.rs              # Main scanner
    │   │   ├── types.rs            # Data structures
    │   │   ├── collector.rs        # File collection/grouping
    │   │   └── processor.rs        # Metadata enrichment
    │   │
    │   ├── audible.rs              # Audible API client
    │   ├── audible_auth.rs         # Auth handling (stub)
    │   ├── abs_search.rs           # AudiobookShelf search
    │   ├── cover_art.rs            # Cover fetching/embedding
    │   ├── metadata.rs             # Google Books integration
    │   ├── normalize.rs            # Text normalization
    │   ├── genres.rs               # Genre definitions
    │   ├── genre_cache.rs          # Genre caching
    │   ├── tags.rs                 # Audio tag writing
    │   ├── tag_inspector.rs        # Tag inspection
    │   ├── chapters.rs             # Chapter detection/split
    │   ├── folder_fixer.rs         # Folder organization logic
    │   ├── smart_rename.rs         # Smart rename logic
    │   ├── duplicate_finder.rs     # Duplicate detection
    │   ├── whisper.rs              # Audio transcription (stub)
    │   ├── folder_watcher.rs       # File system watching
    │   ├── file_rename.rs          # File renaming utility
    │   └── Cargo.toml              # Dependencies
    │
    └── tauri.conf.json             # Tauri configuration
```

---

## **3. RUST BACKEND (src-tauri/src/)**

### **3.1 ENTRY POINT (main.rs)**

The Tauri application initializes with a plugin system and command handler:

**Registered Commands (47 total):**
- **Scanning**: `scan_library`, `import_folders`, `cancel_scan`, `get_scan_progress`, `rescan_fields`
- **Tags**: `write_tags`, `inspect_file_tags`
- **Files**: `preview_rename`, `rename_files`, `get_rename_templates`
- **AudiobookShelf**: `test_abs_connection`, `push_abs_updates`, `force_abs_rescan`, `import_from_abs`, `rescan_abs_imports`, `push_abs_imports`, `clear_abs_library_cache`
- **Covers**: `get_cover_for_group`, `search_cover_options`, `search_covers_multi_source`, `download_cover_from_url`, `set_cover_from_file`
- **Chapters**: `check_ffmpeg`, `get_chapters`, `detect_chapters_silence`, `split_audiobook_chapters`
- **Maintenance**: `clear_cache`, `get_cache_stats`, `normalize_genres`, `get_genre_stats`
- **Export/Import**: `export_to_csv`, `export_to_json`, `import_from_csv`, `import_from_json`

### **3.2 DATA STRUCTURES (scanner/types.rs)**

**Core Type Hierarchy:**

```rust
// Metadata source tracking
enum MetadataSource {
    FileTag,   // Existing audio tags
    Folder,    // Inferred from folder structure
    Audible,   // From Audible API
    ITunes,    // From iTunes/Apple API
    Gpt,       // Enhanced by GPT
    Manual,    // User-provided
    Unknown,
    Abs,       // AudiobookShelf search API
}

// Book metadata
struct BookMetadata {
    title: String,
    author: String,          // Single author for grouping
    authors: Vec<String>,    // Multiple authors for tags
    narrator: Option<String>,
    narrators: Vec<String>,  // Multiple narrators
    series: Option<String>,  // Series name
    sequence: Option<String>, // Book number in series
    genres: Vec<String>,     // Multiple genres (normalized)
    subtitle: Option<String>,
    publisher: Option<String>,
    publish_date: Option<String>,
    description: Option<String>,
    isbn: Option<String>,
    asin: Option<String>,    // Audible identifier
    language: Option<String>,
    cover_url: Option<String>,
    cover_mime: Option<String>,
    cover_provider: Option<String>,
    total_changes: usize,
}

// File-level metadata change
struct MetadataChange {
    old: String,  // Previous value
    new: String,  // New value
    source: MetadataSource,
    confidence: u8,  // 0-100
}

// Audio file representation
struct AudioFile {
    id: String,      // Unique ID (hash of path)
    path: String,    // Full file path
    filename: String,
    changes: HashMap<String, MetadataChange>,  // Per-field changes
}

// Book group (all files for one book)
struct BookGroup {
    id: String,      // UUID
    group_name: String,  // Display name
    metadata: BookMetadata,
    files: Vec<AudioFile>,
    scan_status: ScanStatus,  // How metadata was obtained
    total_changes: usize,     // Count of metadata changes
    series_info: Vec<SeriesInfo>,  // Multi-series support
}

// Series information
struct SeriesInfo {
    name: String,
    sequence: Option<String>,
    source: MetadataSource,
    confidence: u8,
}

// Scan result
struct ScanResult {
    groups: Vec<BookGroup>,
    total_files: usize,
    total_groups: usize,
}

// Scan modes
enum ScanMode {
    Normal,           // Skip books with metadata.json + cover
    RefreshMetadata,  // Bypass metadata.json, use API cache
    ForceFresh,       // Clear cache, fetch all fresh
    SelectiveRefresh, // Refresh only selected fields
    SuperScanner,     // Maximum accuracy with retries
}

// Selective field refresh
struct SelectiveRefreshFields {
    authors: bool,
    narrators: bool,
    description: bool,
    series: bool,
    genres: bool,
    publisher: bool,
    cover: bool,
}

// Scan status
enum ScanStatus {
    NewScan,         // Freshly scanned from API
    LoadedFromFile,  // Loaded from metadata.json
}
```

### **3.3 CONFIGURATION (config.rs)**

**Config Structure:**
```rust
struct Config {
    // AudiobookShelf integration
    abs_base_url: String,           // e.g., "http://localhost:13378"
    abs_api_token: String,          // API token for ABS
    abs_library_id: String,         // Library ID in ABS

    // External APIs
    openai_api_key: Option<String>, // GPT-5-nano for enhancement
    librarything_dev_key: Option<String>,

    // Performance tuning
    performance_preset: String,     // "conservative", "balanced", "performance", "extreme"

    // Individual concurrency overrides (None = use preset-derived)
    concurrency_metadata: Option<usize>,       // Metadata API calls
    concurrency_super_scanner: Option<usize>,  // SuperScanner mode
    concurrency_json_writes: Option<usize>,    // JSON write operations
    concurrency_abs_push: Option<usize>,       // Push to ABS
    concurrency_file_scan: Option<usize>,      // File scanning

    // Feature flags
    backup_tags: bool,          // Backup files before writing
    genre_enforcement: bool,    // Enforce approved genres only
}
```

**Preset-based Concurrency:**

| Preset | Metadata | SuperScanner | JSON Writes | ABS Push | File Scan |
|--------|----------|--------------|-------------|----------|-----------|
| Conservative | 7 | 2 | 50 | 30 | 5 |
| Balanced | 15 | 5 | 100 | 60 | 10 |
| Performance | 30 | 10 | 200 | 120 | 20 |
| Extreme | 60 | 20 | 400 | 240 | 40 |

### **3.4 SCANNING SYSTEM (scanner/)**

#### **3.4.1 Collector (scanner/collector.rs)**

**File Collection Process:**
1. Walk directories recursively using `walkdir` crate
2. Filter for audio extensions: `m4b, m4a, mp3, flac, ogg, opus, aac`
3. Group files by parent directory (assumes 1 book = 1 directory)
4. Natural sort files by filename (handles track numbers: 01, 02, etc.)
5. Load existing metadata.json if present
6. Return `Vec<BookGroup>` for processing

**File Grouping Logic:**
- **Default**: All files in same directory = one book
- **Chapter Folders**: Files in subdirectories get special handling
- **Sort Order**: Natural numeric sort (01, 02, 10 not 1, 10, 2)

#### **3.4.2 Processor (scanner/processor.rs)**

**Metadata Enrichment Pipeline:**

```
1. READ EXISTING TAGS
   ↓
2. FOLDER ANALYSIS
   ├── Extract: title, author from folder name
   ├── Detect: series info from filename patterns
   └── Estimate: confidence scores
   ↓
3. API CALLS (conditional based on scan mode)
   ├── Audible Search (if configured)
   │   └── Via audible-cli tool
   ├── AudiobookShelf Search (if configured)
   │   └── Waterfall: Audible → Google → iTunes
   ├── Google Books (fallback)
   └── iTunes (fallback)
   ↓
4. CROSS-VALIDATION
   ├── Compare sources for conflicts
   ├── Calculate confidence scores
   ├── Detect mismatches
   └── Prepare GPT input if needed
   ↓
5. SERIES DETECTION (critical logic)
   ├── Extract from Audible response
   ├── Parse from folder structure
   ├── Normalize series name
   ├── Extract compound series (parent/sub)
   └── Validate with cross-source agreement
   ↓
6. COVER FETCHING
   ├── Check local folder first (cover.jpg, folder.jpg)
   ├── Check cache
   ├── Fetch from APIs (Audible, iTunes, Google Books)
   └── Score and select best
   ↓
7. GENRE NORMALIZATION
   ├── Map to approved genres list
   ├── Handle children's age ranges
   ├── Remove duplicates
   └── Enforce if configured
   ↓
8. TEXT NORMALIZATION
   ├── Title case conversion
   ├── Remove junk suffixes: (Unabridged), 320kbps, etc.
   ├── Clean author names
   └── Validate narrator field
   ↓
9. BUILD METADATA CHANGES
   └── Output: HashMap<field, MetadataChange>
```

**Series Detection Logic (DETAILED):**

The series handling is the most complex part of the processor:

```rust
// Extract all series from compound names
fn extract_all_series_from_name(name: &str, position: Option<&str>) -> Vec<(String, Option<String>)>

// Handles patterns like:
// - "Magic Tree House: Merlin Missions" #5
//   → [("Magic Tree House", None), ("Merlin Missions", Some("5"))]
// - "Percy Jackson and the Olympians" #3
//   → [("Percy Jackson and the Olympians", Some("3"))]
// - "Harry Potter" (with "and the" in title)
//   → ["Harry Potter"] (not "Harry Potter and the...")

// Known compound patterns (hardcoded):
// - "magic tree house: merlin missions" ↔ 2 series
// - "percy jackson" ↔ "Percy Jackson and the Olympians"
// - "heroes of olympus" ↔ "Percy Jackson Universe" parent
// - "trials of apollo" ↔ "Percy Jackson Universe" parent

// Normalization removes:
// - Trailing " (Book X)", " (Books X)"
// - Trailing " Series", " Trilogy", " Saga", " Chronicles"
// - "Book Title - Series Name" patterns (extracts Series Name)
// - Trailing dashes and commas
```

**Key Processor Functions:**

```rust
async fn process_all_groups_with_options(
    groups: Vec<BookGroup>,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    scan_mode: ScanMode,
    selective_fields: Option<SelectiveRefreshFields>,
    enable_transcription: bool,
) -> Result<Vec<BookGroup>>

async fn process_book_group_with_options(
    mut group: BookGroup,
    config: &Config,
    cancel_flag: Option<Arc<AtomicBool>>,
    covers_found: Arc<AtomicUsize>,
    scan_mode: ScanMode,
    selective_fields: Option<SelectiveRefreshFields>,
    enable_transcription: bool,
) -> Result<BookGroup>

// Retry wrapper for SuperScanner mode
async fn with_retry<T, F, Fut>(
    operation_name: &str,
    max_retries: u32,
    base_delay_ms: u64,
    operation: F,
) -> Option<T>

// Cross-validation across sources
fn cross_validate_sources(
    folder_meta: &BookMetadata,
    audible: Option<&AudibleMetadata>,
) -> SourceValidation

// Similarity checking
fn titles_similar(a: &str, b: &str) -> bool
fn authors_similar(a: &str, b: &str) -> bool
```

### **3.5 API INTEGRATIONS**

#### **3.5.1 Audible (audible.rs)**

**Integration Type**: CLI-based (requires `audible-cli` installed and authenticated)

**Function Signature:**
```rust
pub async fn search_audible(
    title: &str,
    author: &str,
    cli_path: &str,
) -> Result<Option<AudibleMetadata>>
```

**Process:**
1. Spawns `audible-cli` subprocess
2. Command: `audible api 1.0/catalog/products -p keywords="title author" -p num_results=3 -p response_groups=product_desc,product_attrs,contributors,series`
3. Parses JSON response
4. Extracts: title, subtitle, authors, narrators, series, publisher, description, ASIN, language, runtime, abridged flag

**Series Format from Audible:**
```json
{
  "series": [
    { "title": "Series Name", "sequence": "1" },
    { "title": "Sub-Series Name", "sequence": "2" }
  ]
}
```

**Error Handling:**
- Timeout: 30 seconds per query
- Subprocess failures → Returns `Ok(None)` (graceful fallback)
- Parsing errors → Logs and continues

#### **3.5.2 AudiobookShelf Search (abs_search.rs)**

**Integration Type**: HTTP API proxy (ABS proxies Audible, Google Books, iTunes)

**Waterfall Strategy:**
```
Try Provider 1 (Audible)
  → Success? Use it
  → Fail? Try Provider 2 (Google Books)
    → Success? Use it
    → Fail? Try Provider 3 (iTunes)
      → Success? Use it
      → Fail? Return None
```

**Function:**
```rust
pub async fn search_metadata_waterfall(
    config: &Config,
    title: &str,
    author: &str,
) -> Option<AbsSearchResult>

// Per-provider search
pub async fn search_abs_provider(
    config: &Config,
    provider: &str,
    title: &str,
    author: &str,
) -> Option<AbsSearchResult>
```

**URL Format:**
```
GET {abs_base_url}/api/search/books?provider={provider}&title={title}&author={author}
Authorization: Bearer {api_token}
```

**Response Parsing:**
- Handles multiple provider formats (Audible, Google, iTunes)
- Maps fields: `title`, `subtitle`, `author`, `narrator`, `publisher`, `publishedYear`, `description`, `cover`, `isbn`, `asin`, `language`, `genres`, `tags`, `duration`, `abridged`
- Series: Array of `{ series: "name", sequence: "1" }`

#### **3.5.3 Cover Art (cover_art.rs)**

**Cover Search Pipeline:**

```
1. Check cache (sled DB)
   ├── Hit? Return
   └── Miss? Continue

2. Check local folder
   ├── Look for: cover.jpg, cover.jpeg, cover.png, folder.jpg, folder.png
   ├── Found? Cache and return
   └── Not found? Continue

3. Fetch from APIs (parallel)
   ├── Audible (via audible-cli)
   ├── iTunes (Apple Books API)
   ├── Google Books API
   ├── AudiobookShelf search
   └── Collect candidates

4. Score candidates
   ├── Resolution (max 50 pts)
   │  - 2000px+ = 50
   │  - 1500px = 45
   │  - 1000px = 40
   │  - 500px = 30
   │  - <300px = 10
   ├── Source trust (max 30 pts)
   │  - iTunes = 30
   │  - Audible = 28
   │  - ABS = 28
   │  - Google Books = 20
   │  - User provided = 30
   ├── Aspect ratio (max 20 pts)
   │  - 1:1 square = 20
   │  - 1.3-1.7 portrait = 18
   │  - 0.6-1.4 acceptable = 10
   │  - Weird = 5
   └── Select best (max score)

5. Download and cache
   └── Store: (data, mime_type) in sled
```

**Cover Embedding:**

Supports embedding into audio file tags:
- **M4A/M4B**: `mp4ameta` crate (covr atom)
- **MP3**: `lofty` crate (ID3v2 APIC frame)
- **FLAC/OGG**: `lofty` crate (Picture blocks)

#### **3.5.4 Google Books (metadata.rs)**

**API Query:**
```
GET https://www.googleapis.com/books/v1/volumes?q=intitle:{title}+inauthor:{author}
```

**Fields Extracted:**
- Title, subtitle
- Authors, publisher
- Published date, description
- Categories (mapped to genres)
- ISBN-10/13
- Cover image (extracts largest available)

**Error Handling:**
- Query cleaning (removes: "Unabridged", bitrate markers, etc.)
- Timeout: 10 seconds
- Returns `Ok(None)` on error (graceful degradation)

### **3.6 TAG WRITING (tags.rs & commands/tags.rs)**

**Key Insight**: App writes `metadata.json` files instead of modifying audio tags directly (for speed and safety).

**Process:**

```rust
pub async fn write_tags(
    window: tauri::Window,
    request: WriteRequest
) -> Result<WriteResult>

// WriteRequest contains:
struct WriteRequest {
    file_ids: Vec<String>,
    files: HashMap<String, FileData>,  // file_id → metadata changes
    backup: bool,
}

// FileData:
struct FileData {
    path: String,
    changes: HashMap<String, MetadataChange>,  // field → change
}

// WriteResult:
struct WriteResult {
    success: usize,
    failed: usize,
    errors: Vec<WriteError>,
}
```

**Phases:**

```
PHASE 1: GROUPING (Emit "grouping" progress)
  ↓ Group files by parent directory (book folder)

PHASE 2: BUILDING METADATA.JSON (Emit "writing" progress)
  ↓ For each unique book folder:
    ├── Collect all changes from all files in folder
    ├── Build ABS metadata.json format:
    │   {
    │     "title": "...",
    │     "authors": ["..."],
    │     "narrators": ["..."],
    │     "series": [
    │       { "name": "Series Name", "sequence": "1" }
    │     ],
    │     "genres": ["Fiction", "Mystery"],
    │     "publishedYear": "2023",
    │     ...
    │   }
    ├── Write to {folder}/metadata.json
    └── Emit progress every 20 books

PHASE 3: COMPLETION
  └── Emit final summary
```

**ABS Metadata Format:**

```rust
#[derive(Debug, Serialize)]
struct AbsMetadata {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    authors: Vec<String>,
    narrators: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    series: Vec<AbsSeries>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    genres: Vec<String>,
    #[serde(rename = "publishedYear", skip_serializing_if = "Option::is_none")]
    published_year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    isbn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
struct AbsSeries {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence: Option<String>,
}
```

**Direct Audio Tag Writing (tags.rs):**

For non-JSON environments, direct audio file modification:

```rust
pub fn write_file_tags_sync(
    file_path: &str,
    changes: &HashMap<String, MetadataChange>,
    backup: bool,
) -> Result<()>
```

**Tag Mappings:**

| Metadata Field | M4A/M4B Tag | MP3 Tag | FLAC Tag |
|---|---|---|---|
| Title | setTitle | Title (TIT2) | TITLE |
| Author | setArtist + setAlbumArtist | Artist (TPE1) | ARTIST |
| Album | setAlbum | Album (TALB) | ALBUM |
| Narrator | setComposer | Composer (TCOM) | COMPOSER |
| Genre | ©gen atom | Genre (TCON) | GENRE |
| Description | setComment | Comment (COMM) | DESCRIPTION |
| Year | setYear | Date (TDRC) | DATE |
| Series | seri atom (custom) | TXXX:SERIES | SERIES |
| Sequence | sequ atom (custom) | TXXX:SEQUENCE | SEQUENCE |
| Publisher | setCopyright | Copyright (TCOP) | COPYRIGHT |

### **3.7 GENRE HANDLING (genres.rs)**

**Approved Genres List:**

The app enforces a whitelist of 100+ approved genres organized by category:

**Fiction (40 genres):**
Action, Adventure, Anthology, Chick Lit, Classic, Comedy, Coming of Age, Contemporary, Crime, Drama, Dystopian, Erotica, Family Saga, Fantasy, Fiction, Gothic, Historical Fiction, Horror, Humor, Legal Thriller, Literary Fiction, Magic, Military, Mystery, Mythology, Paranormal, Political Thriller, Post-Apocalyptic, Psychological Thriller, Romance, Satire, Science Fiction, Short Stories, Spy, Supernatural, Suspense, Techno-Thriller, Thriller, Time Travel, Urban Fantasy, War, Western, Women's Fiction

**Non-Fiction (30+ genres):**
Arts, Autobiography, Biography, Business, Cooking, Current Events, Economics, Education, Essays, Gardening, Health, History, Journalism, LGBTQ+, Memoir, Music, Nature, Parenting, Philosophy, Photography, Poetry, Politics, Psychology, Reference, Religion, Science, Self-Help, Social Science, Spirituality, Sports, Technology, Travel, True Crime

**Children's Age Categories (IMPORTANT - Mutually Exclusive):**
- Children's 0-2 (Baby/Toddler)
- Children's 3-5 (Preschool)
- Children's 6-8 (Early Reader/Chapter Books)
- Children's 9-12 (Middle Grade)
- Teen 13-17 (Young Adult)

**Series Age Detection:**

Built-in mapping of 150+ children's series to age categories:

```rust
// Examples:
"goodnight moon" → "Children's 0-2"
"curious george" → "Children's 3-5"
"magic tree house" → "Children's 6-8"
"percy jackson" → "Children's 9-12"
"hunger games" → "Teen 13-17"
"harry potter" → "Children's 9-12"
"twilight" → "Teen 13-17"
```

**Normalization Process:**

```rust
pub fn normalize_genres(
    genres: Vec<String>,
    series_name: Option<&str>,
    config: &Config
) -> Vec<String>

// Steps:
1. Remove empty strings
2. Trim whitespace
3. Title-case each genre
4. Check children's series mapping
5. Filter to approved genres only (if enforcement enabled)
6. Deduplicate
7. Return sorted list
```

### **3.8 TEXT NORMALIZATION (normalize.rs)**

**Title Case Conversion:**

```rust
pub fn to_title_case(title: &str) -> String
```

**Rules:**
- First and last words always capitalized
- Small words lowercase: a, an, the, and, but, or, in, of, on, to, via, de, la, le, el, en, et
- Preserves proper nouns (mixed case) and acronyms
- Detects camelCase and internal capitals (e.g., iPhone, McDonald)

**Junk Suffix Removal:**

```rust
pub fn remove_junk_suffixes(title: &str) -> String
```

**Removes (case-insensitive):**
- `(Unabridged)`, `[Unabridged]`, `(Abridged)`
- `(Audiobook)`, `[Audiobook]`
- `(Retail)`, `[Retail]`
- `(MP3)`, `[MP3]`, `(M4B)`, `[M4B]`
- Bitrate markers: `320kbps`, `256kbps`, `128kbps`, `64kbps`
- `(HQ)`, `(Complete)`, `(Full Cast)`

### **3.9 AudiobookShelf INTEGRATION (commands/abs.rs)**

**Push to ABS Workflow:**

```
REQUEST: Batch of (path, metadata, group_id)
  ↓
PHASE 1: CONNECTING
  └── Verify ABS is accessible

PHASE 2: FETCHING LIBRARY
  └── Paginated fetch of all library items (200 per page)
  └── Build path → item_id mapping
  └── Cache for 5 minutes

PHASE 3: MATCHING
  └── For each book:
     ├── Normalize path
     ├── Find matching item in ABS library
     ├── Track unmatched (no path match found)
     └── Deduplicate (prevent duplicate updates)

PHASE 4: PUSHING UPDATES
  └── For each matched item:
     ├── POST to /api/items/{item_id}/metadata
     │  └── Update title, authors, narrators, series, genres, etc.
     ├── POST cover to /api/items/{item_id}/cover (if available)
     └── Emit progress every 20 items

PHASE 5: COMPLETION
  └── Return summary: updated, unmatched, failed, covers_uploaded
```

**Push Request Structure:**

```rust
struct PushRequest {
    items: Vec<PushItem>
}

struct PushItem {
    path: String,                          // File path
    metadata: scanner::BookMetadata,       // Enriched metadata
    group_id: String,                      // For cover lookup
}

struct PushResult {
    updated: usize,
    unmatched: Vec<String>,    // Paths not found in ABS
    failed: Vec<PushFailure>,  // Update attempts that failed
    covers_uploaded: usize,
}
```

### **3.10 CACHE SYSTEM (cache.rs)**

**Storage:** Sled (embedded key-value database)

**Cache Keys:**
- `cover_{group_id}` → `(Vec<u8>, String)` (binary, mime_type)
- `metadata_{path_hash}` → Serialized metadata
- `genre_map_{key}` → Genre mapping
- `audible_{title_author_hash}` → AudibleMetadata
- `abs_{title_author_hash}` → AbsSearchResult
- `google_{title_author_hash}` → BookMetadata

**Cache Behavior by Scan Mode:**

| Scan Mode | Metadata Cache | Cover Cache | Action |
|---|---|---|---|
| Normal | Use | Use | Skip if metadata.json + cover exist |
| RefreshMetadata | Use | Use | Bypass metadata.json, use API cache |
| ForceFresh | Clear | Clear | Full rescan, clear all caches |
| SelectiveRefresh | Mixed | Use | Refresh selected fields, cache others |
| SuperScanner | Clear | Clear | Maximum accuracy, fresh API calls |

---

## **4. REACT FRONTEND (src/)**

### **4.1 STATE MANAGEMENT (context/AppContext.jsx)**

**AppContext Structure:**

```javascript
{
  // Configuration
  config: Config,
  setConfig: (config) => void,
  loadConfig: () => Promise<void>,
  saveConfig: (config) => Promise<{success, error}>,

  // Book groups (scan results)
  groups: BookGroup[],
  setGroups: (groups) => void,

  // File operation status tracking
  fileStatuses: {[fileId]: 'success' | 'failed' | ...},
  updateFileStatus: (fileId, status) => void,
  updateFileStatuses: (statusMap) => void,
  clearFileStatuses: () => void,

  // Write progress (metadata.json writing)
  writeProgress: {
    current: number,      // Files processed
    total: number,        // Total files
    phase: string,        // 'grouping' | 'writing' | 'complete'
    message: string,
  },
  setWriteProgress: (progress) => void,

  // Global progress (any long operation)
  globalProgress: {
    active: boolean,
    current: number,
    total: number,
    message: string,
    detail: string,
    canCancel: boolean,
    type: 'info' | 'warning' | 'danger' | 'success',
    cancelFn: () => void,
  },
  startGlobalProgress: ({message, total, canCancel, type, cancelFn}) => void,
  updateGlobalProgress: ({current, total, message, detail}) => void,
  endGlobalProgress: () => void,
  cancelGlobalProgress: () => void,
}
```

**Event Listeners:**
- `write_progress` events (emitted from Rust during tag writing)
- `push_progress` events (emitted from Rust during ABS push)

### **4.2 MAIN APP STRUCTURE (App.jsx)**

**Tab System:**
1. **Scanner** - Main scanning, metadata review, tag writing
2. **Maintenance** - Cache cleanup, genre normalization, stats
3. **Folder Fixer** - Organize folders by series/author
4. **Smart Rename** - AI-powered file renaming
5. **Duplicates** - Find and remove duplicate books
6. **Settings** - Configuration

**Scan Mode Dropdown:**
- **Smart Scan** (normal): Skip books with existing metadata.json
- **Clean Scan** (force_fresh): Clear caches, fetch all fresh
- **Super Scanner** (super_scanner): Max accuracy, retries, GPT on all

**Global Components:**
- `RawTagInspector` - Tag debugging modal
- `GlobalProgressBar` - App-wide progress overlay

### **4.3 SCANNER PAGE (pages/ScannerPage.jsx)**

**Layout:**
```
┌─ ActionBar ─────────────────────────────────┐
│ [Scan] [Import] [Rescan] [Write] [Push ABS] │
└─────────────────────────────────────────────┘
┌─ BookList (Virtualized) ──────────────────────────────────┐
│ [Book 1] ✓ Title by Author (# changes) [▼ expand] Genre  │
│ [Book 2] ✗ Title by Author (# changes) [▼ expand] Genre  │
│ [Book 3]   Title by Author (# changes) [▼ expand] Genre  │
│ ...                                                       │
└─────────────────────────────────────────────────────────┘
┌─ MetadataPanel (selected book) ──────────────────────────┐
│ Title: ... [edit]                                        │
│ Author: ... [edit]                                       │
│ Series: ... [edit]                                       │
│ Narrator: ... [edit]                                     │
│ Genres: ... [edit]                                       │
│ Description: ... [edit]                                  │
│ [Write Tags] [Push to ABS] [Edit Metadata]              │
└──────────────────────────────────────────────────────────┘
```

**Features:**
- **Virtualized List** (ITEM_HEIGHT=140px) - handles 10k+ books smoothly
- **Search/Filter** - title, author, series, narrator, genre, scan status
- **Selection** - individual, group, all; Shift+click range select
- **Modals**:
  - `EditMetadataModal` - Edit single book
  - `BulkEditModal` - Edit multiple books
  - `RenamePreviewModal` - Preview file renaming
  - `ExportImportModal` - CSV/JSON export/import
  - `RescanModal` - Selective field rescan

### **4.4 BOOK LIST COMPONENT (components/scanner/BookList.jsx)**

**Virtualization:**
```javascript
const ITEM_HEIGHT = 140;  // Estimated height of one book row
const BUFFER_SIZE = 10;   // Render 10 items above/below viewport

// Calculate visible range on scroll
const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
const visibleCount = Math.ceil(clientHeight / ITEM_HEIGHT) + BUFFER_SIZE * 2;
const end = Math.min(filteredGroups.length, start + visibleCount);

// Only render groups[start:end]
```

**Filtering:**
```javascript
const filters = {
  hasCover: null,      // null = all, true = with, false = without
  hasSeries: null,
  hasChanges: null,
  genre: '',           // empty = all, or specific genre
  scanStatus: '',      // empty = all, 'new_scan' or 'loaded_from_file'
}
```

**Cover Cache:**
```javascript
// Cache cover blob URLs to avoid re-fetching
const [coverCache, setCoverCache] = useState({});
const blobUrlsRef = useRef(new Map());  // For cleanup on unmount
```

### **4.5 HOOKS**

#### **4.5.1 useScan.js**

**Core scanning hook:**

```javascript
export function useScan() {
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    current: 0,           // Books processed
    total: 0,
    currentFile: '',      // Current file path
    startTime: null,
    filesPerSecond: 0,    // Calculated rate
    covers_found: 0,
  });

  // Poll progress every 1 second
  const progressIntervalRef = useRef(null);

  const handleScan = useCallback(async (scanMode = 'normal') => {
    // 1. Open folder picker
    const paths = await open({ directory: true, multiple: true });

    // 2. Start polling get_scan_progress
    setScanning(true);
    progressIntervalRef.current = setInterval(async () => {
      const progress = await invoke('get_scan_progress');
      // Calculate ETA from filesPerSecond
    }, 1000);

    // 3. Invoke scan_library with mode
    const result = await invoke('scan_library', {
      paths,
      scanMode
    });

    // 4. Update global groups
    setGroups(result.groups);
    setScanning(false);
  }, [setGroups]);

  const handleImport = useCallback(async () => {
    // Import folders without metadata scan
    const result = await invoke('import_folders', { paths });
    setGroups(result.groups);
  }, [setGroups]);

  const handleImportFromAbs = useCallback(async () => {
    // Import library items from AudiobookShelf
  }, []);

  const handleRescan = useCallback(async (paths, fields) => {
    // Selective field rescan
    const result = await invoke('rescan_fields', { paths, fields });
    // Merge with existing groups
  }, []);

  return {
    scanning,
    scanProgress,
    handleScan,
    handleImport,
    handleImportFromAbs,
    handleRescan,
    // ... more methods
  };
}
```

**ETA Calculation:**
```javascript
const calculateETA = useCallback(() => {
  const remaining = total - current;
  const secondsLeft = remaining / filesPerSecond;

  if (secondsLeft < 60) return `${Math.round(secondsLeft)}s`;
  else if (secondsLeft < 3600) return `${mins}m ${secs}s`;
  else return `${hours}h ${mins}m`;
}, [scanProgress]);
```

#### **4.5.2 useTagOperations.js**

**Tag writing and pushing:**

```javascript
export function useTagOperations() {
  const { config, groups, updateFileStatuses, setWriteProgress } = useApp();
  const [writing, setWriting] = useState(false);
  const [pushing, setPushing] = useState(false);

  const writeSelectedTags = useCallback(async (selectedFiles, shouldBackup) => {
    setWriting(true);

    // Build filesMap from groups
    const filesMap = {};
    groups.forEach(group => {
      group.files.forEach(file => {
        filesMap[file.id] = {
          path: file.path,
          changes: file.changes
        };
      });
    });

    // Invoke write_tags command
    const result = await invoke('write_tags', {
      request: {
        file_ids: Array.from(selectedFiles),
        files: filesMap,
        backup: shouldBackup
      }
    });

    // Update statuses
    const newStatuses = {};
    selectedFiles.forEach(fileId => {
      const hasError = result.errors.some(e => e.file_id === fileId);
      newStatuses[fileId] = hasError ? 'failed' : 'success';
    });
    updateFileStatuses(newStatuses);

    setWriting(false);
    return result;
  }, [groups, updateFileStatuses, setWriteProgress]);

  const pushToAudiobookShelf = useCallback(async (selectedFiles) => {
    setPushing(true);

    // Group files by book (one file per book)
    const bookMap = new Map();
    groups.forEach(group => {
      const hasSelectedFile = group.files.some(f => selectedFiles.has(f.id));
      if (hasSelectedFile) {
        const firstFile = group.files[0];
        if (!bookMap.has(group.id)) {
          bookMap.set(group.id, {
            path: firstFile.path,
            metadata: group.metadata,
            group_id: group.id
          });
        }
      }
    });

    // Chunk into batches of 50
    const items = Array.from(bookMap.values());
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      const result = await invoke('push_abs_updates', {
        request: { items: chunk }
      });
      // Accumulate results
    }

    setPushing(false);
  }, [groups]);

  return {
    writing,
    pushing,
    writeSelectedTags,
    pushToAudiobookShelf,
    renameFiles,
    previewRename
  };
}
```

#### **4.5.3 useFileSelection.js**

**File and group selection logic:**

```javascript
export function useFileSelection() {
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState(new Set());
  const [allSelected, setAllSelected] = useState(false);

  const selectAll = useCallback((groups) => {
    // Select all files from all groups
    setAllSelected(true);
  }, []);

  const selectAllInGroup = useCallback((group, checked) => {
    // Toggle all files in a group
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      group.files.forEach(f => {
        if (checked) newSet.add(f.id);
        else newSet.delete(f.id);
      });
      return newSet;
    });
  }, []);

  const isFileSelected = useCallback((fileId) => {
    return allSelected || selectedFiles.has(fileId);
  }, [allSelected, selectedFiles]);

  const getSelectedFileIds = useCallback((groups) => {
    if (allSelected) {
      // Get all file IDs from all groups
      return new Set(groups.flatMap(g => g.files.map(f => f.id)));
    }
    return selectedFiles;
  }, [allSelected, selectedFiles]);

  return {
    selectedFiles,
    setSelectedFiles,
    allSelected,
    setAllSelected,
    selectAll,
    selectAllInGroup,
    isFileSelected,
    getSelectedFileIds,
    getSelectedCount: () => allSelected ? totalFiles : selectedFiles.size,
    // ... more helpers
  };
}
```

---

## **5. DATA FLOW DIAGRAMS**

### **5.1 SCANNING WORKFLOW (End-to-End)**

```
USER CLICKS "SCAN LIBRARY"
  ↓
Frontend: Open folder picker (multiple directories)
  ↓
Frontend: Invoke scan_library({paths, scanMode})
  ↓
Backend: scanner/mod.rs scan_directories_with_options()
  ├─ Reset progress
  ├─ Clear cache (based on scan mode)
  ├─ collector::collect_and_group_files()
  │  ├─ Walk directories recursively
  │  ├─ Filter audio files (*.m4b, *.mp3, etc.)
  │  ├─ Group by parent directory
  │  ├─ Natural sort files
  │  ├─ Load existing metadata.json (if present)
  │  └─ Return Vec<BookGroup>
  └─ processor::process_all_groups_with_options()
     ├─ For each group (parallel, concurrency limited)
     │  ├─ Check scan mode skip logic
     │  ├─ Read existing audio file tags
     │  ├─ Detect folder metadata (title, author, series from path)
     │  ├─ API calls (conditional):
     │  │  ├─ Audible search (if configured)
     │  │  ├─ AudiobookShelf search waterfall
     │  │  ├─ Google Books fallback
     │  │  └─ iTunes fallback
     │  ├─ Cross-validate sources
     │  ├─ Series detection & normalization
     │  ├─ Cover fetching (parallel)
     │  ├─ Genre normalization
     │  ├─ Text normalization (titles, authors)
     │  ├─ Build MetadataChange objects
     │  └─ Calculate total_changes count
     ├─ Emit progress every 5-10 groups
     └─ Return enriched groups
  ↓
Backend: Return ScanResult to frontend
  ├─ Serialize to JSON (with cycle detection)
  └─ Handle serialization errors gracefully
  ↓
Frontend: useScan hook receives result
  ├─ Stop progress polling
  ├─ setGroups(result.groups)
  └─ Display in BookList with cover cache
  ↓
USER: Sees groups with metadata ready for review/editing
```

### **5.2 TAG WRITING WORKFLOW**

```
USER SELECTS FILES + CLICKS "WRITE TAGS"
  ↓
Frontend: useTagOperations.writeSelectedTags()
  ├─ Build filesMap from selected file IDs
  │  └─ Extract path + changes for each file
  └─ Invoke write_tags({file_ids, files, backup})
  ↓
Backend: commands/tags.rs write_tags()
  ├─ Emit "grouping" progress event
  ├─ Group files by parent directory
  │  └─ All files in same folder = same book
  ├─ Emit "writing" progress event
  ├─ For each unique book folder (parallel, concurrency limited):
  │  ├─ Collect metadata changes from all files in folder
  │  ├─ Build ABS metadata.json format
  │  ├─ Write to {folder}/metadata.json
  │  └─ Emit progress every 20 books
  ├─ Emit "complete" progress event
  └─ Return WriteResult
  ↓
Frontend: Receive WriteResult
  ├─ Mark succeeded files with 'success' status
  ├─ Mark failed files with 'failed' status
  ├─ Display summary
  └─ (Optional) Refresh to AudiobookShelf
```

### **5.3 PUSH TO AUDIOBOOKSHELF WORKFLOW**

```
USER CLICKS "PUSH TO ABS"
  ↓
Frontend: useTagOperations.pushToAudiobookShelf()
  ├─ Group selected files by book (one file per book)
  ├─ Chunk into batches of 50
  └─ For each chunk:
     └─ Invoke push_abs_updates({items: chunk})
  ↓
Backend: commands/abs.rs push_abs_updates()
  ├─ Emit "connecting" progress
  ├─ Load config, create HTTP client
  ├─ Emit "fetching" progress
  ├─ fetch_abs_library_items_with_progress()
  │  ├─ Check 5-minute cache
  │  ├─ If not cached:
  │  │  ├─ Paginated fetch of library items (200 per page)
  │  │  ├─ Build path → item_id mapping
  │  │  ├─ Cache in LIBRARY_CACHE
  │  │  └─ Emit progress for each page
  │  └─ Return HashMap<normalized_path, AbsLibraryItem>
  ├─ Emit "matching" progress
  ├─ For each item:
  │  ├─ Normalize path
  │  ├─ Find matching library item
  │  ├─ Deduplicate by item_id
  │  └─ Track unmatched
  ├─ Emit "pushing" progress
  ├─ For each matched item (parallel, concurrency limited):
  │  ├─ POST to /api/items/{item_id}/metadata
  │  │  └── Update: title, authors, narrators, series, genres, etc.
  │  ├─ GET cover from cache
  │  ├─ POST cover to /api/items/{item_id}/cover
  │  └─ Track success/failure
  ├─ Emit "complete" progress
  └─ Return PushResult
  ↓
Frontend: Receive PushResult
  ├─ Display: X updated, Y unmatched, Z failed
  ├─ List unmatched paths
  ├─ Show error details for failures
  └─ Optional: Trigger ABS rescan
```

### **5.4 ABS IMPORT WORKFLOW**

```
USER CLICKS "IMPORT FROM ABS"
  ↓
Frontend: useScan.handleImportFromAbs()
  └─ Invoke import_from_abs()
  ↓
Backend: commands/abs.rs import_from_abs()
  ├─ Emit "fetching" progress
  ├─ Paginated fetch of all library items with full metadata
  │  └─ GET /api/libraries/{id}/items?limit=100&page=N&minified=0
  ├─ Emit "processing" progress
  ├─ For each ABS item:
  │  ├─ Extract metadata (title, author, narrator, series, etc.)
  │  ├─ Build BookGroup with id = ABS item ID
  │  ├─ Set files = [] (no local files)
  │  └─ Set scan_status = LoadedFromFile
  ├─ Emit "complete" progress
  └─ Return AbsImportResult { groups, total_imported }
  ↓
Frontend: Receive result
  ├─ setGroups(result.groups)
  └─ Display in BookList (ABS import mode)
  ↓
USER: Can now rescan (via GPT) and push back to ABS
```

### **5.5 ABS RESCAN + PUSH WORKFLOW**

```
USER SELECTS ABS-IMPORTED BOOKS + CLICKS "RESCAN"
  ↓
Frontend: ScannerPage.handleRescanClick()
  ├─ Detect ABS imports (groups with files.length === 0)
  └─ Call handleRescanAbsImports(absImports, mode, autoPush, fields)
  ↓
Frontend: useScan.handleRescanAbsImports()
  ├─ Build request with group metadata
  └─ Invoke rescan_abs_imports({ groups, mode, fields })
  ↓
Backend: commands/abs.rs rescan_abs_imports()
  ├─ Emit "starting" progress
  ├─ If mode === "genres_only":
  │  └─ Just normalize genres locally (no API calls)
  ├─ If mode === "force_fresh":
  │  ├─ For each group (50 parallel workers):
  │  │  ├─ Call process_abs_import_with_gpt()
  │  │  │  ├─ Build GPT prompt with title/author/series/genres/description
  │  │  │  ├─ Call GPT-5-nano for cleaning
  │  │  │  ├─ Parse response (series, genres, description)
  │  │  │  └─ Apply children's genre detection
  │  │  ├─ Merge with existing data (if selective fields)
  │  │  └─ Build updated BookGroup
  │  └─ Emit progress every 10 items
  ├─ Emit "complete" progress
  └─ Return AbsRescanResult { groups, total_rescanned, total_failed }
  ↓
Frontend: Receive result
  ├─ Update groups state with rescanned metadata
  ├─ If autoPush === true:
  │  └─ Call handlePushAbsImports(result.groups)
  └─ Display summary
  ↓
USER CLICKS "PUSH TO ABS" (or autoPush triggered)
  ↓
Frontend: handlePushAbsImports(groups)
  └─ Invoke push_abs_imports({ items })
  ↓
Backend: commands/abs.rs push_abs_imports()
  ├─ Emit "pushing" progress
  ├─ For each item (parallel, concurrency from config):
  │  ├─ PATCH /api/items/{item.id}/media
  │  │  └─ Send updated metadata
  │  └─ Track success/failure
  ├─ Emit "complete" progress
  └─ Return AbsPushResult { updated, failed, errors }
  ↓
Frontend: Display results
```

### **5.6 SERIES DETECTION FLOW**

```
DURING METADATA ENRICHMENT:

1. Audible API returns:
   {
     "series": [
       { "title": "Main Series", "sequence": "1" },
       { "title": "Sub-Series", "sequence": "2" }
     ]
   }

2. Folder name analysis:
   Extract from patterns like:
   - "Series Name - Book 1" → Series: "Series Name", Seq: "1"
   - "Series Name #5" → Series: "Series Name", Seq: "5"
   - "Book Title (Series Name #3)" → Series: "Series Name", Seq: "3"

3. Series normalization:
   - Remove junk: "(Book X)", "Series", "Trilogy", "Saga"
   - Split compound patterns: "Magic Tree House: Merlin Missions"
     → [("Magic Tree House", None), ("Merlin Missions", Seq)]
   - Handle known mappings:
     * "Percy Jackson" → "Percy Jackson and the Olympians"
     * "Heroes of Olympus" → "Percy Jackson Universe" parent
     * "Harry Potter" → Preserve as-is (no "and the")

4. Cross-validation:
   - Compare Audible series with folder-detected series
   - Calculate confidence scores
   - Prefer Audible for reliability
   - Keep both if different patterns found

5. Output to metadata:
   series: Option<String>,        // Primary series name
   sequence: Option<String>,      // Position in series
   series_info: Vec<SeriesInfo>,  // All detected series with confidence
```

---

## **6. KNOWN ISSUES & LIMITATIONS**

### **6.1 Series Handling Issues**

**Issue 1: Compound Series Ambiguity**
- Problem: App has hardcoded list of ~10 compound series patterns
- Impact: Unknown series combinations treated as single series
- Example: A new "Percy Jackson Universe" sub-series wouldn't be detected
- Fix Needed: AI-powered series relationship detection or expanded hardcoded list

**Issue 2: Series Position Extraction**
- Problem: Parser assumes "Series Name #1" or "Book 1 of Series"
- Impact: Non-standard numbering (e.g., "Series Name, Part I") fails
- Example: "Harry Potter, Philosopher's Stone" wouldn't extract series position
- Fix Needed: More flexible regex patterns for position extraction

**Issue 3: Series Name Conflicts**
- Problem: Might extract wrong part from "Series Name - Book Title" patterns
- Impact: Could pick book title as series if series is longer
- Example: Long series name + short title could be reversed
- Logic: `if part2.len() < part1.len() || part2.contains("series")` is heuristic-based

**Issue 4: Series Not Preserved During ABS Import→Rescan**
- Problem: GPT cleaning might alter or lose series information
- Impact: Series data from ABS could be modified incorrectly
- Example: "Magic Tree House: Merlin Missions" might become just "Merlin Missions"
- Fix Needed: Better series preservation logic in GPT prompt

### **6.2 Cover Handling Issues**

**Issue 1: Cover Caching Permanence**
- Problem: Covers cached in sled DB don't expire automatically
- Impact: Old covers persist even if book metadata is updated
- Workaround: `clear_cache` command required to flush
- Fix Needed: TTL or update timestamp tracking for covers

**Issue 2: Cover Quality Scoring**
- Problem: Aspect ratio scoring treats all 1.3-1.7 ratios as "good"
- Impact: Distorted/weird aspect ratios might score higher than square
- Example: 1.6 ratio (very tall) scores same as 1.5 ratio (normal book)
- Fix Needed: More refined aspect ratio scoring for audiobooks (should prefer 1:1 square)

**Issue 3: Cover Download Timeouts**
- Problem: No automatic retry on API timeouts for cover fetches
- Impact: Missing covers if APIs are slow
- Current: Waterfall stops on first successful result
- Fix Needed: Timeout retries or parallel fetch attempts

**Issue 4: No Cover Fetching for ABS Imports**
- Problem: `process_abs_import_with_gpt` doesn't fetch covers
- Impact: ABS imports keep their existing covers, can't update from external sources
- Fix Needed: Add cover fetching pipeline to ABS rescan flow

### **6.3 Metadata Enrichment Issues**

**Issue 1: API Waterfall Strategy**
- Problem: Stops at first valid result (doesn't try all sources)
- Impact: Might miss better metadata from other providers
- Example: If Audible returns incomplete data, never tries Google Books
- Fix Needed: Multi-source merging or configurable fallback strategy

**Issue 2: Google Books API Integration**
- Problem: Query cleaning is basic (removes some junk, but not all patterns)
- Impact: Failed queries if title has unusual formatting
- Example: "Book Title (Unabridged) [Audio Edition]" might not match
- Fix Needed: More sophisticated query normalization

**Issue 3: Audible CLI Dependency**
- Problem: Requires `audible-cli` tool installed + authenticated
- Impact: Audible integration fails silently if CLI missing
- Error Handling: Graceful (returns Ok(None)), but no clear user feedback
- Fix Needed: Better error messages, check for CLI availability at startup

### **6.4 Genre Handling Issues**

**Issue 1: Children's Series Age Detection Brittleness**
- Problem: Hardcoded series mapping (~150 series) with exact lowercase match
- Impact: Any typo/variation in series name breaks detection
- Example: "Percy jackson" (lowercase j) wouldn't match "percy jackson"
- Current: Uses `map.get(series.to_lowercase().as_str())`
- Fix Needed: Fuzzy matching for series names

**Issue 2: Missing Genre Categories**
- Problem: Genre list doesn't include all modern categories
- Impact: Books might not fit existing categories
- Example: "Dark Fantasy" vs "Fantasy" - forced to choose
- Fix Needed: Expand approved genres or allow custom categories

**Issue 3: Genre Enforcement Issues**
- Problem: When enforcement enabled, unknown genres silently dropped
- Impact: User loses metadata without warning
- Example: "Romantic Comedy" might get filtered to just "Romance"
- Fix Needed: Warning before filtering, show what was removed

### **6.5 Text Normalization Issues**

**Issue 1: Proper Noun Detection**
- Problem: Simple heuristic (internal capitals) fails for some cases
- Impact: Names like "IKEA" or "NASA" might be lowercased
- Current Logic: Checks for internal capitals but limited detection
- Fix Needed: Dictionary-based proper noun database

**Issue 2: Junk Suffix Handling**
- Problem: Removes suffixes by position, not context
- Impact: Could break titles like "The Complete Works of..." if in junk list
- Example: If "Complete" is in junk list, "Complete Works" → "Works"
- Fix Needed: Whitelist instead of blacklist for last words

**Issue 3: Title Case Edge Cases**
- Problem: Doesn't handle all language-specific rules
- Impact: Titles in non-English languages might be incorrectly cased
- Example: French "le petit prince" might become "Le Petit Prince" (not "Le petit prince")
- Fix Needed: Locale-aware title casing

### **6.6 Performance Issues**

**Issue 1: Large Library Scans**
- Problem: Sequential fallback for each book if parallel API calls fail
- Impact: 1000+ book library could take hours in worst case
- Mitigated By: Configurable concurrency presets, caching
- Fix Needed: Better error recovery, async retry batching

**Issue 2: Cover Fetching Overhead**
- Problem: Fetches cover for every book (even if exists in cache/file)
- Impact: Network I/O heavy for large libraries
- Mitigated By: Multi-level caching (cache DB → folder → API)
- Fix Needed: Skip cover fetch if already verified recent

**Issue 3: Virtualization Edge Cases**
- Problem: ITEM_HEIGHT=140px is estimated, might be wrong on some displays
- Impact: Wrong items might render as visible, causing visual jumps
- Frontend: BookList component uses fixed ITEM_HEIGHT for virtualization
- Fix Needed: Dynamic height measurement

### **6.7 AudiobookShelf Integration Issues**

**Issue 1: Library Cache Expiration**
- Problem: 5-minute cache might be stale if library changes frequently
- Impact: New books added to ABS wouldn't be pushed until cache expires
- Example: Add book to ABS, immediately push → won't match
- Fix Needed: Manual cache clear or shorter TTL

**Issue 2: Path Matching Ambiguity**
- Problem: Normalizes paths but might fail with symbolic links
- Impact: Books accessed via symlink wouldn't match direct path
- Current: `normalize_path()` removes trailing slashes, converts `\` to `/`
- Fix Needed: Resolve symlinks before matching

**Issue 3: Metadata Format Compatibility**
- Problem: Hard-codes ABS metadata.json format, doesn't validate before write
- Impact: If ABS changes format, app continues writing old format
- Fix Needed: Version checking, graceful migration

**Issue 4: ABS Push for Imports Uses Wrong Function**
- Problem: Until recently, ABS imports used sequential push (very slow)
- Impact: 1669 books took 10+ minutes to push
- Status: FIXED - Now uses parallel push with configurable concurrency

### **6.8 UI/Frontend Issues**

**Issue 1: BookList Virtualization Bugs**
- Problem: Scroll calculations might be off with dynamic content
- Impact: Jumping/flickering when scrolling fast
- Mitigated By: BUFFER_SIZE=10 adds extra rendering padding
- Fix Needed: Virtual list library instead of manual implementation

**Issue 2: Progress Event Race Conditions**
- Problem: Multiple concurrent write operations could emit conflicting progress
- Impact: Progress bar shows wrong phase/count
- Current: Per-operation channels should be isolated
- Fix Needed: Better event serialization/synchronization

**Issue 3: Modal State Management**
- Problem: Multiple modals can open simultaneously if not careful
- Impact: UI confusion, accidental double-edits
- Fix Needed: Modal stack/queue system

**Issue 4: Push Button Not Visible for ABS Imports**
- Problem: Push button only showed after writing tags (successCount > 0)
- Impact: ABS imports had no direct push button
- Status: FIXED - Added "Push to ABS" button for ABS import mode

---

## **7. ARCHITECTURE DECISIONS & RATIONALES**

### **7.1 Why metadata.json Instead of Direct Audio Tag Writing**

**Chosen Approach:** Write AudiobookShelf metadata.json files in book folders

**Rationale:**
1. **Speed**: One file write per book folder vs. one per audio file (10-100x faster)
2. **Safety**: Doesn't touch audio files, lower risk of corruption
3. **ABS Compatibility**: ABS reads metadata.json as primary source
4. **Atomicity**: One write operation per book, fewer race conditions

**Trade-off:**
- Audio player apps (non-ABS) won't see metadata
- Requires metadata.json to be present

**Alternative (not used):** Direct tag embedding
- Would support all audio players
- Much slower (one file I/O per audio file)
- Higher corruption risk
- Kept as fallback option in tags.rs

### **7.2 Why Streaming/Waterfall API Strategy**

**Chosen Approach:** Try Audible → Google Books → iTunes in sequence

**Rationale:**
1. **Audible Best Source**: Most accurate for audiobooks (publisher official)
2. **Fall Through Gracefully**: If one fails, try next without stalling
3. **Caching**: Each provider cached separately
4. **Cost**: Audible free (via CLI), Google/iTunes free up to quota

**Trade-off:**
- Only gets first good result (doesn't merge multiple sources)
- Misses potential better data from later providers

**Alternative (not used):** Multi-source merging
- Would require complex conflict resolution
- Slower (must wait for all sources)
- Would increase cache complexity

### **7.3 Why Hardcoded Series Patterns**

**Chosen Approach:** ~10 known compound series patterns hardcoded, rest inferred

**Rationale:**
1. **Reliability**: Known patterns guaranteed correct
2. **Performance**: Instant matching, no ML overhead
3. **Transparency**: Easy to debug and extend

**Trade-off:**
- Doesn't scale to unknown series combinations
- Requires manual maintenance

**Alternative (not used):** AI-powered relationship detection
- Would be flexible but slower
- Would require model hosting
- Would increase complexity

### **7.4 Why Concurrency Presets**

**Chosen Approach:** Preset-based multipliers (conservative to extreme)

**Rationale:**
1. **User Simplicity**: Don't make users choose 15 different concurrency values
2. **Machine Adaptation**: Same preset works across different CPUs
3. **Granularity**: Individual overrides for power users

**Trade-off:**
- Preset values might not be optimal for specific hardware
- Can't express complex patterns (e.g., "use CPU cores - 1")

**Alternative (not used):** Auto-detection
- Would require system profiling at startup
- Might not match user's other applications' load

---

## **8. CONFIGURATION & SETUP**

### **8.1 Config File Location**

```
macOS:   ~/Library/Application Support/Audiobook Tagger/config.json
Linux:   ~/.local/share/audiobook-tagger/config.json
Windows: %APPDATA%\audiobook-tagger\config.json
```

### **8.2 Example config.json**

```json
{
  "abs_base_url": "https://secretlibrary.org/audiobookshelf",
  "abs_api_token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
  "abs_library_id": "e0c8956a-6867-47fb-afd4-b06b56665af2",
  "openai_api_key": "sk-...",
  "librarything_dev_key": null,
  "performance_preset": "extreme",
  "concurrency_metadata": null,
  "concurrency_super_scanner": null,
  "concurrency_json_writes": null,
  "concurrency_abs_push": null,
  "concurrency_file_scan": null,
  "backup_tags": false,
  "genre_enforcement": true
}
```

### **8.3 Dependencies**

**Rust Crate Ecosystem:**
- `tauri` - Desktop app framework
- `tokio` - Async runtime
- `lofty` - Audio tag manipulation (MP3, FLAC, OGG)
- `mp4ameta` - M4A/M4B tag writing
- `reqwest` - HTTP client
- `serde/serde_json` - Serialization
- `sled` - Embedded database for caching
- `walkdir` - Directory traversal
- `regex` - Pattern matching
- `indexmap` - Ordered HashMap
- `uuid` - ID generation
- `base64` - Encoding/decoding
- `anyhow` - Error handling
- `once_cell`/`lazy_static` - Static initialization
- `futures` - Async stream utilities

**External Tools:**
- `audible-cli` - Audible API access (optional but recommended)
- `ffmpeg` - Audio processing, chapter detection (optional)

---

## **9. TESTING & DEBUGGING**

### **9.1 Tag Inspector**

Built-in tool for examining raw metadata in audio files:

```
UI: Top-right "Inspect Tags" button
  ↓
Opens modal with file picker
  ↓
Shows all tags (raw format, no processing)
  ↓
Useful for verifying:
  - Narrator in Composer field (not Comment)
  - Multiple separate Genre tags (not comma-separated)
  - Clean descriptions (no debug strings)
  - Series/Sequence in custom atoms
```

### **9.2 Debug Logging**

Backend logs to stdout/stderr with emoji prefixes:

```
📁 File operations
🔍 API searches
📚 Book processing
✅ Success
❌ Errors
⚠️  Warnings
🎭 Retries
⏳ Delays
📤 Push operations
🤖 GPT processing
```

### **9.3 Common Debugging Workflows**

**Problem: Narrator not showing in AudiobookShelf**
1. Open Tag Inspector
2. Select audio file
3. Check if "Composer" field is populated (not "Comment")
4. If in Comment, re-write tags with app

**Problem: Only 1 genre showing**
1. Open Tag Inspector
2. Count Genre entries (should be separate, not comma-separated)
3. If comma-separated, need to re-write with app

**Problem: Series not detected**
1. Check if book folder name matches hardcoded patterns
2. Look at Audible search results in logs
3. Manually edit series in metadata panel

**Problem: Slow scanning**
1. Check config performance_preset (set to "performance" or "extreme")
2. Verify API keys are working (test ABS connection)
3. Check internet speed
4. Try smaller batch first

**Problem: ABS push failing**
1. Check console for "Push error breakdown"
2. HTTP 404 = Item IDs don't match (need re-import from ABS)
3. HTTP 429 = Rate limiting (reduce concurrency)
4. Timeouts = Network issues to server

---

## **10. DEPLOYMENT & BUILDING**

### **10.1 Build Process**

```bash
# Install dependencies
npm install
cargo install tauri-cli

# Development
npm start
# or
npm run tauri dev

# Production build
npm run tauri build

# Output locations:
# - macOS: src-tauri/target/release/bundle/macos/
# - Linux: src-tauri/target/release/bundle/deb/
# - Windows: src-tauri/target/release/bundle/msi/
```

### **10.2 Release Checklist**

- [ ] Update version in src-tauri/Cargo.toml
- [ ] Update version in package.json
- [ ] Test on all platforms (macOS, Windows, Linux)
- [ ] Verify all commands respond
- [ ] Test scanning with large library (1000+ books)
- [ ] Test ABS push with real server
- [ ] Update README with new features
- [ ] Create git tag
- [ ] Build release artifacts

---

## **SUMMARY**

The **Audiobook Tagger** is a sophisticated desktop application with:

- **Multi-source metadata enrichment** (Audible, Google Books, iTunes, AudiobookShelf APIs)
- **Intelligent series detection** with hardcoded compound patterns
- **Fast tag writing** via metadata.json files (not direct audio tag embedding)
- **Genre normalization** with children's series age mapping
- **Cover art sourcing** with quality scoring
- **AudiobookShelf integration** for importing and pushing metadata
- **High-performance scanning** with configurable concurrency
- **Beautiful React UI** with virtualized book lists
- **Comprehensive error handling** and graceful degradation

**Key Strengths:**
- Multi-source approach reduces bad metadata
- Caching system speeds up re-scans
- Concurrency presets make performance accessible to non-experts
- Modular architecture makes adding features straightforward
- ABS import → rescan → push workflow for cloud-hosted libraries

**Key Limitations:**
- Series detection limited to hardcoded patterns
- No multi-source merging (waterfall only)
- Cover caching doesn't expire
- Depends on audible-cli for Audible integration
- Text normalization uses simple heuristics
- No cover fetching for ABS-imported books

This documentation should provide a complete understanding of the system's architecture, data flows, strengths, and areas for improvement.
