🤖 AGENTS.md - Guide for AI Assistants
This document helps AI assistants (Claude, GPT, etc.) understand and work with the Audiobook Tagger project.

📋 Project Overview
Name: Audiobook Tagger
Type: Desktop Application (Tauri + Rust + React)
Purpose: Automatically tag audiobook files with metadata from multiple sources
Target: AudiobookShelf users who need properly tagged audiobook files
Tech Stack

Backend: Rust (Tauri framework)
Frontend: React 18 + Vite + TailwindCSS
APIs: OpenAI GPT-5-nano, Google Books, Audible (scraping)
Audio Tags: lofty crate (Rust)
Platforms: macOS, Windows, Linux


🎯 Core Functionality
What It Does

Scans audiobook library (M4A/M4B/MP3 files)
Fetches metadata from:

Google Books API
Audible website (scraping)
OpenAI GPT-5-nano (enhancement)


Processes metadata:

Cleans descriptions
Maps genres to approved list
Extracts narrator, series info


Writes tags to audio files using lofty
Optimized for AudiobookShelf server display

Key Challenge
AudiobookShelf has specific requirements for tag format:

Narrator must be in Composer field (NOT Comment)
Genres must be separate tags (NOT comma-separated)
Description in Comment field (no narrator text)


📁 Project Structure
audiobook-tagger-working/
├── src/                          # React frontend
│   ├── App.jsx                   # Main application
│   ├── components/
│   │   └── RawTagInspector.jsx  # Tag debugging tool
│   └── styles.css               # TailwindCSS
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs              # Entry point & Tauri commands
│   │   ├── scanner.rs           # File scanning & detection
│   │   ├── tags.rs              # Tag reading/writing ⚠️ CRITICAL
│   │   ├── processor.rs         # Metadata processing & GPT
│   │   ├── metadata.rs          # Google Books integration
│   │   ├── audible.rs           # Audible scraping
│   │   ├── genres.rs            # Genre mapping
│   │   ├── tag_inspector.rs     # Raw tag inspection
│   │   └── config.rs            # Configuration
│   └── Cargo.toml
└── package.json

🔧 Critical Files & Known Issues
tags.rs ⚠️ MOST IMPORTANT
Purpose: Writes metadata to audio file tags
Critical Issues Solved:

Genre Separation (FIXED):

rust// ❌ WRONG - Only writes 1 genre
tag.insert_text(ItemKey::Genre, all_genres_joined);

// ✅ CORRECT - Multiple separate tags
for genre in &genres {
    let item = TagItem::new(ItemKey::Genre, ItemValue::Text(genre.to_string()));
    tag.push(item);  // Each genre is separate
}

Narrator Field (FIXED):

rust// ❌ WRONG - Narrator in Comment (shows in description)
tag.set_comment(format!("Narrated by {}", narrator));

// ✅ CORRECT - Narrator in Composer
tag.insert_text(ItemKey::Composer, narrator);
tag.remove_key(&ItemKey::Comment);  // Clear comment
Latest Fixed Version: /mnt/user-data/outputs/tags_CLEAN.rs

processor.rs ⚠️ IMPORTANT
Purpose: Processes metadata with GPT-5-nano
Critical Issues Solved:

GPT Model (CORRECTED):

rust// ✅ CORRECT - Model exists (released Aug 2025)
"model": "gpt-5-nano",
"verbosity": "low",          // Valid parameter
"reasoning_effort": "minimal" // Valid parameter

Description Cleaning:

rust// Function to remove debug output like Some("..."), Authors: [...]
fn clean_description(desc: &str) -> Option<String> {
    // Remove Rust debug strings
    let cleaned = desc
        .replace("Some(\"", "")
        .replace("\")", "")
        // ... more cleaning
}
Latest Fixed Version: /mnt/user-data/outputs/processor_CORRECT.rs

App.jsx ⚠️ CURRENT ISSUE
Problem: Modal placed outside return statement
Location: Lines 1001-1006
Current (WRONG):
jsx    </div>
  );      // ← Return ends
}         // ← Function ends
{showTagInspector && (  // ← OUTSIDE! Syntax error
  <RawTagInspector />
)}
Should Be:
jsx    </div>
    
    {showTagInspector && (
      <RawTagInspector 
        isOpen={showTagInspector} 
        onClose={() => setShowTagInspector(false)} 
      />
    )}
  );     // ← Return ends
}        // ← Function ends

🎓 AudiobookShelf Tag Mapping
CRITICAL: This is the MOST COMMON source of confusion!
AudiobookShelf FieldAudio File TagNotesTitleTrackTitleStandardAuthorTrackArtistStandardNarratorComposer⚠️ NOT Comment!DescriptionCommentNo narrator textGenresMultiple Genre tags⚠️ NOT comma-separated!SeriesCustom "SERIES" tagCase-sensitiveSequenceCustom "SERIES-PART" tagCase-sensitivePublisherPublisherStandardYearYearYYYY format
Why This Matters
Users report:

