# Audiobook Tagger

**AI-powered metadata manager for AudiobookShelf**

[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri)](https://v2.tauri.app)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Audiobook Tagger connects to your [AudiobookShelf](https://www.audiobookshelf.org/) server and uses AI to enrich book metadata — genres, tags, age ratings, themes, DNA fingerprints, and more. Supports cloud AI (OpenAI, Anthropic) and fully local AI via Ollama.

![Screenshot](docs/screenshot.png)

---

## Features

### AI-Powered Enrichment

- 🤖 **Three AI providers** — OpenAI (GPT-5 Nano default), Anthropic Claude, or local AI via Ollama
- 🏠 **One-click local AI** — Install Ollama and download models directly from the app
- 📚 **Classify** — Auto-generate genres and tags from book metadata
- 🔍 **Resolve** — Look up missing authors, narrators, series info, and descriptions
- 📝 **Describe** — Generate or improve book descriptions
- 🧹 **Clean Genres** — Normalize messy Audible-style genres into a consistent taxonomy
- 🧬 **DNA Fingerprints** — Generate detailed "literary DNA" tags capturing tone, pace, themes, and style

### Library Management

- 🔗 **ABS Integration** — Import your full library from any AudiobookShelf server
- ⬆️ **Push to ABS** — Write enriched metadata back to your server in one click
- 📂 **Local Folder Scanning** — Scan local audiobook folders (M4B, MP3, etc.) without needing ABS
- ✏️ **Bulk Editing** — Edit metadata across multiple books at once
- 🖼️ **Cover Search** — Find and assign cover art

### Performance

- ⚡ **Batch Processing** — Process your entire library with configurable batch sizes
- 📊 **Progress Bars** — Real-time progress with time estimates for every operation
- 🔄 **Smart Batching** — Groups multiple books per AI prompt for faster local processing

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Tauri 2 CLI](https://v2.tauri.app/start/prerequisites/) prerequisites for your platform

### Install and Run

```bash
# Clone the repository
git clone https://github.com/your-username/audiobook-tagger-v2.git
cd audiobook-tagger-v2

# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

The app will open a native window. Connect to your ABS server from the Settings page or start scanning local folders immediately.

---

## Local AI Setup

Audiobook Tagger can run entirely offline using [Ollama](https://ollama.com/) for local AI inference.

### Getting Started with Ollama

1. Open the app and go to **Settings > AI Provider**
2. Select **Local (Ollama)**
3. Click **Install Ollama** — the app handles download and setup automatically
4. Choose a model preset (Gemma 4 recommended) and click **Download**
5. Once the model is ready, all AI features work locally with no API keys needed

### Model Recommendations

| Model | VRAM | Speed | Quality | Best For |
|-------|------|-------|---------|----------|
| Gemma 4 (12B) | ~8 GB | Fast | Good | Most users, balanced performance |
| Gemma 4 (27B) | ~16 GB | Moderate | Better | Users with a dedicated GPU |

### Performance Tips

- **GPU acceleration** is used automatically if available (NVIDIA, Apple Silicon, AMD)
- DNA fingerprinting is disabled by default for local AI to keep processing fast
- Batch size of 3 books per prompt works well for most local models
- Close other GPU-intensive apps while processing large libraries

---

## Cloud AI Setup

### OpenAI

1. Get an API key from [platform.openai.com](https://platform.openai.com/api-keys)
2. Open **Settings > AI Provider** and select **OpenAI**
3. Paste your API key
4. Default model is GPT-5 Nano (fast and cheap)

### Anthropic

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Open **Settings > AI Provider** and select **Anthropic**
3. Paste your API key

API keys are stored in your browser's localStorage and are never sent anywhere except directly to the AI provider's API.

---

## Architecture

Audiobook Tagger is a [Tauri 2.0](https://v2.tauri.app/) desktop app with a split architecture:

- **Frontend (React + Tailwind CSS)** — The UI and all AI/metadata logic. React 18 with Vite 5 for fast HMR during development. The frontend handles ABS API communication, AI prompt construction, batch orchestration, and metadata transformation.

- **Backend (Rust)** — The native shell providing filesystem access and process management. Handles local folder scanning (via `walkdir`), Ollama lifecycle management (install, start, stop, model downloads), and secure HTTP requests (via `reqwest`). Communicates with the frontend through Tauri's IPC command system.

- **Ollama Integration** — The Rust backend manages Ollama as a local subprocess. It can download the Ollama binary, start/stop the server, pull models, and monitor health. The frontend sends prompts to `localhost:11434` using Tauri's HTTP plugin.

```
┌─────────────────────────────────────────┐
│            Native Window (Tauri)         │
├──────────────────┬──────────────────────┤
│   React Frontend │    Rust Backend      │
│                  │                      │
│  - UI / Pages    │  - Folder scanner    │
│  - AI prompts    │  - Ollama manager    │
│  - ABS API       │  - File I/O          │
│  - Batch logic   │  - HTTP client       │
│                  │                      │
│   ◄── Tauri IPC commands ──►            │
└──────────────────┴──────────────────────┘
         │                    │
         ▼                    ▼
   AI Providers          Local Files
   (OpenAI/Claude/     (audiobook folders,
    Ollama)             Ollama binary)
```

---

## Building from Source

### Development

```bash
npm install          # Install JS dependencies
npm run tauri dev    # Start dev server + native app with hot reload
```

### Production Build

```bash
npm run tauri build  # Build optimized frontend + compile Rust + package installer
```

The output will be in `src-tauri/target/release/bundle/` — a `.dmg` on macOS, `.msi` on Windows, or `.deb`/`.AppImage` on Linux.

### Running Tests

```bash
npm test             # Run frontend tests (Vitest)
cd src-tauri && cargo test  # Run Rust tests
```

---

## Web Version

A browser-based version of Audiobook Tagger is available as a sibling project. It provides the same ABS integration and cloud AI features without requiring a desktop install, but does not support local AI (Ollama) or local folder scanning.

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create a branch** for your feature or fix (`git checkout -b feature/my-feature`)
3. **Make your changes** and add tests where appropriate
4. **Run tests** (`npm test` and `cargo test`) to make sure nothing is broken
5. **Commit** with a descriptive message following [Conventional Commits](https://www.conventionalcommits.org/) style
6. **Open a Pull Request** with a clear description of what changed and why

### Development Guidelines

- Frontend code is in `src/` (React + JSX)
- Rust backend code is in `src-tauri/src/`
- Use Tailwind CSS utility classes for styling
- Keep AI prompt logic in the frontend (`src/lib/` and `src/utils/`)
- Tauri commands should be thin wrappers — keep business logic in JS where possible

---

## License

This project is licensed under the [MIT License](LICENSE).

---

Built with [Tauri](https://v2.tauri.app/), [React](https://react.dev/), and [Rust](https://www.rust-lang.org/).
