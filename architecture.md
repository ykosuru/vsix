[ARCHITECTURE.md](https://github.com/user-attachments/files/24756570/ARCHITECTURE.md)
# AstraCode Architecture

A technical overview of how AstraCode indexes codebases and performs intelligent search.

---

## Table of Contents

1. [Index Building Pipeline](#index-building-pipeline)
2. [Search Architecture](#search-architecture)
3. [Scoped Search with Grep](#scoped-search-with-grep)
4. [UI Architecture](#ui-architecture)

---

## Index Building Pipeline

When a user adds files to context and triggers index building, AstraCode creates **5 complementary indexes** in sequence:

```
Phase 1/5: Parse files → Extract symbols
Phase 2/5: Build call graph → Map function relationships  
Phase 3/5: Build trigram index → Fast substring matching
Phase 4/5: Build inverted index → Term-to-file mapping
Phase 5/5: Build vector index → Semantic similarity
```

### Phase 1: Symbol Extraction (CodebaseIndex)

**File:** `codebase-index.js`

Parses source files to extract:
- Functions (with signatures, line numbers, bodies)
- Structs/Classes
- Macros and constants
- Variables

**Language Support:**
- C/C++ (regex-based parser for functions, structs, macros)
- Java, Python, JavaScript, Go, Rust
- COBOL, TAL (legacy financial systems)

```javascript
// Symbol structure
{
  name: "brinvacuumcleanup",
  type: "function", 
  file: "/src/backend/access/brin/brin.c",
  line: 1317,
  signature: "IndexBulkDeleteResult * brinvacuumcleanup(IndexVacuumInfo *info, ...)",
  body: "{ ... function content ... }"
}
```

**Output:** `codebaseIndex.symbols` Map with ~28,000+ symbols for PostgreSQL

---

### Phase 2: Call Graph Construction

**File:** `codebase-index.js`

Scans function bodies to find function calls, building a directed graph:

```javascript
// Call graph structure
callGraph: Map {
  "brinvacuumcleanup" => ["brin_vacuum_scan", "brinGetStats", ...],
  "brin_vacuum_scan" => ["brin_page_cleanup", "ReadBuffer", ...],
  ...
}
```

**Uses:**
- "Who calls X?" queries
- Understanding code flow
- Impact analysis

**Output:** ~132,000 edges for PostgreSQL

---

### Phase 3: Trigram Index

**File:** `codebase-index.js` (inline) + `inverted-index.js`

Breaks text into 3-character sequences for fast substring search:

```
"vacuum" → ["vac", "acu", "cuu", "uum"]
```

**How it works:**
1. For each file, extract all trigrams from content
2. Build inverted map: trigram → [file1, file2, ...]
3. Query: intersect trigram posting lists

**Use case:** Finding partial matches, typo-tolerant search

**Output:** ~37,000 trigram terms

---

### Phase 4: Inverted Index

**File:** `inverted-index.js`

Maps searchable terms to files containing them:

```javascript
// Inverted index structure
{
  "vacuum": ["vacuum.c", "vacuumlazy.c", "autovacuum.c", ...],
  "brin": ["brin.c", "brin_pageops.c", "brin_revmap.c", ...],
  "index": ["index.c", "indexam.c", "indexcmds.c", ...]
}
```

**Tokenization:**
- Extracts words from symbol names (camelCase → camel, case)
- Indexes function names, file names, comments
- Removes stop words

**Use case:** Fast term lookup, boolean queries

**Output:** ~28,000 searchable terms

---

### Phase 5: Vector Index (TF-IDF Embeddings)

**File:** `vector-index.js`

Creates semantic embeddings for similarity search:

```javascript
// Vector structure
{
  chunks: [
    { file: "brin.c", content: "...", embedding: Float32Array[256] },
    { file: "vacuum.c", content: "...", embedding: Float32Array[256] },
    ...
  ],
  vocabulary: Map { "vacuum" => { idf: 2.3, index: 42 }, ... }
}
```

**Algorithm:**
1. Split files into chunks (~500 tokens each)
2. Compute TF-IDF weights for each term
3. Generate 256-dimension embedding via weighted hash
4. At query time: embed query → cosine similarity → rank chunks

**Use case:** "Find files about database cleanup" (semantic, not literal)

**Output:** ~927 vector embeddings (code files only)

---

## Search Architecture

AstraCode uses a **multi-strategy search** that combines results from multiple indexes:

```
User Query: "how does BRIN vacuum work?"
                    │
    ┌───────────────┼───────────────┐
    ▼               ▼               ▼
┌─────────┐   ┌──────────┐   ┌───────────┐
│  Grep   │   │  Vector  │   │ Inverted  │
│ Search  │   │  Search  │   │  Index    │
└────┬────┘   └────┬─────┘   └─────┬─────┘
     │             │               │
     ▼             ▼               ▼
  38 files     52 files        15 files
  (literal)   (semantic)      (term match)
                    │
                    ▼
         ┌──────────────────┐
         │  Merge & Score   │
         │  (union + boost) │
         └────────┬─────────┘
                  ▼
            207 unique files
                  │
                  ▼
         ┌──────────────────┐
         │   LLM Ranking    │
         │  (Copilot API)   │
         └────────┬─────────┘
                  ▼
         Top 50 most relevant
```

### Scoring Formula

```javascript
// Files matching multiple sources get boosted
if (grepMatch && vectorMatch) score += 15;
if (matchedAllQueryTerms) score += 25;

// Logarithmic scaling for match counts
score = baseScore + log2(matchCount + 1) * 6;

// Phrase matches scored higher than word matches
phraseBaseScore = 65;  // exact phrase
wordBaseScore = 50;    // individual word
```

---

## Scoped Search with Grep

**File:** `scoped-search.js`, `grep-search.js`

The `/grep` command activates **scoped search mode**, limiting subsequent queries to relevant files.

### How Grep Search Works

**File:** `grep-search.js`

1. **Build GrepIndex** - Index all file contents with line numbers
2. **Literal Search** - Find exact string matches (case-insensitive)
3. **Return matches** - File path, line number, match count

```javascript
// GrepIndex structure
{
  files: Map {
    "/src/brin.c" => {
      lines: ["line 1 content", "line 2 content", ...],
      functions: Map { "brinvacuumcleanup" => { start: 1317, end: 1350 } }
    }
  }
}
```

### Query Syntax

| Query | Behavior |
|-------|----------|
| `/grep vacuum` | OR search: files with "vacuum" |
| `/grep brin vacuum` | OR search: files with "brin" OR "vacuum" |
| `/grep "brin vacuum"` | Exact phrase search |
| `/grep "brin vacuum" index` | Phrase + word: phrase AND/OR "index" |

### Smart Phrase Fallback

When exact phrase finds 0 matches:

```
/grep "BRIN vacuum"
  │
  ▼ Exact phrase "brin vacuum" → 0 matches
  │
  ▼ Fallback: search "brin" + "vacuum" separately
  │
  ▼ Files with BOTH words get +25 bonus
  │
  ▼ Result: brin.c (✓), vacuum.c (✓), vacuumlazy.c
```

### Sibling Directory Expansion

Finds related files by looking at directory structure:

```
Query: "brin"
Found: /src/backend/access/brin/brin.c

Sibling expansion:
  /src/backend/access/brin/     → brin_pageops.c, brin_revmap.c, ...
  /src/backend/access/gin/      → gininsert.c, ginget.c, ...
  /src/backend/access/gist/     → gist.c, gistbuild.c, ...
  /src/backend/access/hash/     → hash.c, hashinsert.c, ...
```

### LLM Ranking (via GitHub Copilot)

**File:** `llm-client.js`

When 100+ files match, uses LLM to rank by relevance:

```javascript
// Prompt to Copilot
"Rank these files 1-100 for query 'BRIN vacuum'.
Consider: file names, directory context, likely content.
Return comma-separated numbers: most relevant first.

1. brin.c
2. vacuum.c
3. vacuumlazy.c
..."

// Response
"1,3,8,2,15,22,..."  // brin.c most relevant, then vacuumlazy.c, etc.
```

**Result:** Top 50 files selected for scoped search

---

## UI Architecture

**File:** `webview-html.js`

AstraCode uses VS Code's **Webview API** for the chat interface.

### Component Structure

```
┌─────────────────────────────────────────────────┐
│  Mode Selector: [Auto] [Local] [API]            │
├─────────────────────────────────────────────────┤
│  Search Mode: [Overview] [Code]                 │
├─────────────────────────────────────────────────┤
│  System Prompt: [Default ▼]                     │
├─────────────────────────────────────────────────┤
│  Context Bar: 📁 1235 files in context ▼        │
│    ├── brin.c (c • 45.2KB)                      │
│    ├── vacuum.c (c • 32.1KB)                    │
│    └── ... (collapsible)                        │
├─────────────────────────────────────────────────┤
│                                                 │
│  Chat Messages                                  │
│  ┌─────────────────────────────────────────┐    │
│  │ You: explain BRIN vacuum                │    │
│  └─────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────┐    │
│  │ AstraCode: Based on the code...         │    │
│  │                                         │    │
│  │ 🔍 Keep Exploring                       │    │
│  │ ┌─────────────────────────────────┐     │    │
│  │ │ How does revmap work?           │     │    │
│  │ └─────────────────────────────────┘     │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
├─────────────────────────────────────────────────┤
│  [🐛 Debug] [◇ Graph] [🧠 Search] [📄 Docs ▼]  │
├─────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────┐    │
│  │ Ask a question... (Ctrl+Enter to send)  │    │
│  └─────────────────────────────────────────┘    │
│  [📎 Add Files]                        [Send]   │
└─────────────────────────────────────────────────┘
```

### Message Flow

```
User types question
        │
        ▼
┌───────────────────┐
│  Webview (HTML)   │
│  postMessage()    │
└─────────┬─────────┘
          │ { type: 'chat', text: '...' }
          ▼
┌───────────────────┐
│  Extension Host   │
│  handleUserMessage│
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  Search Module    │
│  (find symbols)   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  Context Builder  │
│  (build prompt)   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  LLM Client       │
│  (Copilot API)    │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  Webview          │
│  postMessage()    │
│  { type: 'appendResponse' }
└───────────────────┘
```

### Markdown Rendering

**Custom renderer** in webview handles:

```javascript
function renderMarkdown(text) {
  // 1. Escape HTML
  // 2. Protect code blocks (``` ```)
  // 3. Protect inline code (`)
  // 4. Render headers (# ## ###)
  // 5. Render bold (**text**)
  // 6. Render italic (*text*)
  // 7. Detect "Keep Exploring" → clickable buttons
  // 8. Render links [text](url)
  // 9. Convert \n to <br>
  // 10. Restore code blocks with syntax highlighting
  // 11. Add file links (📄 path.c → clickable)
}
```

### Keep Exploring Feature

**Prompt addition** (`prompts.js`):
```
At the END of your response, add:
🔍 Keep Exploring
- **Topic 1**: Brief description
- **Topic 2**: Brief description
```

**UI conversion** (`webview-html.js`):
```javascript
// Detect "Keep Exploring" section
// Split by <br>, extract topics
// Convert to clickable buttons
// On click: postMessage({ type: 'chat', text: topic })
```

### Progress Indicators

```javascript
// Index building progress
{ type: 'indexProgress', progress: 45, message: 'Building call graph...' }

// Search progress
{ type: 'appendResponse', text: '⏳ Step 2/4: Searching 50 scoped files' }

// Scope activation
{ type: 'scopeStatus', status: { active: true, fileCount: 50, query: 'brin' } }
```

---

## File Summary

| File | Purpose |
|------|---------|
| `extension.js` | Main entry, command handlers, message routing |
| `codebase-index.js` | Symbol extraction, call graph, index building |
| `search-module.js` | Unified search interface |
| `scoped-search.js` | `/grep` command, file ranking, LLM integration |
| `grep-search.js` | Literal text search with line numbers |
| `inverted-index.js` | Term → files mapping |
| `vector-index.js` | TF-IDF embeddings, cosine similarity |
| `context-builder.js` | Build LLM prompts from search results |
| `llm-client.js` | GitHub Copilot API wrapper |
| `prompts.js` | System prompts, query templates |
| `webview-html.js` | Chat UI (HTML/CSS/JS) |
| `persistence.js` | Save/restore context files and chat history |

---

## Performance Characteristics

| Index | Build Time | Memory | Query Time |
|-------|-----------|--------|------------|
| Symbols | ~3s | ~15MB | <10ms |
| Call Graph | ~2s | ~8MB | <5ms |
| Trigrams | ~2s | ~20MB | <20ms |
| Inverted | ~1s | ~5MB | <5ms |
| Vectors | ~3s | ~10MB | ~50ms |
| **Total** | **~11s** | **~58MB** | - |

*Measured on PostgreSQL codebase (~1134 files, 28K symbols)*

---

## Future Improvements

1. **Incremental indexing** - Only re-index changed files
2. **Persistent indexes** - Save/load indexes to disk
3. **Better language parsers** - Tree-sitter for accurate AST
4. **Semantic embeddings** - Use actual ML models instead of TF-IDF
5. **Cross-reference navigation** - "Go to definition" from chat