"Only 1 genre showing" → Genres not separated
"Narrator in description" → Using Comment instead of Composer
"Debug output in description" → GPT returning raw Rust code


🤝 How to Help Users
Common User Issues & Solutions
Issue #1: "Genres only showing 1"
Diagnosis:
bash# Check if genres are separated
docker-compose run --rm dev bash
cargo run -- inspect-tags /path/to/file.m4b
# Look for: Genre #1, Genre #2, Genre #3
Solution:

Use tags_CLEAN.rs (has correct genre separation)
Ensure using TagItem + push() not insert_text()


Issue #2: "Narrator in description"
Diagnosis:

AudiobookShelf shows "Narrated by Narrated by Name"
Duplication means narrator in Comment field

Solution:

Write narrator ONLY to Composer field
Clear Comment field or use clean description
Use tags_CLEAN.rs


Issue #3: "Debug output in description"
Example: Some("Title"), Authors: ["Name"]
Diagnosis:

GPT returning Rust debug strings
Description not being cleaned

Solution:

Use processor_CORRECT.rs (has cleaning function)
Ensure GPT prompt enforces JSON-only output


Issue #4: "App won't compile - JSX error"
Error: Unexpected token at line 235
Diagnosis:

Modal component outside return statement
React syntax error

Solution:

Move modal inside return statement
See App.jsx fix above
Or use React Fragment


💡 Code Patterns & Conventions
Rust Patterns
Tag Writing Pattern:
rust// Always remove old values first
tag.remove_key(&ItemKey::Genre);

// Use TagItem for multiple values
for value in &values {
    let item = TagItem::new(
        ItemKey::Genre,
        ItemValue::Text(value.to_string())
    );
    tag.push(item);
}
Error Handling:
rust// Use anyhow for errors
use anyhow::Result;

pub async fn do_thing() -> Result<Data> {
    let data = fetch_data().await?;
    Ok(data)
}
Logging:
rust// Use println! for user-visible messages
println!("✅ Wrote {} genre tags", count);
println!("⚠️  Warning: {}", message);
println!("❌ Error: {}", error);

React Patterns
Component Structure:
jsx// Functional components with hooks
function Component({ prop1, prop2 }) {
  const [state, setState] = useState(null);
  
  useEffect(() => {
    // Side effects
  }, [dependency]);
  
  return (
    <div className="tailwind-classes">
      {/* JSX */}
    </div>
  );
}
Tauri Commands:
jsx// Call Rust backend
const result = await invoke('rust_command_name', { 
  param: value 
});

🔍 Debugging Tools
Tag Inspector
Purpose: View raw file tags without processing
Location: src/components/RawTagInspector.jsx + src-tauri/src/tag_inspector.rs
Usage:
jsx// User clicks "Inspect Tags" button
// Selects audio file
// Sees ALL raw tags:
// - Genre #1, #2, #3 (check separation)
// - Composer (check narrator)
// - Comment (check description)
When to Recommend:

User unsure what tags are written
Debugging genre issues
Verifying narrator field
Checking for debug output


🎯 Quick Help Scenarios
Scenario 1: User Wants to Start Using Git
Recommend:

Read: QUICKSTART.md
Run: setup_repo.sh
Daily: git pull && work && git push

Key Points:

Never need to re-download
Files stay in same place
Commit before pulling


Scenario 2: User Wants Docker
Recommend:

Read: DOCKER_GUIDE.md
Copy: Dockerfile.dev, docker-compose.yml
Build: docker-compose build dev

But Also Say:

Docker optional for Tauri desktop apps
Can't run GUI in Docker easily
Good for builds, not daily dev
Git alone is fine!


Scenario 3: User Has Tagging Issues
Ask:

Which AudiobookShelf field shows wrong?
What should it show?
Can they use Tag Inspector?

Then:

Genre issue → Provide tags_CLEAN.rs
Narrator issue → Provide tags_CLEAN.rs
Description issue → Provide processor_CORRECT.rs
All issues → Provide both + explain integration


Scenario 4: User Needs Code Handoff
Provide:

CLAUDE_HANDOFF.md - Comprehensive context
TLDR_HANDOFF.md - Quick summary
NEW_CLAUDE_CHECKLIST.md - Action steps

Request from User:

src/App.jsx (if JSX error)
src-tauri/src/tags.rs (if genre/narrator issues)
src-tauri/src/processor.rs (if GPT issues)

Only 3 files needed! Everything else in handoff docs.

📚 Documentation Quick Reference
For Users
User NeedDocumentFirst-time setupQUICKSTART.mdGit basicsGIT_WORKFLOW_GUIDE.mdDocker basicsDOCKER_GUIDE.mdGit + DockerGIT_DOCKER_WORKFLOW.mdQuick commandsGIT_QUICK_REFERENCE.mdUnderstanding pullUNDERSTANDING_GIT_PULL.mdAll docsINDEX.md
For AI Assistants
NeedDocumentProject contextThis file (AGENTS.md)Complete handoffCLAUDE_HANDOFF.mdQuick handoffTLDR_HANDOFF.mdAction checklistNEW_CLAUDE_CHECKLIST.mdMinimal files listMINIMAL_FILES_REQUEST.md

