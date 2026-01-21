/**
 * AstraCode Unified Codebase Index v2.0
 * 
 * Enhanced search quality with:
 * 1. File type filtering (excludes .po, .pot, build files, etc.)
 * 2. Better stop word handling
 * 3. Exact function name matching with high priority
 * 4. Improved keyword extraction from queries
 * 5. Directory/module-aware search
 * 
 * Single source of truth for all code analysis data:
 * - Files and their content
 * - Symbols (functions, classes, variables, etc.)
 * - Call graph relationships
 * - Summaries (function and file level)
 * - Search indexes (inverted index, trigrams)
 */

const { InvertedIndex } = require('./inverted-index');
const { parseFile, extractCalls, findFunctionBodyEnd } = require('./index-module');

// ============================================================
// FILE FILTERING - Exclude non-code files from search
// ============================================================

/**
 * Files that should NEVER be indexed for code search
 * These appear in search results but contain no useful code
 */
const EXCLUDED_EXTENSIONS = new Set([
    // Translation/localization files (THE MAIN PROBLEM)
    'po', 'pot', 'mo',
    
    // Build/config files
    'cmake', 'meson', 'ninja', 'mk',
    
    // Documentation (index separately if needed)
    'md', 'rst', 'txt', 'adoc', 'asciidoc',
    
    // Data files
    'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
    
    // Generated files
    'min.js', 'bundle.js', 'map',
    
    // Lock files
    'lock'
]);

/**
 * File name patterns to exclude
 */
const EXCLUDED_PATTERNS = [
    /^readme/i,
    /^changelog/i,
    /^license/i,
    /^contributing/i,
    /^authors/i,
    /\.min\./,
    /\.bundle\./,
    /\.generated\./,
    /\.d\.ts$/,  // TypeScript declaration files (optional, may want to include)
    /node_modules\//,
    /vendor\//,
    /\.git\//,
    /dist\//,
    /build\//,
    /out\//
];

/**
 * Check if a file should be indexed for code search
 */
function shouldIndexFile(filePath) {
    const fileName = filePath.split('/').pop().toLowerCase();
    const ext = fileName.split('.').pop();
    
    // Check extension
    if (EXCLUDED_EXTENSIONS.has(ext)) {
        return false;
    }
    
    // Check patterns
    for (const pattern of EXCLUDED_PATTERNS) {
        if (pattern.test(filePath)) {
            return false;
        }
    }
    
    return true;
}

/**
 * Check if a file is a source code file (vs. config, data, etc.)
 */
function isSourceCodeFile(filePath, language) {
    const codeLanguages = new Set([
        'c', 'cpp', 'h', 'hpp',
        'java', 'scala', 'kotlin', 'groovy',
        'javascript', 'typescript',
        'python',
        'go', 'rust', 'ruby', 'php',
        'csharp', 'fsharp', 'vb',
        'swift', 'objc',
        'cobol', 'tal', 'tacl',
        'sql', 'plsql', 'tsql',
        'perl', 'lua', 'r',
        'bash', 'sh', 'powershell'
    ]);
    
    return codeLanguages.has(language);
}

// ============================================================
// STOP WORDS - Enhanced filtering for code search
// ============================================================

/**
 * Universal stop words that should NEVER be search results
 * These are language keywords and common terms that match everything
 */
const UNIVERSAL_STOP_WORDS = new Set([
    // Single letters
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    
    // Common English
    'the', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'or', 'and', 'but',
    'not', 'this', 'that', 'these', 'those', 'it', 'its',
    
    // Programming keywords that appear everywhere
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'return', 'goto', 'try', 'catch', 'finally', 'throw',
    'new', 'delete', 'void', 'null', 'true', 'false', 'undefined',
    'var', 'let', 'const', 'static', 'public', 'private', 'protected',
    'class', 'struct', 'enum', 'interface', 'extends', 'implements',
    'function', 'def', 'fn', 'func', 'proc', 'sub',
    'import', 'export', 'require', 'include', 'using', 'from',
    
    // Common variable names
    'tmp', 'temp', 'val', 'value', 'key', 'idx', 'index', 'count',
    'result', 'results', 'data', 'item', 'items', 'list', 'arr',
    'array', 'map', 'set', 'obj', 'object', 'str', 'num', 'err',
    'error', 'msg', 'message', 'buf', 'buffer', 'ptr', 'ref',
    
    // Common function prefixes (when alone)
    'get', 'set', 'is', 'has', 'can', 'init', 'add', 'remove',
    
    // Numbers
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
]);

/**
 * Check if a term is a stop word
 */
function isStopWord(term) {
    return UNIVERSAL_STOP_WORDS.has(term.toLowerCase());
}

// ============================================================
// CONSTANTS
// ============================================================

const CALLABLE_TYPES = new Set([
    'function', 'procedure', 'method', 'subproc', 'constructor',
    'section', 'paragraph', 'program', 'macro', 'define',
    'trigger', 'forward', 'external'
]);

const VARIABLE_TYPES = new Set([
    'variable', 'constant', 'field', 'property', 'parameter',
    'literal', 'define', 'enum_value'
]);

