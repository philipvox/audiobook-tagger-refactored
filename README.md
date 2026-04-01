# Audiobook Tagger

A desktop app for managing audiobook metadata in AudiobookShelf. Pulls your library from ABS, enriches metadata with AI, and pushes clean results back.

Works with **cloud AI** (OpenAI) or **local AI** (bundled Ollama) — no API key required for local mode.

![Tauri](https://img.shields.io/badge/Tauri-2.0-blue)
![Rust](https://img.shields.io/badge/Rust-1.70+-orange)
![React](https://img.shields.io/badge/React-18-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Downloads

**[Download latest release](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest)**

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `.dmg` |
| Windows (Installer) | `.exe` / `.msi` |
| Linux (Debian/Ubuntu) | `.deb` / `.AppImage` |

Builds are generated automatically via GitHub Actions for each release.

## Features

### Local AI (NEW)

Run AI features entirely on your machine with no API key and no usage costs.

- **One-click install** — Settings page downloads and installs Ollama automatically
- **Model picker** — Choose from 5 presets (1.7B to 4B parameters, 1-3 GB download)
- **Auto-managed** — Starts on app launch, stops on quit, no terminal needed
- **Install/remove** — Single button to install or uninstall, shows disk usage
- **Optimized prompts** — Simplified prompts tuned for small local models
- **Privacy** — All processing stays on your machine

Local AI quality is ~85-90% of cloud AI for classification and metadata, thanks to external data enrichment from Goodreads, Hardcover, and Storytel that feeds real book data to the model.

### Cloud AI

For maximum quality, use OpenAI (GPT-5.4 Nano recommended, ~$0.003/book).

- Configurable model selection with cost estimates
- Supports any OpenAI-compatible endpoint (LM Studio, etc.)

### Library Management

- Pull entire library from AudiobookShelf via API
- Browse, search, filter, and select books
- Shift-click and cmd-click multi-selection
- Push updated metadata back to ABS

### AI-Powered Metadata

- **Metadata resolution** — Clean titles, subtitles, authors, series, and sequence numbers using folder paths, Audible data, and AI
- **Classification** — Genres, tags, age ratings, and BookDNA fingerprints in one pass. Gathers data from Goodreads, Hardcover, Storytel, and Audible before AI processing
- **Descriptions** — Validate, clean, or generate book descriptions
- **BookDNA** — Structured fingerprints with shelves, spectrums, moods, tropes, and comp-vibes
- **ISBN/ASIN lookup** and age rating detection

### Authors Tab

- Browse and analyze all authors in your ABS library
- Detect duplicates, normalize names, fix descriptions
- Auto-merge duplicate authors
- Local-first editing with batch push to ABS

### Additional Tools

- Smart file/folder renaming
- Cover art search and bulk assignment
- Chapter detection and editing
- Folder structure analysis and fixing
- Duplicate book finder
- Audio format conversion (M4B)
- Immersion Sync (audio-text alignment)

## Quick Start

### From a Release

1. Download the installer for your platform
2. Install and launch
3. Go to **Settings**:
   - Enter your AudiobookShelf URL and API token
   - **Local AI:** Click "Install Local AI" and pick a model — done
   - **Cloud AI:** Enter your OpenAI API key instead
4. Click the download icon to pull your library from ABS
5. Select books, use the enrichment menu to process metadata
6. Push changes back to ABS

### From Source

**Prerequisites:** Node.js 20+, Rust 1.70+

```bash
git clone https://github.com/philipvox/audiobook-tagger-refactored.git
cd audiobook-tagger-refactored

npm install

# Development
npm run tauri dev

# Production build
npm run tauri build
```

## How AI Works

The app uses a 2-phase pipeline for classification:

1. **Gather** — Fetches external data from Audible, Goodreads, Hardcover, and Storytel in parallel (descriptions, genres, series info)
2. **Classify** — Sends the gathered data + your ABS metadata to the AI model

This means even small local models produce good results — they don't need to "know" the book because they're given real data to organize.

### Local vs Cloud Comparison

| Feature | Local (qwen3:4b) | Cloud (GPT-5.4 Nano) |
|---------|-------------------|----------------------|
| Cost | Free | ~$0.003/book |
| Privacy | 100% local | Data sent to OpenAI |
| Speed | ~2-3s/call | ~1-2s/call |
| DNA Spectrums | ~95% match | Reference |
| DNA Moods/Shelves | ~90% match | Reference |
| Genres/Tags | ~85% match | Reference |
| Book-specific knowledge | From providers only | Training data + providers |

## Configuration

Settings are stored at:
- **macOS:** `~/Library/Application Support/Audiobook Tagger/config.json`
- **Windows:** `%APPDATA%/Audiobook Tagger/config.json`
- **Linux:** `~/.local/share/audiobook-tagger/config.json`

**Required:**
- AudiobookShelf URL and API token
- ABS Library ID

**AI (one of):**
- Local AI — installed from Settings, no key needed
- OpenAI API key — for cloud AI

## Architecture

**Frontend:** React 18, Vite, TailwindCSS, Lucide Icons

**Backend:** Rust (Tauri 2), lofty (audio tags), tokio (async), reqwest (HTTP), rusqlite (job queue)

**AI:** OpenAI API or Ollama (bundled, local)

**Metadata Providers:** AudiobookShelf, Goodreads, Hardcover, Storytel, Graphic Audio, Big Finish, LibriVox (via abs-agg)

### Project Structure

```
src/                        # React frontend
  pages/                    # ScannerPage, AuthorsPage, SettingsPage
  components/               # Modals, action bars, progress bars
  hooks/                    # useAuthors, useAbsCache, useBatchOperations
  context/                  # AppContext (global state)

src-tauri/src/              # Rust backend
  commands/                 # Tauri command handlers (including ollama.rs)
  scanner/                  # File scanning and metadata processing
  validation/               # Author, title, series validation
  alignment/                # Audio-text alignment (Immersion Sync)
  pipeline/                 # Metadata processing pipeline
  ollama_manager.rs         # Bundled Ollama lifecycle management
  gpt_consolidated.rs       # AI calls (3 core: metadata, classify, description)
  book_dna.rs               # BookDNA fingerprint generation
  config.rs                 # App configuration
```

## BookDNA

Each book gets a structured "DNA fingerprint" stored as ABS tags with the `dna:` prefix:

- **Core:** length, pacing, structure, series position, setting
- **Content:** ending type, humor type, stakes level, violence/intimacy levels
- **Audio:** narrator performance, audio friendliness, re-listen value
- **Spectrums:** 7 dimensions on -5 to +5 (dark-light, serious-funny, plot-character, simple-complex, action-contemplative, intimate-epic, world-density)
- **Moods:** 2-3 with intensity 1-10
- **Comparables:** similar authors and evocative "X-meets-Y" vibes
- **Shelves, themes, tropes:** from curated taxonomy

Example tags: `dna:shelf:grimdark-fantasy`, `dna:spectrum:dark-light:-4`, `dna:mood:dread:8`, `dna:comp-vibe:medieval-horror-roadtrip`

## Building

Builds are automated via GitHub Actions. To build locally:

```bash
# macOS
npm run tauri build
# Output: src-tauri/target/release/bundle/dmg/

# Windows
npm run tauri build
# Output: src-tauri/target/release/bundle/msi/ and nsis/

# Linux
npm run tauri build
# Output: src-tauri/target/release/bundle/deb/ and appimage/
```

## License

MIT

## Acknowledgments

- [Tauri](https://tauri.app/) — Desktop app framework
- [AudiobookShelf](https://www.audiobookshelf.org/) — Audiobook server
- [Ollama](https://ollama.com/) — Local LLM runtime
- [lofty](https://github.com/Serial-ATA/lofty-rs) — Audio metadata library
- [OpenAI](https://openai.com/) — GPT API
- [abs-agg](https://github.com/vito0912/abs-agg) — Community metadata providers
