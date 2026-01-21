/**
 * AstraCode Grep Search Module v1.0
 * 
 * Provides literal string and regex search across codebase.
 * Fills the critical gap for "who calls X?" queries that semantic search misses.
 * 
 * Key Features:
 * - Literal string search (case-sensitive/insensitive)
 * - Regex pattern search
 * - Function call site detection ("who calls X?")
 * - Context lines around matches
 * - File pattern filtering
 * - Pre-indexed function calls for fast lookup
 * 
 * Usage:
 *   const { GrepIndex } = require('./grep-search');
 *   const grepIndex = new GrepIndex({ contextLines: 2 });
 *   grepIndex.build(contextFiles);
 *   
 *   // Literal search
 *   const results = grepIndex.searchLiteral('heap_insert');
 *   
 *   // Regex search
 *   const results = grepIndex.searchRegex('heap_\\w+\\s*\\(');
 *   
 *   // Find call sites (the key feature for "who calls X?")
 *   const callSites = grepIndex.searchFunctionCalls('heap_insert');
 */

// ============================================================
// GREP INDEX CLASS
// ============================================================

class GrepIndex {
    constructor(options = {}) {
        this.options = {
            maxFileSize: 500000,      // Skip files > 500KB
            maxResults: 200,
            contextLines: 2,          // Lines before/after match
            buildCallIndex: true,     // Pre-index function calls
            excludePatterns: [        // Files to skip
                /node_modules/,
                /\.min\.js$/,
                /\.map$/,
                /dist\//,
                /build\//
            ],
            ...options
        };
        
        // Store file contents for searching
        this.files = new Map();       // filePath -> content
        
        // Line index for fast line lookup
        this.lineIndex = new Map();   // filePath -> [line1, line2, ...]
        
        // Precomputed function call index for fast "who calls X?" queries
        this.functionCallIndex = new Map();  // funcName -> [{file, line, column, context}]
        
        // Statistics
        this.stats = {
            files: 0,
            totalLines: 0,
            totalBytes: 0,
            indexedCalls: 0,
            uniqueFunctions: 0,
            buildTime: 0,
            lastUpdated: null
        };
    }
    
    // ============================================================
    // INDEX BUILDING
    // ============================================================
    
    /**
     * Build grep index from context files
     * @param {Map} contextFiles - Map of filePath -> { content, language }
     * @param {Object} options - Build options
     */
    build(contextFiles, options = {}) {
        const { log = console.log, onProgress = null } = options;
        const startTime = Date.now();
        
        this.clear();
        
        let processed = 0;
        const totalFiles = contextFiles.size;
        
        for (const [filePath, fileInfo] of contextFiles) {
            // Skip excluded patterns
            if (this._shouldExclude(filePath)) continue;
            
            // Skip oversized files
            if (!fileInfo.content || fileInfo.content.length > this.options.maxFileSize) continue;
            
            // Store content and lines
            this.files.set(filePath, fileInfo.content);
            this.lineIndex.set(filePath, fileInfo.content.split('\n'));
            
            this.stats.totalBytes += fileInfo.content.length;
            this.stats.totalLines += this.lineIndex.get(filePath).length;
            this.stats.files++;
            
            processed++;
            if (onProgress && processed % 100 === 0) {
                onProgress(Math.round((processed / totalFiles) * 100), 
                    `Indexing for grep: ${processed}/${totalFiles}`);
            }
        }
        
        // Build function call index for fast "who calls X?" queries
        if (this.options.buildCallIndex) {
            this._buildFunctionCallIndex(log);
        }
        
        this.stats.buildTime = Date.now() - startTime;
        this.stats.lastUpdated = new Date();
        
        log(`GrepIndex built in ${this.stats.buildTime}ms:`);
        log(`  - ${this.stats.files} files`);
        log(`  - ${this.stats.totalLines} lines`);
        log(`  - ${this.stats.uniqueFunctions} unique functions indexed`);
        log(`  - ${this.stats.indexedCalls} total call sites`);
        
        return this.stats;
    }
    