// ============================================================
// CODEBASE INDEX CLASS
// ============================================================

class CodebaseIndex {
    constructor(options = {}) {
        this.options = {
            enableTrigrams: true,
            enableInvertedIndex: true,
            enableCallGraph: true,
            enableSummaries: true,
            filterNonCodeFiles: true,  // NEW: Filter out .po, .md, etc.
            log: null,
            ...options
        };
        
        this.log = typeof this.options.log === 'function' 
            ? this.options.log 
            : (...args) => console.log('[CodebaseIndex]', ...args);
        
        // ========== PRIMARY DATA (Source of Truth) ==========
        this.files = new Map();
        this.symbols = new Map();
        this.variables = new Map();
        this.callGraph = new Map();
        this.reverseCallGraph = new Map();
        this.dependencies = new Map();
        
        // ========== DERIVED INDEXES ==========
        
        // Symbol name index: name (lowercase) -> Set<symbolKey>
        // For fast exact-name lookup
        this.symbolNameIndex = new Map();
        
        // Directory index: dirPath -> Set<filePath>
        this.directoryIndex = new Map();
        
        // Inverted Index for keyword search
        this.invertedIndex = new InvertedIndex({
            enableStemming: true,
            minTermLength: 2,
            maxTermLength: 50
        });
        
        // Trigram indexes
        this.trigrams = {
            symbols: new Map(),
            files: new Map(),
            code: new Map()
        };
        
        // ========== METADATA ==========
        this.stats = {
            files: 0,
            filesSkipped: 0,  // NEW: Track filtered files
            symbols: 0,
            functions: 0,
            variables: 0,
            callGraphEdges: 0,
            trigramTerms: 0,
            invertedTerms: 0,
            summaries: 0,
            buildTime: 0,
            lastUpdated: null
        };
    }
    
    // ============================================================
    // BUILDING THE INDEX
    // ============================================================
    
    async build(contextFiles, options = {}) {
        const { onProgress = null, onChatMessage = null, verbose = false } = options;
        
        const startTime = Date.now();
        this.log(`Building unified codebase index for ${contextFiles.size} files...`);
        
        this.clear();
        
        const reportProgress = (pct, message) => {
            onProgress?.(pct, message, this.getStats());
        };
        
        const chatMessage = (text) => {
            if (verbose && onChatMessage) {
                onChatMessage(text);
            }
        };
        
        chatMessage(`\n**🔧 Building Code Index**\n`);
        chatMessage(`📁 Processing ${contextFiles.size} files...\n\n`);
        
        // Phase 1: Parse files (with filtering)
        await this._buildSymbolIndex(contextFiles, options, reportProgress, verbose, chatMessage);
        
        // Phase 2: Build call graph
        if (this.options.enableCallGraph) {
            await this._buildCallGraph(contextFiles, reportProgress, chatMessage);
        }
        
        // Phase 3: Build trigram indexes
        if (this.options.enableTrigrams) {
            await this._buildTrigramIndexes(reportProgress, chatMessage);
        }
        
        // Phase 4: Build inverted index (only for code files)
        if (this.options.enableInvertedIndex) {
            await this._buildInvertedIndex(reportProgress, chatMessage);
        }
        
        // Phase 5: Build symbol name index
        this._buildSymbolNameIndex();
        
        // Phase 6: Build directory index
        this._buildDirectoryIndex();
        
        this.stats.buildTime = Date.now() - startTime;
        this.stats.lastUpdated = new Date();
        
        reportProgress(80, 'Phases 1-4 complete, building vectors...');
        
        // Note: Completion message is now shown by extension.js after vector embeddings (Phase 5)
        
        this.log(`Phases 1-4 built in ${this.stats.buildTime}ms:`, this.getStats());
        
        return this.getStats();
    }
    
