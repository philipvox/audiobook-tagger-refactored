# 🎧 Audiobook Tagger

A powerful desktop application for automatically tagging and organizing audiobook files using AI-powered metadata extraction.

![Tauri](https://img.shields.io/badge/Tauri-2.0-blue)
![Rust](https://img.shields.io/badge/Rust-1.70+-orange)
![React](https://img.shields.io/badge/React-18-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## ✨ Features

- 🔍 **Multi-Source Metadata Fetching**
  - Google Books API integration
  - Audible scraping support
  - GPT-5-nano AI enhancement

- 📝 **Intelligent Tag Writing**
  - Proper genre separation for AudiobookShelf
  - Correct narrator field placement
  - Clean, formatted descriptions
  - Series and sequence detection

- 🛠️ **Advanced Tools**
  - Raw tag inspector for debugging
  - Batch processing support
  - Parallel scanning (M4 optimized)
  - Smart caching system

- 📚 **AudiobookShelf Optimized**
  - Formats tags exactly how AudiobookShelf expects
  - Multiple genre support
  - Proper narrator metadata
  - Series information preservation

- 🎨 **Beautiful UI**
  - Modern, responsive interface
  - Real-time progress tracking
  - Group-based organization
  - File selection with preview

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ 
- **Rust** 1.70+
- **Tauri CLI**
- **OpenAI API Key** (for GPT enhancement)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/audiobook-tagger.git
cd audiobook-tagger

# Install frontend dependencies
npm install

# Install Tauri CLI (if not already installed)
cargo install tauri-cli

# Build the application
npm run tauri build

# Or run in development mode
npm run tauri dev
```

### Configuration

1. **Set up OpenAI API Key** (optional, for AI enhancement):
   - Get your key from [OpenAI Platform](https://platform.openai.com/)
   - Enter it in the Settings tab within the app

2. **Configure AudiobookShelf connection** (optional):
   - Enter your AudiobookShelf server URL
   - Provide your API token
   - Test connection in Settings

## 📖 Usage

### Basic Workflow

1. **Configure Library Path**
   - Click the Settings tab
   - Select your audiobook directory
   - Save settings

2. **Scan Library**
   - Click "Scan Library" button
   - Wait for scan to complete
   - Review detected books and metadata

3. **Review & Edit**
   - Expand groups to see individual files
   - Review suggested metadata
   - Edit any fields as needed

4. **Write Tags**
   - Select files or entire groups
   - Click "Write Tags"
   - Tags are written directly to audio files

5. **Debug with Tag Inspector**
   - Click "Inspect Tags" button
   - Select any audio file
   - View raw metadata without processing

### Advanced Features

#### Parallel Processing

Adjust worker count in Settings for faster scanning:
- M4 Mac: 20-30 workers recommended
- Intel Mac: 10-15 workers
- Default: 10 workers

#### Smart Caching

Enable caching to speed up re-scans:
- Genre mappings cached
- Metadata API responses cached
- Skip unchanged files option

#### Series Detection

Automatically detects series from filenames:
- "Book Title - Book 1" → Series: "Book Title", Sequence: "1"
- "Series Name: Volume 2" → Series: "Series Name", Sequence: "2"

## 🏗️ Architecture

### Tech Stack

**Frontend:**
- React 18
- Vite
- TailwindCSS
- Lucide Icons

**Backend:**
- Rust (Tauri)
- lofty (audio tag manipulation)
- tokio (async runtime)
- reqwest (HTTP client)

**APIs:**
- OpenAI GPT-5-nano
- Google Books API
- Audible (web scraping)

### Project Structure

```
audiobook-tagger/
├── src/                    # React frontend
│   ├── App.jsx            # Main application
│   ├── components/        # React components
│   │   └── RawTagInspector.jsx
│   └── styles.css         # TailwindCSS
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── main.rs        # Entry point
│   │   ├── scanner.rs     # File scanning logic
│   │   ├── metadata.rs    # Google Books integration
│   │   ├── processor.rs   # GPT processing
│   │   ├── tags.rs        # Tag writing logic
│   │   ├── tag_inspector.rs  # Tag inspection
│   │   ├── audible.rs     # Audible integration
│   │   ├── genres.rs      # Genre mapping
│   │   └── config.rs      # Configuration
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

## 🎯 AudiobookShelf Integration

This app writes tags in the exact format AudiobookShelf expects:

| AudiobookShelf Field | Audio File Tag |
|---------------------|----------------|
| Title | TrackTitle |
| Author | TrackArtist |
| Narrator | **Composer** ⚠️ |
| Description | Comment |
| Genres | Multiple Genre tags |
| Series | Custom "SERIES" tag |
| Sequence | Custom "SERIES-PART" tag |

### Why Composer for Narrator?

AudiobookShelf reads narrator information from the **Composer** tag, not the Comment field. This app correctly writes narrator to the Composer tag to ensure proper display in AudiobookShelf.

### Multiple Genres

AudiobookShelf requires genres as **separate tags**, not comma-separated. This app correctly creates multiple genre tags:

```rust
// Correct (what this app does):
tag.push(TagItem::new(ItemKey::Genre, "Mystery"));
tag.push(TagItem::new(ItemKey::Genre, "Thriller"));
tag.push(TagItem::new(ItemKey::Genre, "Fiction"));

// Wrong (what other tools might do):
tag.insert_text(ItemKey::Genre, "Mystery, Thriller, Fiction");
```

## 🐛 Debugging

### Tag Inspector Tool

Use the built-in tag inspector to debug issues:

1. Click "Inspect Tags" button
2. Select an audio file
3. View all raw metadata

Check for:
- ✅ Multiple separate genre tags (not comma-separated)
- ✅ Narrator in Composer field (not Comment)
- ✅ Clean description without debug strings

### Common Issues

**Only 1 genre showing in AudiobookShelf:**
- Use tag inspector to verify multiple Genre tags exist
- If not, re-write tags with this app

**Narrator not appearing:**
- Check tag inspector shows narrator in Composer field
- If in Comment field, re-write tags

**Debug output in description:**
- Update to latest version (uses description cleaning)
- Re-scan and write tags

## 🔧 Development

### Running in Development

```bash
# Terminal 1: Run Vite dev server
npm run dev

# Terminal 2: Run Tauri dev window
npm run tauri dev
```

### Building for Production

```bash
# Build for current platform
npm run tauri build

# Output in: src-tauri/target/release/bundle/
```

### Testing

```bash
# Run Rust tests
cd src-tauri
cargo test

# Check Rust formatting
cargo fmt --check

# Run Clippy linter
cargo clippy
```

## 📝 Configuration File

Located at: `~/.audiobook-tagger/config.json` (or OS equivalent)

```json
{
  "library_paths": ["/path/to/audiobooks"],
  "openai_api_key": "sk-...",
  "abs_url": "http://localhost:3000",
  "abs_token": "...",
  "use_google_books": true,
  "use_audible": false,
  "parallel_workers": 10,
  "backup_tags": true,
  "genre_enforcement": true,
  "skip_unchanged": false
}
```

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Tauri](https://tauri.app/) - Desktop app framework
- [lofty](https://github.com/Serial-ATA/lofty-rs) - Audio metadata library
- [AudiobookShelf](https://www.audiobookshelf.org/) - Audiobook server
- [OpenAI](https://openai.com/) - GPT API

## 📞 Support

- 🐛 [Report a Bug](https://github.com/yourusername/audiobook-tagger/issues)
- 💡 [Request a Feature](https://github.com/yourusername/audiobook-tagger/issues)
- 💬 [Discussions](https://github.com/yourusername/audiobook-tagger/discussions)

## 🗺️ Roadmap

- [ ] Support for more audio formats (AAC, OGG)
- [ ] Batch export to CSV
- [ ] Custom genre mappings
- [ ] Cover art management
- [ ] Direct AudiobookShelf upload
- [ ] macOS/Windows/Linux builds in CI
- [ ] Integration tests

---

**Made with ❤️ for audiobook lovers**