    /**
     * Build index of function call sites
     * This enables O(1) lookup for "who calls X?" queries
     */
    _buildFunctionCallIndex(log = console.log) {
        // Pattern to match function calls: identifier followed by (
        // Captures: function_name, method_name after . or ->
        const callPatterns = [
            /\b([a-zA-Z_]\w*)\s*\(/g,           // func(
            /\.([a-zA-Z_]\w*)\s*\(/g,            // obj.method(
            /->([a-zA-Z_]\w*)\s*\(/g,            // ptr->method(
            /::([a-zA-Z_]\w*)\s*\(/g,            // Class::method(
        ];
        
        // Common keywords to exclude (not function calls)
        const excludeKeywords = new Set([
            'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof',
            'typeof', 'instanceof', 'new', 'delete', 'throw', 'await',
            'assert', 'defined', 'elif', 'ifdef', 'ifndef', 'endif',
            // Common macros
            'NULL', 'TRUE', 'FALSE', 'true', 'false'
        ]);
        
        let totalCalls = 0;
        
        for (const [filePath, content] of this.files) {
            const lines = this.lineIndex.get(filePath);
            
            for (const pattern of callPatterns) {
                pattern.lastIndex = 0;
                let match;
                
                while ((match = pattern.exec(content)) !== null) {
                    const funcName = match[1];
                    
                    // Skip keywords and very short names
                    if (excludeKeywords.has(funcName) || funcName.length < 2) continue;
                    
                    // Calculate position
                    const beforeMatch = content.substring(0, match.index);
                    const lineNum = beforeMatch.split('\n').length;
                    const lastNewline = beforeMatch.lastIndexOf('\n');
                    const column = match.index - lastNewline;
                    const lineIdx = lineNum - 1;
                    
                    // Store call site
                    if (!this.functionCallIndex.has(funcName)) {
                        this.functionCallIndex.set(funcName, []);
                    }
                    
                    this.functionCallIndex.get(funcName).push({
                        file: filePath,
                        line: lineNum,
                        column: column,
                        context: lines[lineIdx]?.trim() || '',
                        matchText: match[0]
                    });
                    
                    totalCalls++;
                }
            }
        }
        
        this.stats.indexedCalls = totalCalls;
        this.stats.uniqueFunctions = this.functionCallIndex.size;
    }
    
    /**
     * Check if file should be excluded
     */
    _shouldExclude(filePath) {
        return this.options.excludePatterns.some(p => p.test(filePath));
    }
    
    // ============================================================
    // SEARCH METHODS
    // ============================================================
    
    /**
     * Search for literal string
     * @param {string} pattern - String to search for
     * @param {Object} options - Search options
     */
    searchLiteral(pattern, options = {}) {
        const {
            caseSensitive = false,
            wholeWord = false,
            maxResults = this.options.maxResults,
            filePattern = null,
            includeContext = true
        } = options;
        
        const results = [];
        const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
        
        for (const [filePath, content] of this.files) {
            // Filter by file pattern if specified
            if (filePattern && !this._matchesFilePattern(filePath, filePattern)) continue;
            
            const searchContent = caseSensitive ? content : content.toLowerCase();
            const lines = this.lineIndex.get(filePath);
            
            let pos = 0;
            while ((pos = searchContent.indexOf(searchPattern, pos)) !== -1) {
                // Calculate line number
                const beforeMatch = content.substring(0, pos);
                const lineNum = beforeMatch.split('\n').length;
                const lineIdx = lineNum - 1;
                const lastNewline = beforeMatch.lastIndexOf('\n');
                const column = pos - lastNewline;
                
                // Check whole word boundary if required
                if (wholeWord) {
                    const before = pos > 0 ? content[pos - 1] : ' ';
                    const after = pos + pattern.length < content.length 
                        ? content[pos + pattern.length] : ' ';
                    if (/\w/.test(before) || /\w/.test(after)) {
                        pos++;
                        continue;
                    }
                }
                
                const result = {
                    file: filePath,
                    line: lineNum,
                    column: column,
                    matchLine: lines[lineIdx] || '',
                    matchText: content.substr(pos, pattern.length),
                    matchType: 'literal'
                };
                
                // Add context if requested
                if (includeContext) {
                    result.context = {
                        before: lines.slice(
                            Math.max(0, lineIdx - this.options.contextLines), 
                            lineIdx
                        ),
                        after: lines.slice(
                            lineIdx + 1, 
                            lineIdx + 1 + this.options.contextLines
                        )
                    };
                }
                
                results.push(result);
                
                if (results.length >= maxResults) {
                    return { results, truncated: true, total: results.length };
                }
                
                pos++;
            }
        }
        
        return { results, truncated: false, total: results.length };
    }
    
    /**
     * Search using regex pattern
     * @param {string} pattern - Regex pattern string
     * @param {Object} options - Search options
     */
    searchRegex(pattern, options = {}) {
        const {
            flags = 'gim',
            maxResults = this.options.maxResults,
            filePattern = null,
            includeContext = true
        } = options;
        
        const results = [];
        let regex;
        
        try {
            regex = new RegExp(pattern, flags);
        } catch (e) {
            return { results: [], error: `Invalid regex: ${e.message}`, total: 0 };
        }
        
        for (const [filePath, content] of this.files) {
            if (filePattern && !this._matchesFilePattern(filePath, filePattern)) continue;
            
            const lines = this.lineIndex.get(filePath);
            regex.lastIndex = 0;
            let match;
            
            while ((match = regex.exec(content)) !== null) {
                const beforeMatch = content.substring(0, match.index);
                const lineNum = beforeMatch.split('\n').length;
                const lineIdx = lineNum - 1;
                const lastNewline = beforeMatch.lastIndexOf('\n');
                const column = match.index - lastNewline;
                
                const result = {
                    file: filePath,
                    line: lineNum,
                    column: column,
                    matchLine: lines[lineIdx] || '',
                    matchText: match[0],
                    groups: match.slice(1),
                    matchType: 'regex'
                };
                
                if (includeContext) {
                    result.context = {
                        before: lines.slice(
                            Math.max(0, lineIdx - this.options.contextLines), 
                            lineIdx
                        ),
                        after: lines.slice(
                            lineIdx + 1, 
                            lineIdx + 1 + this.options.contextLines
                        )
                    };
                }
                
                results.push(result);
                
                if (results.length >= maxResults) {
                    return { results, truncated: true, total: results.length };
                }
                
                // Prevent infinite loop on zero-width matches
                if (match[0].length === 0) {
                    regex.lastIndex++;
                }
            }
        }
        
        return { results, truncated: false, total: results.length };
    }
    
    /**
     * Search for function call sites - THE KEY METHOD for "who calls X?"
     * Uses pre-built index for O(1) lookup
     * 
     * @param {string} funcName - Function name to find calls to
     * @param {Object} options - Search options
     */
    searchFunctionCalls(funcName, options = {}) {
        const {
            includeDefinitions = false,
            maxResults = this.options.maxResults,
            filePattern = null
        } = options;
        
        // Fast path: use pre-built index
        let callSites = this.functionCallIndex.get(funcName) || [];
        
        // Filter by file pattern if specified
        if (filePattern) {
            callSites = callSites.filter(site => 
                this._matchesFilePattern(site.file, filePattern)
            );
        }
        
        // Filter out definitions if requested
        if (!includeDefinitions) {
            callSites = callSites.filter(site => {
                // Heuristic: definitions have return type before name
                // and usually start near beginning of line
                const line = site.context;
                
                // Skip if looks like a function definition
                const defPatterns = [
                    // C-style: type func_name(
                    new RegExp(`^\\s*(?:static\\s+)?(?:inline\\s+)?(?:\\w+\\s+\\*?\\s*)${this._escapeRegex(funcName)}\\s*\\(`),
                    // Declaration: returnType funcName(params);
                    new RegExp(`^\\s*\\w+[\\s\\*]+${this._escapeRegex(funcName)}\\s*\\([^)]*\\)\\s*;`),
                    // Definition start
                    new RegExp(`^\\s*(?:void|int|char|bool|float|double|\\w+)\\s+${this._escapeRegex(funcName)}\\s*\\(`)
                ];
                
                return !defPatterns.some(p => p.test(line));
            });
        }
        
        // Add context from line index
        const results = callSites.slice(0, maxResults).map(site => {
            const lines = this.lineIndex.get(site.file);
            const lineIdx = site.line - 1;
            
            return {
                ...site,
                matchType: 'function_call',
                context: {
                    before: lines?.slice(
                        Math.max(0, lineIdx - this.options.contextLines), 
                        lineIdx
                    ) || [],
                    after: lines?.slice(
                        lineIdx + 1, 
                        lineIdx + 1 + this.options.contextLines
                    ) || []
                }
            };
        });
        
        return {
            funcName,
            results,
            totalCallSites: this.functionCallIndex.get(funcName)?.length || 0,
            truncated: results.length < (this.functionCallIndex.get(funcName)?.length || 0)
        };
    }
    
    /**
     * Find all usages of a symbol (calls + references)
     * More comprehensive than searchFunctionCalls
     */
    searchSymbolUsages(symbolName, options = {}) {
        const { maxResults = this.options.maxResults } = options;
        
        // Combine function calls with literal matches
        const callResults = this.searchFunctionCalls(symbolName, options);
        
        // Also search for other usages (assignments, comparisons, etc.)
        const literalResults = this.searchLiteral(symbolName, {
            ...options,
            wholeWord: true,
            maxResults: maxResults - callResults.results.length
        });
        
        // Deduplicate by file:line
        const seen = new Set();
        const combined = [];
        
        for (const r of callResults.results) {
            const key = `${r.file}:${r.line}`;
            if (!seen.has(key)) {
                seen.add(key);
                combined.push({ ...r, usageType: 'call' });
            }
        }
        
        for (const r of literalResults.results) {
            const key = `${r.file}:${r.line}`;
            if (!seen.has(key)) {
                seen.add(key);
                combined.push({ ...r, usageType: 'reference' });
            }
        }
        
        return {
            symbolName,
            results: combined.slice(0, maxResults),
            totalUsages: combined.length
        };
    }
    
    /**
     * Search for pattern with surrounding function context
     * Useful for understanding where code appears
     */
    searchWithFunctionContext(pattern, options = {}) {
        const searchResults = typeof pattern === 'string' 
            ? this.searchLiteral(pattern, options)
            : this.searchRegex(pattern, options);
        
        // Enhance results with enclosing function info
        for (const result of searchResults.results) {
            const lines = this.lineIndex.get(result.file);
            if (!lines) continue;
            
            // Look backwards for function definition
            const enclosingFunc = this._findEnclosingFunction(lines, result.line - 1);
            if (enclosingFunc) {
                result.enclosingFunction = enclosingFunc;
            }
        }
        
        return searchResults;
    }
    
    // ============================================================
    // HELPER METHODS
    // ============================================================
    
    /**
     * Find the function that encloses a given line
     */
    _findEnclosingFunction(lines, lineIdx) {
        // Simple heuristic: look backwards for function-like patterns
        const funcPatterns = [
            // C-style function
            /^[\s]*(?:static\s+)?(?:inline\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*\([^)]*\)\s*\{?\s*$/,
            // Python function
            /^[\s]*def\s+(\w+)\s*\(/,
            // JavaScript function
            /^[\s]*(?:async\s+)?function\s+(\w+)\s*\(/,
            // Method
            /^[\s]*(?:public|private|protected)?\s*(?:static\s+)?(\w+)\s+(\w+)\s*\(/
        ];
        
        for (let i = lineIdx; i >= 0 && i > lineIdx - 100; i--) {
            const line = lines[i];
            for (const pattern of funcPatterns) {
                const match = line.match(pattern);
                if (match) {
                    return {
                        name: match[2] || match[1],
                        line: i + 1,
                        signature: line.trim()
                    };
                }
            }
        }
        
        return null;
    }
    
    /**
     * Check if file path matches a pattern
     */
    _matchesFilePattern(filePath, pattern) {
        if (typeof pattern === 'string') {
            return filePath.toLowerCase().includes(pattern.toLowerCase());
        }
        if (pattern instanceof RegExp) {
            return pattern.test(filePath);
        }
        return true;
    }
    
    /**
     * Escape special regex characters in a string
     */
    _escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
    /**
     * Clear the index
     */
    clear() {
        this.files.clear();
        this.lineIndex.clear();
        this.functionCallIndex.clear();
        this.stats = {
            files: 0,
            totalLines: 0,
            totalBytes: 0,
            indexedCalls: 0,
            uniqueFunctions: 0,
            buildTime: 0,
            lastUpdated: null
        };
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return { ...this.stats };
    }
    
    /**
     * Check if a function exists in the call index
     */
    hasFunctionCalls(funcName) {
        return this.functionCallIndex.has(funcName);
    }
    
    /**
     * Get number of call sites for a function
     */
    getCallSiteCount(funcName) {
        return this.functionCallIndex.get(funcName)?.length || 0;
    }
    
    /**
     * Get all indexed function names
     */
    getIndexedFunctions() {
        return Array.from(this.functionCallIndex.keys());
    }
    
    /**
     * Get functions sorted by call count (most called first)
     */
    getMostCalledFunctions(limit = 50) {
        return Array.from(this.functionCallIndex.entries())
            .map(([name, calls]) => ({ name, callCount: calls.length }))
            .sort((a, b) => b.callCount - a.callCount)
            .slice(0, limit);
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    GrepIndex
};