    /**
     * Phase 1: Parse files and extract symbols
     * Now includes file filtering
     */
    async _buildSymbolIndex(contextFiles, options, onProgress, verbose, chatMessage) {
        let processed = 0;
        const total = contextFiles.size;
        
        chatMessage?.(`**Phase 1/5:** Parsing files and extracting symbols...\n`);
        
        for (const [filePath, fileData] of contextFiles) {
            try {
                // Check if file should be indexed
                if (this.options.filterNonCodeFiles && !shouldIndexFile(filePath)) {
                    this.stats.filesSkipped++;
                    processed++;
                    continue;
                }
                
                // Store file
                this.files.set(filePath, {
                    path: filePath,
                    language: fileData.language,
                    content: fileData.content,
                    lineCount: fileData.content.split('\n').length,
                    isSourceCode: isSourceCodeFile(filePath, fileData.language)
                });
                
                // Parse symbols
                const parsed = parseFile(filePath, fileData.content, fileData.language);
                
                for (const symbol of parsed.symbols || []) {
                    const key = `${symbol.name}@${filePath}`;
                    
                    this.symbols.set(key, {
                        ...symbol,
                        file: filePath,
                        key: key
                    });
                    
                    if (VARIABLE_TYPES.has(symbol.type)) {
                        this.variables.set(key, {
                            name: symbol.name,
                            dataType: symbol.dataType || symbol.type,
                            file: filePath,
                            line: symbol.line,
                            scope: symbol.scope || 'global'
                        });
                        this.stats.variables++;
                    }
                    
                    if (CALLABLE_TYPES.has(symbol.type)) {
                        this.stats.functions++;
                        if (symbol.summary) {
                            this.stats.summaries++;
                        }
                    }
                    
                    this.stats.symbols++;
                }
                
                this.stats.files++;
                processed++;
                
                const progress = Math.floor((processed / total) * 50);
                onProgress?.(progress, `Parsing files... ${processed}/${total}`);
                
                if (processed % 10 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
                
            } catch (error) {
                this.log(`Error parsing ${filePath}: ${error.message}`);
            }
        }
        
        chatMessage?.(`   ✓ Parsed ${this.stats.files} files, skipped ${this.stats.filesSkipped}, found ${this.stats.symbols} symbols\n`);
        this.log(`Symbol extraction complete: ${this.stats.files} files, ${this.stats.symbols} symbols`);
    }
    
    /**
     * Phase 2: Build call graph
     */
    async _buildCallGraph(contextFiles, onProgress, chatMessage) {
        onProgress?.(50, 'Building call graph...');
        chatMessage?.(`**Phase 2/5:** Building call graph...\n`);
        
        for (const [filePath, fileData] of contextFiles) {
            const fileInfo = this.files.get(filePath);
            if (!fileInfo) continue;
            
            const lines = fileData.content.split('\n');
            
            for (const [key, symbol] of this.symbols) {
                if (symbol.file !== filePath) continue;
                if (!CALLABLE_TYPES.has(symbol.type)) continue;
                
                const startLine = symbol.line - 1;
                const endLine = symbol.endLine 
                    ? symbol.endLine - 1 
                    : findFunctionBodyEnd(lines, startLine, fileData.language);
                
                const bodyLines = lines.slice(startLine, Math.min(endLine + 1, lines.length));
                const bodyCode = bodyLines.join('\n');
                
                const calls = extractCalls(bodyCode, fileData.language);
                
                if (calls && calls.size > 0) {
                    calls.delete(symbol.name);
                    
                    if (calls.size > 0) {
                        this.callGraph.set(symbol.name, calls);
                        
                        for (const called of calls) {
                            if (!this.reverseCallGraph.has(called)) {
                                this.reverseCallGraph.set(called, new Set());
                            }
                            this.reverseCallGraph.get(called).add(symbol.name);
                        }
                        
                        this.stats.callGraphEdges += calls.size;
                    }
                }
            }
        }
        
        onProgress?.(60, `Call graph built: ${this.stats.callGraphEdges} edges`);
        chatMessage?.(`   ✓ Built call graph with ${this.stats.callGraphEdges} edges\n`);
    }
    
    /**
     * Phase 3: Build trigram indexes
     */
    async _buildTrigramIndexes(onProgress, chatMessage) {
        onProgress?.(60, 'Building trigram indexes...');
        chatMessage?.(`**Phase 3/5:** Building trigram indexes...\n`);
        
        // Symbol name trigrams
        for (const [key, symbol] of this.symbols) {
            const nameLower = symbol.name.toLowerCase();
            for (const tri of this._extractTrigrams(nameLower)) {
                if (!this.trigrams.symbols.has(tri)) {
                    this.trigrams.symbols.set(tri, new Set());
                }
                this.trigrams.symbols.get(tri).add(key);
            }
        }
        
        // File name trigrams (only for indexed files)
        for (const [filePath] of this.files) {
            const fileName = filePath.split('/').pop().toLowerCase();
            for (const tri of this._extractTrigrams(fileName)) {
                if (!this.trigrams.files.has(tri)) {
                    this.trigrams.files.set(tri, new Set());
                }
                this.trigrams.files.get(tri).add(filePath);
            }
        }
        
        // Code content trigrams (only for source code files)
        for (const [filePath, fileInfo] of this.files) {
            if (!fileInfo.isSourceCode) continue;  // Skip non-code files
            
            const lines = fileInfo.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].toLowerCase();
                if (line.length < 3 || line.length > 500) continue;
                
                for (const tri of this._extractTrigrams(line)) {
                    if (!this.trigrams.code.has(tri)) {
                        this.trigrams.code.set(tri, new Set());
                    }
                    this.trigrams.code.get(tri).add(`${filePath}:${i + 1}`);
                }
            }
        }
        
        this.stats.trigramTerms = this.trigrams.symbols.size + 
                                   this.trigrams.files.size + 
                                   this.trigrams.code.size;
        
