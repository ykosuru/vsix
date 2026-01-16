[README.md](https://github.com/user-attachments/files/24659838/README.md)
# AstraCode v5.0

## What's New
- **Search Mode Toggle** - Radio buttons for Overview (📋) vs Detailed (💻) search
- **O(1) Indexes** - Symbol trigram, file name, and module indexes for fast lookups
- **search_calls Tool** - New tool for call graph queries

## Files
- `extension.js` - Full integrated extension (ready to use)
- `search-module.js` - Modular search system  
- `pathUtils.js` - Path utilities (**MUST REPLACE** - has new functions)
- `package.json` - Updated with searchMode setting

## Installation (IMPORTANT)

**You MUST replace ALL these files:**

1. `extension.js` - Replace your existing one
2. `search-module.js` - New file, copy to extension folder
3. `pathUtils.js` - **REPLACE existing** (has new functions: splitPath, getParentDirName)
4. `package.json` - Replace or merge the `astra.searchMode` setting

**If you get "pathUtils.splitPath is not a function"** - you didn't replace pathUtils.js!

## Search Modes
| Mode | What It Searches | Returns |
|------|------------------|---------|
| **Overview** | Summaries, architecture | NO source code |
| **Detailed** | Source code, exact text | Line numbers, code blocks |

## Index Building
When you add files, the extension automatically:
1. Builds symbol table (functions, classes, variables)
2. Builds call graph (who calls what)
3. Builds trigram index (fast text search)
4. Builds search indexes (O(1) lookups)
5. Generates summaries (via Copilot LLM)
