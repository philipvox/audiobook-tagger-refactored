# Audiobook Tagger

A desktop app for managing audiobook metadata in AudiobookShelf. Pulls your library from ABS, enriches metadata with AI, and pushes clean results back.

![Tauri](https://img.shields.io/badge/Tauri-2.0-blue)
![Rust](https://img.shields.io/badge/Rust-1.70+-orange)
![React](https://img.shields.io/badge/React-18-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

**Library Management**
- Pull entire library from AudiobookShelf via API
- Browse, search, filter, and select books
- Shift-click and cmd-click multi-selection
- Push updated metadata back to ABS

**AI-Powered Metadata**
- One-click metadata resolution (title, subtitle, author, series)
- Genre and tag classification
- Description generation and cleanup
- BookDNA fingerprinting (shelves, spectrums, moods, tropes, comp-vibes)
- ISBN/ASIN lookup and age rating detection
- Configurable AI model (default: GPT-5.4 Nano) with cost estimates

**Authors Tab**
- Browse and analyze all authors in your ABS library
- Detect duplicates, normalize names, fix descriptions with GPT
- Auto-merge duplicate authors (prefers most books, most info, proper name)
- Local-first editing with batch push to ABS

**Additional Tools**
- Smart file/folder renaming
- Cover art search and bulk assignment
- Chapter detection and editing
- Folder structure analysis and fixing
- Duplicate book finder
- Audio format conversion
- Immersion Sync (audio-text alignment)

## Downloads

**[Download latest release](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest)**

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | [Audiobook Tagger_1.0.0_aarch64.dmg](https://github.com/philipvox/audiobook-tagger-refactored/releases/download/v1.0.0/Audiobook.Tagger_1.0.0_aarch64.dmg) |
| macOS (Intel) | [Audiobook Tagger_1.0.0_x86_64.dmg](https://github.com/philipvox/audiobook-tagger-refactored/releases/download/v1.0.0/Audiobook.Tagger_1.0.0_x86_64.dmg) |
| Windows (Installer) | [Audiobook Tagger_1.0.0_x64-setup.exe](https://github.com/philipvox/audiobook-tagger-refactored/releases/download/v1.0.0/Audiobook.Tagger_1.0.0_x64-setup.exe) |
| Windows (MSI) | [Audiobook Tagger_1.0.0_x64_en-US.msi](https://github.com/philipvox/audiobook-tagger-refactored/releases/download/v1.0.0/Audiobook.Tagger_1.0.0_x64_en-US.msi) |
| Linux (Debian/Ubuntu) | [Audiobook Tagger_1.0.0_amd64.deb](https://github.com/philipvox/audiobook-tagger-refactored/releases/download/v1.0.0/Audiobook.Tagger_1.0.0_amd64.deb) |
| Linux (Fedora/RHEL) | [Audiobook Tagger-1.0.0-1.x86_64.rpm](https://github.com/philipvox/audiobook-tagger-refactored/releases/download/v1.0.0/Audiobook.Tagger-1.0.0-1.x86_64.rpm) |

## Quick Start

### From a Release

1. Download the installer for your platform
2. Install and launch
3. Go to Settings:
   - Enter your AudiobookShelf URL and API token
   - Enter your OpenAI API key (for AI features)
4. Click the download icon to pull your library from ABS
5. Select books, use the Sparkles dropdown to enrich metadata
6. Push changes back to ABS

### From Source

**Prerequisites:** Node.js 18+, Rust 1.70+

```bash
git clone https://github.com/philipvox/audiobook-tagger-refactored.git
cd audiobook-tagger-refactored

npm install

# Development
npm run tauri dev

# Production build
npm run tauri build
```

## Configuration

Settings are stored at `~/Library/Application Support/Audiobook Tagger/config.json` (macOS).

**Required:**
- AudiobookShelf URL and API token
- ABS Library ID

**Optional:**
- OpenAI API key (for AI metadata enrichment)
- AI model selection (GPT-5.4 Nano recommended)

The Settings page shows estimated cost per book and for your full library based on the selected model.

## Architecture

**Frontend:** React 18, Vite, TailwindCSS, Lucide Icons

**Backend:** Rust (Tauri 2), lofty (audio tags), tokio (async), reqwest (HTTP), rusqlite (job queue)

**APIs:** OpenAI (metadata extraction), AudiobookShelf (library management), abs-agg community providers (Goodreads, Hardcover, Storytel)

### Project Structure

```
src/                        # React frontend
  pages/                    # ScannerPage, AuthorsPage, SettingsPage
  components/               # Modals, action bars, progress bars
  hooks/                    # useAuthors, useAbsCache, useBatchOperations
  context/                  # AppContext (global state)

src-tauri/src/              # Rust backend
  commands/                 # Tauri command handlers
  scanner/                  # File scanning and metadata processing
  validation/               # Author, title, series validation
  alignment/                # Audio-text alignment (Immersion Sync)
  pipeline/                 # Metadata processing pipeline
  book_dna.rs               # BookDNA fingerprint generation
  gpt_consolidated.rs       # Consolidated GPT calls
  config.rs                 # App configuration
```

## BookDNA

Each book gets a structured "DNA fingerprint" with:

- **Core attributes:** length, pacing, structure, POV, series position
- **Content dimensions:** ending type, humor type, stakes level, prose style
- **Audiobook-specific:** narrator performance, audio friendliness, re-listen value
- **Spectrums:** 7 dimensions on a -5 to +5 scale (dark-light, serious-funny, etc.)
- **Moods:** 2-3 moods with 1-10 intensity
- **Comparables:** similar authors and "X-meets-Y" vibe descriptions
- **Shelves, themes, tropes:** from curated lists

DNA tags are stored as ABS tags prefixed with `dna:` (e.g., `dna:shelf:grimdark-fantasy`, `dna:spectrum:dark-light:-4`).

## Building

### macOS

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/dmg/
```

### Windows

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/msi/ and nsis/
```

### Linux (via Docker)

```bash
docker build --platform linux/amd64 -f Dockerfile.linux-build -t audiobook-tagger-linux .
docker create --name extract audiobook-tagger-linux
docker cp extract:/app/src-tauri/target/release/bundle/deb/ ./builds/
docker cp extract:/app/src-tauri/target/release/bundle/rpm/ ./builds/
docker rm extract
```

## License

MIT

## Acknowledgments

- [Tauri](https://tauri.app/) - Desktop app framework
- [AudiobookShelf](https://www.audiobookshelf.org/) - Audiobook server
- [lofty](https://github.com/Serial-ATA/lofty-rs) - Audio metadata library
- [OpenAI](https://openai.com/) - GPT API
- [abs-agg](https://github.com/vito0912/abs-agg) - Community metadata providers
