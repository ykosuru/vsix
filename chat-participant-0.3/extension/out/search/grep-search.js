/**
 * GrepIndex - Fast literal and regex search with function call tracking
 * 
 * Key Features:
 * - Literal string search (case-sensitive/insensitive)
 * - Regex pattern search
 * - Pre-indexed function call sites for O(1) "who calls X?" lookup
 * - Context lines around matches
 * - File pattern filtering
 */

const config = require('../config.json');

// Keywords to exclude from function call indexing
const EXCLUDE_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof',
    'typeof', 'instanceof', 'new', 'delete', 'throw', 'await',
    'assert', 'defined', 'elif', 'ifdef', 'ifndef', 'endif',
    'NULL', 'TRUE', 'FALSE', 'true', 'false'
]);

// Patterns to match function calls
const CALL_PATTERNS = [
    /\b([a-zA-Z_]\w*)\s*\(/g,           // func(
    /\.([a-zA-Z_]\w*)\s*\(/g,            // obj.method(
    /->([a-zA-Z_]\w*)\s*\(/g,            // ptr->method(
    /::([a-zA-Z_]\w*)\s*\(/g,            // Class::method(
];

// Patterns to detect function definitions (not calls)
const FUNC_DEF_PATTERNS = [
    // C-style function
    /^[\s]*(?:static\s+)?(?:inline\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*\([^)]*\)\s*\{?\s*$/,
    // Python function
    /^[\s]*def\s+(\w+)\s*\(/,
    // JavaScript function
    /^[\s]*(?:async\s+)?function\s+(\w+)\s*\(/,
    // Method
    /^[\s]*(?:public|private|protected)?\s*(?:static\s+)?(\w+)\s+(\w+)\s*\(/
];

class GrepIndex {
    constructor(options = {}) {
        this.options = {
            maxFileSize: config.index.maxFileSize,
            maxResults: config.index.maxResults,
            contextLines: config.index.contextLines,
            buildCallIndex: config.index.buildCallIndex,
            excludePatterns: config.index.excludePatterns.map(p => new RegExp(p)),
            ...options
        };
        
        this.files = new Map();              // filePath -> content
        this.lineIndex = new Map();          // filePath -> [line1, line2, ...]
        this.functionCallIndex = new Map();  // funcName -> [{file, line, column, context}]
        
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
            if (this._shouldExclude(filePath)) continue;
            if (!fileInfo.content || fileInfo.content.length > this.options.maxFileSize) continue;
            
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
     * Build index of function call sites for O(1) lookup
     */
    _buildFunctionCallIndex(log = console.log) {
        let totalCalls = 0;
        
        for (const [filePath, content] of this.files) {
            const lines = this.lineIndex.get(filePath);
            
            for (const pattern of CALL_PATTERNS) {
                pattern.lastIndex = 0;
                let match;
                
                while ((match = pattern.exec(content)) !== null) {
                    const funcName = match[1];
                    
                    if (EXCLUDE_KEYWORDS.has(funcName) || funcName.length < 2) continue;
                    
                    const beforeMatch = content.substring(0, match.index);
                    const lineNum = beforeMatch.split('\n').length;
                    const lastNewline = beforeMatch.lastIndexOf('\n');
                    const column = match.index - lastNewline;
                    const lineIdx = lineNum - 1;
                    
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
     * Search for literal string
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
            if (filePattern && !this._matchesFilePattern(filePath, filePattern)) continue;
            
            const searchContent = caseSensitive ? content : content.toLowerCase();
            const lines = this.lineIndex.get(filePath);
            
            let pos = 0;
            while ((pos = searchContent.indexOf(searchPattern, pos)) !== -1) {
                const beforeMatch = content.substring(0, pos);
                const lineNum = beforeMatch.split('\n').length;
                const lineIdx = lineNum - 1;
                const lastNewline = beforeMatch.lastIndexOf('\n');
                const column = pos - lastNewline;
                
                // Check whole word boundary
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
     */
    searchFunctionCalls(funcName, options = {}) {
        const {
            includeDefinitions = false,
            maxResults = this.options.maxResults,
            filePattern = null
        } = options;
        
        let callSites = this.functionCallIndex.get(funcName) || [];
        
        if (filePattern) {
            callSites = callSites.filter(site => 
                this._matchesFilePattern(site.file, filePattern)
            );
        }
        
        // Filter out definitions
        if (!includeDefinitions) {
            callSites = callSites.filter(site => {
                const line = site.context;
                const defPatterns = [
                    new RegExp(`^\\s*(?:static\\s+)?(?:inline\\s+)?(?:\\w+\\s+\\*?\\s*)${this._escapeRegex(funcName)}\\s*\\(`),
                    new RegExp(`^\\s*\\w+[\\s\\*]+${this._escapeRegex(funcName)}\\s*\\([^)]*\\)\\s*;`),
                    new RegExp(`^\\s*(?:void|int|char|bool|float|double|\\w+)\\s+${this._escapeRegex(funcName)}\\s*\\(`)
                ];
                return !defPatterns.some(p => p.test(line));
            });
        }
        
        const results = callSites.slice(0, maxResults).map(site => {
            const lines = this.lineIndex.get(site.file);
            const lineIdx = site.line - 1;
            
            return {
                ...site,
                matchLine: lines[lineIdx] || '',
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
     */
    searchSymbolUsages(symbolName, options = {}) {
        const { maxResults = this.options.maxResults } = options;
        
        const callResults = this.searchFunctionCalls(symbolName, options);
        const literalResults = this.searchLiteral(symbolName, {
            ...options,
            wholeWord: true,
            maxResults: maxResults - callResults.results.length
        });
        
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
     * Search with enclosing function context
     */
    searchWithFunctionContext(pattern, options = {}) {
        const searchResults = typeof pattern === 'string' 
            ? this.searchLiteral(pattern, options)
            : this.searchRegex(pattern, options);
        
        for (const result of searchResults.results) {
            const lines = this.lineIndex.get(result.file);
            if (!lines) continue;
            
            const enclosingFunc = this._findEnclosingFunction(lines, result.line - 1);
            if (enclosingFunc) {
                result.enclosingFunction = enclosingFunc;
            }
        }
        
        return searchResults;
    }
    
    /**
     * Find the function that encloses a given line
     */
    _findEnclosingFunction(lines, lineIdx) {
        for (let i = lineIdx; i >= 0 && i > lineIdx - 100; i--) {
            const line = lines[i];
            for (const pattern of FUNC_DEF_PATTERNS) {
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
    
    _shouldExclude(filePath) {
        return this.options.excludePatterns.some(p => p.test(filePath));
    }
    
    _matchesFilePattern(filePath, pattern) {
        if (typeof pattern === 'string') {
            return filePath.toLowerCase().includes(pattern.toLowerCase());
        }
        if (pattern instanceof RegExp) {
            return pattern.test(filePath);
        }
        return true;
    }
    
    _escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
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
    
    getStats() {
        return { ...this.stats };
    }
    
    hasFunctionCalls(funcName) {
        return this.functionCallIndex.has(funcName);
    }
    
    getCallSiteCount(funcName) {
        return this.functionCallIndex.get(funcName)?.length || 0;
    }
    
    getIndexedFunctions() {
        return Array.from(this.functionCallIndex.keys());
    }
    
    getMostCalledFunctions(limit = 50) {
        return Array.from(this.functionCallIndex.entries())
            .map(([name, calls]) => ({ name, callCount: calls.length }))
            .sort((a, b) => b.callCount - a.callCount)
            .slice(0, limit);
    }
}

module.exports = { GrepIndex };