⚠️ Critical Reminders for AI Agents
1. gpt-5-nano IS REAL

Released August 2025
Don't suggest changing the model name
Parameters verbosity and reasoning_effort are valid

2. Genre Separation is Critical

AudiobookShelf REQUIRES separate tags
insert_text() doesn't work - use TagItem + push()
This is the #1 user issue

3. Narrator Field Mapping

AudiobookShelf reads narrator from Composer
NOT from Comment (that's description)
This causes "Narrated by Narrated by" duplication

4. File Locations Matter

Fixed files in: /mnt/user-data/outputs/
User's project: ~/Desktop/Code Projects/audiobook-tagger-working/
Always use full paths
5. Don't Over-Request Files

Maximum 3 files needed from user
Everything else in handoff docs
Saves ~90k tokens


🎓 Learning From Past Issues
Issue: AI Suggested Wrong Model
What Happened: Suggested changing gpt-5-nano to gpt-4o
Why Wrong: gpt-5-nano exists and is correct
Lesson: Always verify current model names before suggesting changes
Issue: Suggested Wrong Genre Fix
What Happened: Suggested using set_genre() with comma-separated string
Why Wrong: AudiobookShelf needs separate tags
Lesson: Understand the target system's requirements (AudiobookShelf)
Issue: Over-Complicated Docker Setup
What Happened: Suggested complex X11 forwarding for GUI
Why Wrong: Tauri apps aren't meant to run GUI in Docker
Lesson: Understand the use case (builds, not GUI running)

🔄 Integration Checklist
When user needs to integrate fixes:
Backend Fixes:

 Copy tags_CLEAN.rs → src-tauri/src/tags.rs
 Copy processor_CORRECT.rs → src-tauri/src/processor.rs
 Copy tag_inspector.rs → src-tauri/src/tag_inspector.rs
 Update main.rs with inspect_file_tags command
 Run cargo build

Frontend Fixes:

 Fix App.jsx modal placement
 Copy RawTagInspector.jsx → src/components/
 Verify imports in App.jsx
 Run npm run tauri dev

Verification:

 App compiles without errors
 Tag inspector opens
 Can scan books
 Can write tags
 Genres show as separate in inspector
 Narrator in Composer field


🎯 Success Metrics
User issue is resolved when:
✅ Genre Issue: Tag inspector shows Genre #1, Genre #2, Genre #3 separately
✅ Narrator Issue: Tag inspector shows narrator in Composer field only
✅ Description Issue: No debug strings like Some("...") in comments
✅ App Issue: Code compiles and runs without errors
✅ AudiobookShelf: All metadata displays correctly

💬 Communication Tips
Be Clear About:

Whether Docker is needed (usually not)
That fixes are complete (just need integration)
File locations and paths
What git pull actually does

Avoid:

Suggesting to re-download project (use git!)
Over-complicating Docker for desktop apps
Requesting unnecessary files (3 max)
Changing working code (gpt-5-nano is correct)

Always:

Read handoff docs if continuing work
Provide file download links
Explain WHY not just HOW
Test understanding ("Does this make sense?")


🚀 Quick Start for New AI Agent
1. Read this file (AGENTS.md)
2. Check if continuing previous work:
   - Yes? Read CLAUDE_HANDOFF.md
   - No? Start fresh
3. Identify user issue from list above
4. Provide appropriate solution from outputs/
5. Explain clearly and concisely
6. Verify user understands

📞 Common User Questions
Q: "How do I use Git?"
A: Point to QUICKSTART.md and GIT_WORKFLOW_GUIDE.md
Q: "Do I need Docker?"
A: No, it's optional. Git alone is fine. Docker is for builds/CI/CD.
Q: "Will git pull delete my work?"
A: No if you commit first. Read UNDERSTANDING_GIT_PULL.md
Q: "How do I fix genres?"
A: Use tags_CLEAN.rs - has correct genre separation
Q: "Narrator showing in description?"
A: Use tags_CLEAN.rs - writes to Composer field
Q: "Debug output in description?"
A: Use processor_CORRECT.rs - has cleaning function

✅ Final Checklist for AI Agents
Before responding to user:

 Understood the actual problem
 Checked if issue already solved (outputs/)
 Read handoff docs if continuing work
 Know which files to request (3 max)
 Have clear, actionable solution
 Can explain WHY not just HOW
 Provided file download links
 Used appropriate documentation


🎉 You're Ready!
This file gives you everything needed to help users effectively with this project. Focus on:

Understanding the core issues (genres, narrator, descriptions)
Providing the correct fixed files
Explaining clearly and concisely
Verifying user success

The fixes are done. You're the delivery person! 📦