        onProgress?.(75, `Trigram indexes built: ${this.stats.trigramTerms} terms`);
        chatMessage?.(`   ✓ Built ${this.stats.trigramTerms} trigram terms\n`);
    }
    
    /**
     * Phase 4: Build inverted index
     */
    async _buildInvertedIndex(onProgress, chatMessage) {
        onProgress?.(75, 'Building inverted index...');
        chatMessage?.(`**Phase 4/5:** Building inverted index...\n`);
        
        // Index file contents (only source code files)
        for (const [filePath, fileInfo] of this.files) {
            if (!fileInfo.isSourceCode) continue;  // Skip non-code files
            
            this.invertedIndex.addDocument(
                `file:${filePath}`,
                fileInfo.content,
                'file',
                { path: filePath, name: filePath.split('/').pop() }
            );
        }
        
        // Index symbols
        for (const [key, symbol] of this.symbols) {
            const searchText = [
                symbol.name,
                symbol.signature || '',
                symbol.type,
                symbol.summary || ''
            ].filter(Boolean).join(' ');
            
            this.invertedIndex.addDocument(
                `symbol:${key}`,
                searchText,
                'symbol',
                { 
                    key: key,
                    name: symbol.name, 
                    file: symbol.file,
                    type: symbol.type
                }
            );
            
            if (symbol.summary && CALLABLE_TYPES.has(symbol.type)) {
                this.invertedIndex.addDocument(
                    `summary:${key}`,
                    symbol.summary,
                    'summary',
                    {
                        symbolKey: key,
                        name: symbol.name,
                        file: symbol.file
                    }
                );
            }
        }
        
        this.stats.invertedTerms = this.invertedIndex.index.size;
        
        onProgress?.(100, `Inverted index built: ${this.stats.invertedTerms} terms`);
        chatMessage?.(`   ✓ Built inverted index with ${this.stats.invertedTerms} searchable terms\n`);
    }
    
    /**
     * Build symbol name index for fast exact-match lookup
     */
    _buildSymbolNameIndex() {
        this.symbolNameIndex.clear();
        
        for (const [key, symbol] of this.symbols) {
            const nameLower = symbol.name.toLowerCase();
            if (!this.symbolNameIndex.has(nameLower)) {
                this.symbolNameIndex.set(nameLower, new Set());
            }
            this.symbolNameIndex.get(nameLower).add(key);
        }
    }
    
    /**
     * Build directory index
     */
    _buildDirectoryIndex() {
        this.directoryIndex.clear();
        
        for (const [filePath] of this.files) {
            const parts = filePath.split('/');
            for (let i = 1; i < parts.length; i++) {
                const dirPath = parts.slice(0, i).join('/');
                if (!this.directoryIndex.has(dirPath)) {
                    this.directoryIndex.set(dirPath, new Set());
                }
                this.directoryIndex.get(dirPath).add(filePath);
            }
        }
    }
    
    // ============================================================
    // ENHANCED SEARCH METHODS
    // ============================================================
    
    /**
     * Unified search with improved quality
     */
    search(query, options = {}) {
        const {
            maxResults = 100,
            includeCodeBlocks = true,
            searchTypes = ['all']
        } = options;
        
        const startTime = Date.now();
        const results = {
            symbols: [],
            files: [],
            codeBlocks: [],
            stats: {
                exact_match: 0,
                pattern_match: 0,
                trigram_code: 0,
                inverted_index: 0,
                summary_search: 0,
                file_keyword: 0,
                directory_match: 0,
                total: 0,
                elapsed: 0
            }
        };
        
        const seenSymbols = new Set();
        const seenFiles = new Set();
        
        // Extract and clean query terms
        const queryTerms = this._extractSearchTerms(query);
        const cleanedTerms = queryTerms.filter(t => !isStopWord(t));
        
        // If all terms are stop words, use original terms but lower priority
        const searchTerms = cleanedTerms.length > 0 ? cleanedTerms : queryTerms;
        
        // ENHANCEMENT: Expand query with compound terms (e.g., "index" + "build" → "index_build")
        const expandedTerms = this._expandQueryTerms(query, searchTerms);
        const allSearchTerms = [...new Set([...searchTerms, ...expandedTerms])];
        
        this.log(`Search: "${query}" -> terms: [${searchTerms.join(', ')}]`);
        if (expandedTerms.length > 0) {
            this.log(`Search: Expanded terms: [${expandedTerms.join(', ')}]`);
        }
        
        // ENHANCEMENT: Find files whose NAME IS the concept (highest priority)
        // For "how are indexes built", find index.c, indexcmds.c BEFORE costsize.c
        if (searchTypes.includes('all') || searchTypes.includes('files')) {
            const conceptFiles = this._findConceptFiles(searchTerms);
            if (conceptFiles.length > 0) {
                this.log(`Search: Found ${conceptFiles.length} concept files: ${conceptFiles.slice(0, 5).map(f => f.name).join(', ')}`);
            }
            for (const fileMatch of conceptFiles) {
                if (!seenFiles.has(fileMatch.path)) {
                    seenFiles.add(fileMatch.path);
                    results.files.push(fileMatch);
                    results.stats.file_keyword++;
                    
                    // Add symbols from concept files with very high priority
                    const fileSymbols = this._getSymbolsInFile(fileMatch.path, 30);
                    for (const sym of fileSymbols) {
                        if (!seenSymbols.has(sym.key)) {
                            seenSymbols.add(sym.key);
                            results.symbols.push({
                                ...sym,
                                matchSource: 'concept_file',
                                matchScore: 95
                            });
                            results.stats.exact_match++;
                        }
                    }
                }
            }
        }
        
        // 0. HIGHEST PRIORITY: Exact function name match (including expanded terms)
        if (searchTypes.includes('all') || searchTypes.includes('symbols')) {
            for (const term of allSearchTerms) {
                const exactMatches = this.symbolNameIndex.get(term.toLowerCase());
                if (exactMatches) {
                    for (const key of exactMatches) {
                        if (!seenSymbols.has(key)) {
                            const symbol = this.symbols.get(key);
                            if (symbol) {
                                seenSymbols.add(key);
                                const isExpanded = expandedTerms.includes(term);
                                results.symbols.push({
                                    ...symbol,
                                    matchSource: isExpanded ? 'expanded_match' : 'exact_match',
                                    matchScore: isExpanded ? 98 : 100
                                });
                                results.stats.exact_match++;
                            }
                        }
                    }
                }
            }
        }
        
        // 1. Pattern search on symbol names (including expanded terms)
        if (searchTypes.includes('all') || searchTypes.includes('symbols')) {
            for (const term of allSearchTerms) {
                if (term.length >= 3) {  // Skip very short terms for pattern matching
                    for (const symbol of this._findSymbolsByPattern(term, 20)) {
                        if (!seenSymbols.has(symbol.key)) {
                            seenSymbols.add(symbol.key);
                            results.symbols.push({
                                ...symbol,
                                matchSource: 'pattern_match',
                                matchScore: symbol.matchScore || 80
                            });
                            results.stats.pattern_match++;
                        }
                    }
                }
            }
        }
        
        // 2. Directory/module search
        if (searchTypes.includes('all') || searchTypes.includes('files')) {
            for (const term of searchTerms) {
                // Check if term matches a directory name
                for (const [dirPath, files] of this.directoryIndex) {
                    const dirName = dirPath.split('/').pop().toLowerCase();
                    if (dirName.includes(term.toLowerCase()) || term.toLowerCase().includes(dirName)) {
                        for (const filePath of files) {
                            if (!seenFiles.has(filePath)) {
                                seenFiles.add(filePath);
                                results.files.push({
                                    path: filePath,
                                    name: filePath.split('/').pop(),
                                    matchSource: 'directory_match',
                                    matchScore: 85,
                                    directory: dirPath
                                });
                                results.stats.directory_match++;
                                
                                // Add top symbols from this file
                                const fileSymbols = this._getSymbolsInFile(filePath, 5);
                                for (const sym of fileSymbols) {
                                    if (!seenSymbols.has(sym.key)) {
                                        seenSymbols.add(sym.key);
                                        results.symbols.push({
                                            ...sym,
                                            matchSource: 'directory_match',
                                            matchScore: 75
                                        });
                                        results.stats.directory_match++;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // 3. Trigram code search
        if (searchTypes.includes('all') || searchTypes.includes('code')) {
            for (const term of searchTerms) {
                if (term.length >= 3) {
                    const codeMatches = this._findTextInCode(term, 20);
                    for (const match of codeMatches) {
                        const nearbySymbols = this._getSymbolsNearLine(match.file, match.line, 50);
                        for (const sym of nearbySymbols) {
                            if (!seenSymbols.has(sym.key)) {
                                seenSymbols.add(sym.key);
                                results.symbols.push({
                                    ...sym,
                                    matchSource: 'trigram_code',
                                    matchScore: 70,
                                    matchContext: match.context
                                });
                                results.stats.trigram_code++;
                            }
                        }
                    }
                }
            }
        }
        
        // 4. Inverted index search
        if (this.invertedIndex && this.invertedIndex.index.size > 0) {
            // Search symbols
            if (searchTypes.includes('all') || searchTypes.includes('symbols')) {
                const keywordSymbols = this.invertedIndex.searchSymbols(query, { maxResults: 30 });
                for (const result of keywordSymbols) {
                    const symbolKey = result.key;
                    if (symbolKey && !seenSymbols.has(symbolKey)) {
                        const symbol = this.symbols.get(symbolKey);
                        if (symbol) {
                            seenSymbols.add(symbolKey);
                            results.symbols.push({
                                ...symbol,
                                matchSource: 'inverted_index',
                                matchScore: (result.score || 0.5) * 80,
                                matchedTerms: result.matchedTerms
                            });
                            results.stats.inverted_index++;
                        }
                    }
                }
            }
            
            // Search summaries
            if (searchTypes.includes('all') || searchTypes.includes('summaries')) {
                const summaryResults = this.invertedIndex.searchSummaries(query, { maxResults: 20 });
                for (const result of summaryResults) {
                    const symbolKey = result.symbolKey;
                    if (symbolKey && !seenSymbols.has(symbolKey)) {
                        const symbol = this.symbols.get(symbolKey);
                        if (symbol) {
                            seenSymbols.add(symbolKey);
                            results.symbols.push({
                                ...symbol,
                                matchSource: 'summary_search',
                                matchScore: (result.score || 0.4) * 75,
                                matchedTerms: result.matchedTerms
                            });
                            results.stats.summary_search++;
                        }
                    }
                }
            }
            
            // Search files
            if (searchTypes.includes('all') || searchTypes.includes('files')) {
                const fileResults = this.invertedIndex.searchFiles(query, { maxResults: 15 });
                for (const result of fileResults) {
                    const filePath = result.path;
                    if (filePath && !seenFiles.has(filePath)) {
                        seenFiles.add(filePath);
                        results.files.push({
                            path: filePath,
                            name: filePath.split('/').pop(),
                            matchSource: 'file_keyword',
                            matchScore: (result.score || 0.3) * 60
                        });
                        results.stats.file_keyword++;
                        
                        const fileSymbols = this._getSymbolsInFile(filePath, 5);
                        for (const sym of fileSymbols) {
                            if (!seenSymbols.has(sym.key)) {
                                seenSymbols.add(sym.key);
                                results.symbols.push({
                                    ...sym,
                                    matchSource: 'file_keyword',
                                    matchScore: (result.score || 0.3) * 50
                                });
                                results.stats.file_keyword++;
                            }
                        }
                    }
                }
            }
        }
        
        // Sort by score
        results.symbols.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
        results.symbols = results.symbols.slice(0, maxResults);
        
        // Get code blocks
        if (includeCodeBlocks) {
            const seen = new Set();
            for (const sym of results.symbols.slice(0, 20)) {
                const blockKey = `${sym.file}:${Math.floor(sym.line / 15)}`;
                if (!seen.has(blockKey)) {
                    seen.add(blockKey);
                    const block = this.getCodeBlock(sym);
                    if (block) {
                        results.codeBlocks.push({
                            symbol: sym.name,
                            type: sym.type,
                            ...block
                        });
                    }
                }
            }
        }
        
        results.stats.total = results.symbols.length;
        results.stats.elapsed = Date.now() - startTime;
        
        return results;
    }
    
    // ============================================================
    // LOOKUP METHODS
    // ============================================================
    
    getSymbol(key) {
        return this.symbols.get(key) || null;
    }
    
    getSymbolsByName(name) {
        const nameLower = name.toLowerCase();
        const keys = this.symbolNameIndex.get(nameLower);
        if (!keys) return [];
        return Array.from(keys).map(key => this.symbols.get(key)).filter(Boolean);
    }
    
    getCallers(funcName) {
        const callers = this.reverseCallGraph.get(funcName);
        return callers ? Array.from(callers) : [];
    }
    
    getCallees(funcName) {
        const callees = this.callGraph.get(funcName);
        return callees ? Array.from(callees) : [];
    }
    
    getCodeBlock(symbol, options = {}) {
        const { contextBefore = 5, contextAfter = 40 } = options;
        
        const fileInfo = this.files.get(symbol.file);
        if (!fileInfo) return null;
        
        const lines = fileInfo.content.split('\n');
        const startLine = Math.max(0, symbol.line - 1 - contextBefore);
        const endLine = Math.min(lines.length, (symbol.endLine || symbol.line) + contextAfter);
        
        return {
            file: symbol.file,
            startLine: startLine + 1,
            endLine: endLine,
            code: lines.slice(startLine, endLine).join('\n')
        };
    }
    
    getFileContent(filePath) {
        const fileInfo = this.files.get(filePath);
        return fileInfo ? fileInfo.content : null;
    }
    
    getStats() {
        return { ...this.stats };
    }
    
    // ============================================================
    // PRIVATE HELPER METHODS
    // ============================================================
    
    _getSymbolsInFile(filePath, limit = 100) {
        const results = [];
        for (const [key, symbol] of this.symbols) {
            if (symbol.file === filePath) {
                results.push(symbol);
                if (results.length >= limit) break;
            }
        }
        return results;
    }
    
    _getSymbolsNearLine(filePath, line, range) {
        const results = [];
        for (const [key, symbol] of this.symbols) {
            if (symbol.file === filePath && Math.abs(symbol.line - line) <= range) {
                results.push(symbol);
            }
        }
        return results;
    }
    
    _findSymbolsByPattern(pattern, maxResults = 50) {
        const patternLower = pattern.toLowerCase();
        const trigrams = this._extractTrigrams(patternLower);
        
        if (trigrams.length === 0) {
            return this._findSymbolsByPatternFallback(patternLower, maxResults);
        }
        
        let candidates = null;
        for (const tri of trigrams) {
            const matches = this.trigrams.symbols.get(tri);
            if (!matches || matches.size === 0) return [];
            candidates = candidates === null 
                ? new Set(matches) 
                : new Set([...candidates].filter(k => matches.has(k)));
            if (candidates.size === 0) return [];
        }
        
        const results = [];
        for (const key of candidates) {
            const symbol = this.symbols.get(key);
            if (!symbol) continue;
            const score = this._fuzzyMatchScore(patternLower, symbol.name.toLowerCase());
            if (score >= 30) {
                results.push({ ...symbol, matchScore: score });
            }
        }
        
        return results.sort((a, b) => b.matchScore - a.matchScore).slice(0, maxResults);
    }
    
    _findSymbolsByPatternFallback(pattern, maxResults) {
        const results = [];
        for (const [key, symbol] of this.symbols) {
            if (symbol.name.toLowerCase().includes(pattern)) {
                results.push({ ...symbol, matchScore: 50 });
            }
        }
        return results.slice(0, maxResults);
    }
    
    _findTextInCode(text, maxResults = 30) {
        const textLower = text.toLowerCase();
        const trigrams = this._extractTrigrams(textLower);
        
        if (trigrams.length === 0 || this.trigrams.code.size === 0) return [];
        
        let candidates = null;
        for (const tri of trigrams) {
            const matches = this.trigrams.code.get(tri);
            if (!matches) return [];
            candidates = candidates === null 
                ? new Set(matches) 
                : new Set([...candidates].filter(k => matches.has(k)));
            if (candidates.size === 0) return [];
        }
        
        const results = [];
        for (const loc of candidates) {
            const [filePath, lineStr] = loc.split(':');
            const line = parseInt(lineStr, 10);
            
            const fileInfo = this.files.get(filePath);
            if (!fileInfo) continue;
            
            const lines = fileInfo.content.split('\n');
            const lineContent = lines[line - 1] || '';
            
            if (lineContent.toLowerCase().includes(textLower)) {
                results.push({
                    file: filePath,
                    line: line,
                    context: lineContent.trim().substring(0, 200)
                });
            }
            
            if (results.length >= maxResults) break;
        }
        
        return results;
    }
    
    _extractTrigrams(text) {
        const trigrams = [];
        const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (let i = 0; i <= normalized.length - 3; i++) {
            trigrams.push(normalized.substring(i, i + 3));
        }
        return trigrams;
    }
    
    /**
     * Enhanced term extraction - handles underscores, camelCase, etc.
     */
    _extractSearchTerms(query) {
        // First, try to extract complete identifiers (function names with underscores)
        const identifiers = query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
        
        // Also split on spaces and common separators
        const words = query
            .toLowerCase()
            .split(/[\s,;:]+/)
            .map(t => t.replace(/[^a-z0-9_]/g, ''))
            .filter(t => t.length >= 2);
        
        // Combine and deduplicate
        const allTerms = new Set([
            ...identifiers.map(id => id.toLowerCase()),
            ...words
        ]);
        
        // Helper to get singular form
        const singularize = (word) => {
            if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
            if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
            if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
            return null; // Return null if no change
        };
        
        // Add singular forms of plural words (indexes -> index)
        for (const term of Array.from(allTerms)) {
            const singular = singularize(term);
            if (singular && singular.length >= 3) {
                allTerms.add(singular);
            }
        }
        
        // Split camelCase terms
        for (const term of Array.from(allTerms)) {
            const camelParts = term.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
            if (camelParts.length > 1) {
                camelParts.forEach(p => {
                    if (p.length >= 2) allTerms.add(p);
                });
            }
            
            // Split snake_case
            const snakeParts = term.split('_');
            if (snakeParts.length > 1) {
                snakeParts.forEach(p => {
                    if (p.length >= 2) allTerms.add(p);
                });
            }
        }
        
        return Array.from(allTerms).filter(t => t.length >= 2);
    }
    
    _fuzzyMatchScore(pattern, text) {
        if (text === pattern) return 100;
        if (text.startsWith(pattern)) return 90;
        if (text.includes(pattern)) return 70;
        
        const words = text.split(/[_\s]+/);
        for (const word of words) {
            if (word === pattern) return 85;
            if (word.startsWith(pattern)) return 75;
        }
        
        return 0;
    }
    
    /**
     * ENHANCEMENT: Expand query terms to find compound function names
     * E.g., "index" + "build" → ["index_build", "build_index"]
     * Detects action verbs dynamically from the query
     */
    _expandQueryTerms(query, searchTerms) {
        const expanded = [];
        const q = query.toLowerCase();
        
        // Helper to get singular form of a word
        const singularize = (word) => {
            if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
            if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
            if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
            return word;
        };
        
        // Common action verb patterns (these are programming-universal, not domain-specific)
        const actionPatterns = [
            /\b(built|build|building)\b/,
            /\b(created?|creating|creation)\b/,
            /\b(initialized?|initializing|init)\b/,
            /\b(made|make|making)\b/,
            /\b(constructed?|constructing)\b/,
            /\b(generated?|generating)\b/,
            /\b(processed?|processing)\b/,
            /\b(handled?|handling)\b/,
            /\b(scanned?|scanning)\b/,
            /\b(performed?|performing)\b/,
            /\b(executed?|executing)\b/,
            /\b(called?|calling)\b/,
            /\b(inserted?|inserting)\b/,
            /\b(deleted?|deleting)\b/,
            /\b(updated?|updating)\b/
        ];
        
        // Find action verbs in query
        const foundActions = [];
        for (const pattern of actionPatterns) {
            const match = q.match(pattern);
            if (match) {
                // Normalize to base form
                let base = match[1].replace(/ed$|ing$|ion$|e$/, '');
                if (base.length < 3) base = match[1].replace(/ed$|ing$/, '');
                if (base.length >= 3) foundActions.push(base);
            }
        }
        
        // Create compound terms: concept + action and action + concept
        for (const term of searchTerms) {
            if (term.length < 3) continue;
            
            // Use singular form for compound names (index_build not indexes_build)
            const singularTerm = singularize(term);
            
            for (const action of foundActions) {
                if (action === term || action === singularTerm) continue;
                
                // Both orderings with singular form
                expanded.push(`${singularTerm}_${action}`);
                expanded.push(`${action}_${singularTerm}`);
            }
        }
        
        return [...new Set(expanded)];
    }
    
    /**
     * ENHANCEMENT: Find files whose NAME matches the query concept
     * For "how are indexes built", prioritize index.c over costsize.c
     */
    _findConceptFiles(searchTerms) {
        const conceptFiles = [];
        
        // Helper to get singular form of a word
        const singularize = (word) => {
            if (word.endsWith('ies')) return word.slice(0, -3) + 'y';  // queries -> query
            if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);  // indexes -> index
            if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);   // builds -> build
            return word;
        };
        
        for (const [filePath, fileInfo] of this.files) {
            const fileName = filePath.split('/').pop().toLowerCase();
            const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
            
            for (const term of searchTerms) {
                if (term.length < 3) continue;
                
                // Also try singular form
                const singularTerm = singularize(term);
                const termsToMatch = term === singularTerm ? [term] : [term, singularTerm];
                
                for (const t of termsToMatch) {
                    // Exact match: index.c for "index"
                    if (fileNameNoExt === t || fileNameNoExt === t + 's') {
                        conceptFiles.push({
                            path: filePath,
                            name: fileName,
                            matchSource: 'concept_exact',
                            matchScore: 100,
                            matchReason: `filename "${fileName}" matches concept "${t}"`
                        });
                        break; // Don't add duplicate
                    }
                    // Primary prefix: indexcmds.c starts with "index"
                    else if (fileNameNoExt.startsWith(t) && fileNameNoExt.length < t.length + 8) {
                        conceptFiles.push({
                            path: filePath,
                            name: fileName,
                            matchSource: 'concept_prefix',
                            matchScore: 90,
                            matchReason: `filename "${fileName}" starts with concept "${t}"`
                        });
                        break; // Don't add duplicate
                    }
                }
            }
        }
        
        // Sort by score descending and dedupe
        const seen = new Set();
        const dedupedFiles = conceptFiles
            .sort((a, b) => b.matchScore - a.matchScore)
            .filter(f => {
                if (seen.has(f.path)) return false;
                seen.add(f.path);
                return true;
            });
        
        return dedupedFiles;
    }
    
    clear() {
        this.files.clear();
        this.symbols.clear();
        this.variables.clear();
        this.callGraph.clear();
        this.reverseCallGraph.clear();
        this.dependencies.clear();
        this.symbolNameIndex.clear();
        this.directoryIndex.clear();
        
        this.trigrams.symbols.clear();
        this.trigrams.files.clear();
        this.trigrams.code.clear();
        
        if (this.invertedIndex) {
            this.invertedIndex.clear();
        }
        
        this.stats = {
            files: 0,
            filesSkipped: 0,
            symbols: 0,
            functions: 0,
            variables: 0,
            callGraphEdges: 0,
            trigramTerms: 0,
            invertedTerms: 0,
            summaries: 0,
            buildTime: 0,
            lastUpdated: null
        };
    }
    
    export() {
        return {
            version: '2.0',
            stats: this.stats,
            files: Array.from(this.files.entries()),
            symbols: Array.from(this.symbols.entries()),
            variables: Array.from(this.variables.entries()),
            callGraph: Array.from(this.callGraph.entries()).map(([k, v]) => [k, Array.from(v)]),
            reverseCallGraph: Array.from(this.reverseCallGraph.entries()).map(([k, v]) => [k, Array.from(v)]),
            invertedIndex: this.invertedIndex?.export?.() || null
        };
    }
    
    import(data) {
        if (!data.version) {
            throw new Error(`Unsupported index version`);
        }
        
        this.clear();
        
        this.stats = data.stats;
        this.files = new Map(data.files);
        this.symbols = new Map(data.symbols);
        this.variables = new Map(data.variables);
        this.callGraph = new Map(data.callGraph.map(([k, v]) => [k, new Set(v)]));
        this.reverseCallGraph = new Map(data.reverseCallGraph.map(([k, v]) => [k, new Set(v)]));
        
        if (data.invertedIndex && this.invertedIndex?.import) {
            this.invertedIndex.import(data.invertedIndex);
        }
        
        this._buildTrigramIndexes();
        this._buildSymbolNameIndex();
        this._buildDirectoryIndex();
    }
}

module.exports = { 
    CodebaseIndex, 
    CALLABLE_TYPES, 
    VARIABLE_TYPES,
    shouldIndexFile,
    isSourceCodeFile,
    isStopWord,
    EXCLUDED_EXTENSIONS,
    UNIVERSAL_STOP_WORDS
};
