/**
 * AstraCode Search Module v8.0 - Unified Search Architecture
 * 
 * DESIGN PRINCIPLE: Always gather broad context, then enrich with specialized data.
 * 
 * Previous versions routed queries to different handlers that could return empty
 * results. This version:
 * 
 * 1. ALWAYS runs base context search (symbols, code blocks, file matches)
 * 2. ENRICHES with specialized data when available (call graph, grep)
 * 3. Uses query classification only to guide LLM prompt, not gate context
 * 
 * This ensures "who calls heapsort" finds tuplesort.c code even when
 * heapsort isn't a standalone function in the call graph.
 */

let GrepIndex = null;
try {
    GrepIndex = require('./grep-search').GrepIndex;
} catch (e) {
    // GrepIndex optional
}

const pathUtils = require('./pathUtils');

// ============================================================
// MODULE STATE
// ============================================================

let codebaseIndex = null;
let grepIndex = null;
let log = (...args) => console.log('[AstraCode Search]', ...args);

// ============================================================
// QUERY INTENT DETECTION (for LLM prompt hints, not routing)
// ============================================================

const QueryIntent = {
    CALLERS: 'callers',      // "who calls X"
    CALLEES: 'callees',      // "what does X call"
    EXPLAIN: 'explain',      // "explain how X works"
    FIND: 'find',            // "find X", "show me X"
    STRUCTURE: 'structure',  // "what fields in X"
    GENERAL: 'general'
};

const INTENT_PATTERNS = {
    [QueryIntent.CALLERS]: [
        /\b(?:who|what)\s+calls?\s+['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?/i,
        /callers?\s+(?:of\s+)?['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?/i,
        /where\s+is\s+['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?\s+(?:called|used|invoked)/i,
        /usages?\s+of\s+['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?/i,
    ],
    [QueryIntent.CALLEES]: [
        /what\s+does\s+['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?\s+call/i,
        /callees?\s+(?:of\s+)?['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?/i,
        /functions?\s+called\s+by\s+['"]?([a-zA-Z_][a-zA-Z0-9_\-\s]*)['"]?/i,
    ],
    [QueryIntent.EXPLAIN]: [
        /\b(?:explain|how\s+does|how\s+is|describe)\s+(.+?)(?:\s+work|\s+implemented|\s+done|\?|$)/i,
        /\bwhat\s+is\s+(.+?)(?:\?|$)/i,
    ],
    [QueryIntent.STRUCTURE]: [
        /\b(?:what|show)\s+(?:fields?|members?|properties)\s+(?:in|of)\s+(.+)/i,
        /\bstruct(?:ure)?\s+(?:of\s+)?(.+)/i,
    ],
    [QueryIntent.FIND]: [
        /\b(?:find|show|list|get)\s+(.+)/i,
    ]
};

/**
 * Detect query intent and extract target entity
 * Returns { intent, target, variants }
 */
function detectIntent(query) {
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
        for (const pattern of patterns) {
            const match = query.match(pattern);
            if (match && match[1]) {
                const target = match[1].trim();
                return {
                    intent,
                    target,
                    variants: generateVariants(target),
                    originalQuery: query
                };
            }
        }
    }
    
    return {
        intent: QueryIntent.GENERAL,
        target: query,
        variants: generateVariants(query),
        originalQuery: query
    };
}

/**
 * Generate search variants for a term
 * "heap sort" -> ["heap sort", "heapsort", "heap_sort", "heapSort", ...]
 */
function generateVariants(term) {
    const variants = new Set();
    const trimmed = term.trim();
    
    variants.add(trimmed);
    variants.add(trimmed.toLowerCase());
    
    // Split on whitespace, underscores, hyphens
    const words = trimmed.split(/[\s_\-]+/).filter(w => w.length > 0);
    
    if (words.length >= 1) {
        // joined: "heapsort"
        variants.add(words.join('').toLowerCase());
        // snake_case: "heap_sort"
        variants.add(words.join('_').toLowerCase());
        // UPPER_SNAKE: "HEAP_SORT"
        variants.add(words.join('_').toUpperCase());
        // camelCase: "heapSort"
        if (words.length > 1) {
            variants.add(words[0].toLowerCase() + 
                words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(''));
        }
        // PascalCase: "HeapSort"
        variants.add(words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(''));
    }
    
    return Array.from(variants);
}

// ============================================================
// INITIALIZATION
// ============================================================

function initialize(index, logFn) {
    codebaseIndex = index;
    if (typeof logFn === 'function') {
        log = logFn;
    }
    
    if (GrepIndex) {
        grepIndex = new GrepIndex({ contextLines: 2, buildCallIndex: true });
    }
    
    log(`Search module v8 initialized, mode: unified`);
}

function buildGrepIndex(contextFiles, options = {}) {
    if (!GrepIndex || !grepIndex) return { error: 'GrepIndex not available' };
    return grepIndex.build(contextFiles, { log, ...options });
}

// ============================================================
// UNIFIED SEARCH - THE CORE
// ============================================================

/**
 * Execute unified search - ALWAYS gathers context, THEN enriches
 * 
 * @param {string} query - User's search query
 * @param {Object} options - Search options
 * @returns {Object} Unified search results
 */
function executeSearch(query, options = {}) {
    if (!codebaseIndex) {
        log('ERROR: CodebaseIndex not initialized');
        return { 
            symbols: [], 
            codeBlocks: [], 
            enrichments: {},
            stats: { error: 'Index not initialized' } 
        };
    }
    
    const startTime = Date.now();
    
    // 1. Detect intent (for prompt hints, not routing)
    const { intent, target, variants } = detectIntent(query);
    log(`Query: "${query}" -> intent: ${intent}, target: "${target}"`);
    log(`Variants: ${variants.join(', ')}`);
    
    // 2. ALWAYS: Run broad context search using all variants
    const baseResults = gatherBaseContext(query, variants, options);
    
    // 3. ENRICH: Add specialized data based on intent
    const enrichments = gatherEnrichments(intent, target, variants, options);
    
    // 4. Combine and format
    const results = combineResults(baseResults, enrichments, {
        intent,
        target,
        query,
        elapsed: Date.now() - startTime
    });
    
    log(`Search complete: ${results.symbols.length} symbols, ${results.codeBlocks.length} blocks, enrichments: ${Object.keys(enrichments).filter(k => enrichments[k]).join(', ') || 'none'}`);
    
    return results;
}

/**
 * STEP 1: Gather broad context - symbols, code blocks, files
 * This ALWAYS runs regardless of query type
 */
function gatherBaseContext(query, variants, options = {}) {
    const maxResults = options.maxResults || 100;
    const allSymbols = new Map(); // key -> symbol (deduped)
    const codeLocations = [];     // { file, line, context }
    const matchedFiles = new Set();
    
    // Search with each variant
    for (const variant of variants) {
        // Use CodebaseIndex unified search
        const searchResults = codebaseIndex.search(variant, {
            maxResults: Math.ceil(maxResults / variants.length),
            includeCodeBlocks: true,
            searchTypes: ['all']
        });
        
        // Collect symbols
        for (const sym of (searchResults.symbols || [])) {
            const key = sym.key || `${sym.file}:${sym.name}:${sym.line}`;
            if (!allSymbols.has(key)) {
                allSymbols.set(key, { ...sym, matchedVariant: variant });
            }
        }
        
        // Collect files
        for (const file of (searchResults.files || [])) {
            matchedFiles.add(file.path || file);
        }
    }
    
    // Also do grep-style search for literal occurrences
    if (grepIndex) {
        for (const variant of variants.slice(0, 3)) { // Limit grep variants
            try {
                const grepResults = grepIndex.searchLiteral(variant, {
                    caseSensitive: false,
                    maxResults: 20
                });
                
                for (const result of (grepResults.results || [])) {
                    codeLocations.push({
                        file: result.file,
                        line: result.line,
                        context: result.lineContent || result.context?.line,
                        matchedVariant: variant,
                        source: 'grep'
                    });
                    matchedFiles.add(result.file);
                }
            } catch (e) {
                log(`Grep search failed for "${variant}": ${e.message}`);
            }
        }
    }
    
    // Sort symbols by score
    const sortedSymbols = Array.from(allSymbols.values())
        .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
        .slice(0, maxResults);
    
    // Get code blocks for top symbols
    const codeBlocks = [];
    const seenBlocks = new Set();
    
    for (const sym of sortedSymbols.slice(0, 25)) {
        const blockKey = `${sym.file}:${Math.floor((sym.line || 0) / 20)}`;
        if (!seenBlocks.has(blockKey)) {
            seenBlocks.add(blockKey);
            const block = codebaseIndex.getCodeBlock(sym);
            if (block) {
                codeBlocks.push({
                    symbol: sym.name,
                    type: sym.type,
                    matchedVariant: sym.matchedVariant,
                    ...block
                });
            }
        }
    }
    
    // Add code blocks from grep locations (where we found literal matches)
    for (const loc of codeLocations.slice(0, 15)) {
        const blockKey = `${loc.file}:${Math.floor(loc.line / 20)}`;
        if (!seenBlocks.has(blockKey)) {
            seenBlocks.add(blockKey);
            
            // Find a symbol near this location, or create a pseudo-entry
            const nearbySymbol = findNearestSymbol(loc.file, loc.line);
            if (nearbySymbol) {
                const block = codebaseIndex.getCodeBlock(nearbySymbol);
                if (block) {
                    codeBlocks.push({
                        symbol: nearbySymbol.name,
                        type: nearbySymbol.type,
                        matchedVariant: loc.matchedVariant,
                        grepMatch: loc.context,
                        ...block
                    });
                }
            } else {
                // No symbol nearby - extract raw code context
                const rawBlock = extractCodeContext(loc.file, loc.line, 30);
                if (rawBlock) {
                    codeBlocks.push({
                        symbol: `[line ${loc.line}]`,
                        type: 'code_match',
                        matchedVariant: loc.matchedVariant,
                        grepMatch: loc.context,
                        ...rawBlock
                    });
                }
            }
        }
    }
    
    return {
        symbols: sortedSymbols,
        codeBlocks,
        files: Array.from(matchedFiles),
        codeLocations
    };
}

/**
 * STEP 2: Gather enrichments based on intent
 * These are OPTIONAL - we still have base context if these return nothing
 */
function gatherEnrichments(intent, target, variants, options = {}) {
    const enrichments = {
        callers: null,
        callees: null,
        callSites: null,
        structure: null
    };
    
    // Try to find callers/callees from call graph
    if (intent === QueryIntent.CALLERS || intent === QueryIntent.EXPLAIN) {
        const callerData = findCallers(variants);
        if (callerData.found) {
            enrichments.callers = callerData;
        }
    }
    
    if (intent === QueryIntent.CALLEES || intent === QueryIntent.EXPLAIN) {
        const calleeData = findCallees(variants);
        if (calleeData.found) {
            enrichments.callees = calleeData;
        }
    }
    
    // Try to find call sites from grep
    if (intent === QueryIntent.CALLERS && grepIndex) {
        const callSites = findCallSites(variants);
        if (callSites.found) {
            enrichments.callSites = callSites;
        }
    }
    
    return enrichments;
}

/**
 * Find callers from call graph for any matching variant
 */
function findCallers(variants) {
    if (!codebaseIndex) return { found: false };
    
    for (const variant of variants) {
        const callers = codebaseIndex.getCallers?.(variant) || [];
        if (callers.length > 0) {
            return {
                found: true,
                matchedVariant: variant,
                callers: callers.map(name => {
                    const symbol = codebaseIndex.getSymbol?.(name);
                    return {
                        name,
                        file: symbol?.file,
                        line: symbol?.line,
                        type: symbol?.type
                    };
                })
            };
        }
    }
    
    return { found: false };
}

/**
 * Find callees from call graph for any matching variant
 */
function findCallees(variants) {
    if (!codebaseIndex) return { found: false };
    
    for (const variant of variants) {
        const callees = codebaseIndex.getCallees?.(variant) || [];
        if (callees.length > 0) {
            return {
                found: true,
                matchedVariant: variant,
                callees: callees.map(name => {
                    const symbol = codebaseIndex.getSymbol?.(name);
                    return {
                        name,
                        file: symbol?.file,
                        line: symbol?.line,
                        type: symbol?.type
                    };
                })
            };
        }
    }
    
    return { found: false };
}

/**
 * Find call sites from grep index
 */
function findCallSites(variants) {
    if (!grepIndex) return { found: false };
    
    for (const variant of variants) {
        if (grepIndex.hasFunctionCalls?.(variant)) {
            const results = grepIndex.searchFunctionCalls(variant, { maxResults: 30 });
            if (results.results?.length > 0) {
                return {
                    found: true,
                    matchedVariant: variant,
                    sites: results.results.map(r => ({
                        file: r.file,
                        line: r.line,
                        context: r.lineContent || r.context?.line,
                        enclosingFunction: r.enclosingFunction?.name
                    }))
                };
            }
        }
    }
    
    return { found: false };
}

/**
 * Find nearest symbol to a line in a file
 */
function findNearestSymbol(filePath, line) {
    if (!codebaseIndex) return null;
    
    let nearest = null;
    let minDist = Infinity;
    
    for (const [key, symbol] of codebaseIndex.symbols || []) {
        if (symbol.file === filePath) {
            const dist = Math.abs(symbol.line - line);
            if (dist < minDist && dist < 50) {
                minDist = dist;
                nearest = symbol;
            }
        }
    }
    
    return nearest;
}

/**
 * Extract raw code context around a line
 */
function extractCodeContext(filePath, line, contextLines = 30) {
    if (!codebaseIndex) return null;
    
    const content = codebaseIndex.getFileContent?.(filePath);
    if (!content) return null;
    
    const lines = content.split('\n');
    const startLine = Math.max(0, line - 5);
    const endLine = Math.min(lines.length, line + contextLines);
    
    return {
        file: filePath,
        startLine: startLine + 1,
        endLine: endLine,
        code: lines.slice(startLine, endLine).join('\n')
    };
}

/**
 * STEP 3: Combine base context and enrichments into final result
 */
function combineResults(baseResults, enrichments, meta) {
    const { symbols, codeBlocks, files, codeLocations } = baseResults;
    
    // Build formatted context for LLM
    let context = formatContextForLLM(baseResults, enrichments, meta);
    
    return {
        // Core data
        symbols,
        codeBlocks,
        files,
        
        // Enrichments (may be null)
        enrichments,
        
        // Query metadata
        intent: meta.intent,
        target: meta.target,
        
        // Formatted context for LLM
        context,
        
        // Stats
        stats: {
            symbols: symbols.length,
            codeBlocks: codeBlocks.length,
            files: files.length,
            grepMatches: codeLocations.length,
            hasCallers: !!enrichments.callers?.found,
            hasCallees: !!enrichments.callees?.found,
            hasCallSites: !!enrichments.callSites?.found,
            elapsed: meta.elapsed
        }
    };
}

/**
 * Format results into LLM-friendly context
 */
function formatContextForLLM(baseResults, enrichments, meta) {
    const { symbols, codeBlocks, files, codeLocations } = baseResults;
    const { intent, target, query } = meta;
    
    let context = `# Search Results for: "${query}"\n`;
    context += `Intent: ${intent}, Target: "${target}"\n\n`;
    
    // If we have call graph enrichments, show them prominently
    if (enrichments.callers?.found) {
        context += `## Call Graph: Callers of ${enrichments.callers.matchedVariant}\n`;
        for (const caller of enrichments.callers.callers.slice(0, 10)) {
            context += `- ${caller.name} (${caller.type || 'function'}) in ${caller.file || 'unknown'}:${caller.line || '?'}\n`;
        }
        context += '\n';
    }
    
    if (enrichments.callees?.found) {
        context += `## Call Graph: Functions called by ${enrichments.callees.matchedVariant}\n`;
        for (const callee of enrichments.callees.callees.slice(0, 10)) {
            context += `- ${callee.name} (${callee.type || 'function'}) in ${callee.file || 'unknown'}:${callee.line || '?'}\n`;
        }
        context += '\n';
    }
    
    if (enrichments.callSites?.found) {
        context += `## Call Sites for ${enrichments.callSites.matchedVariant}\n`;
        for (const site of enrichments.callSites.sites.slice(0, 10)) {
            context += `- ${site.file}:${site.line}`;
            if (site.enclosingFunction) context += ` (in ${site.enclosingFunction})`;
            context += '\n';
            if (site.context) context += `  \`${site.context.trim()}\`\n`;
        }
        context += '\n';
    }
    
    // Show symbols found
    if (symbols.length > 0) {
        context += `## Relevant Symbols (${symbols.length} found)\n\n`;
        
        // Group by file
        const byFile = new Map();
        for (const sym of symbols.slice(0, 30)) {
            const file = sym.file || 'unknown';
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file).push(sym);
        }
        
        for (const [file, syms] of byFile) {
            const fileName = pathUtils.getFileName(file);
            context += `### ${fileName}\n`;
            context += `Path: ${file}\n\n`;
            
            for (const sym of syms.slice(0, 5)) {
                context += `- **${sym.name}** (${sym.type}) line ${sym.line}`;
                if (sym.summary) context += ` - ${sym.summary}`;
                context += '\n';
            }
            context += '\n';
        }
    }
    
    // Show code blocks
    if (codeBlocks.length > 0) {
        context += `## Code Blocks (${codeBlocks.length} found)\n\n`;
        
        for (const block of codeBlocks.slice(0, 10)) {
            context += `### ${block.symbol} (${block.type})\n`;
            context += `File: ${block.file}, Lines: ${block.startLine}-${block.endLine}\n`;
            if (block.grepMatch) {
                context += `Matched: \`${block.grepMatch.trim()}\`\n`;
            }
            context += '```\n' + block.code + '\n```\n\n';
        }
    }
    
    // If no enrichments and query was about callers, add a note
    if (intent === QueryIntent.CALLERS && !enrichments.callers?.found && !enrichments.callSites?.found) {
        context += `\n---\n`;
        context += `Note: No direct function named "${target}" found in call graph. `;
        context += `The search results above show code locations where "${target}" appears, `;
        context += `which may indicate inline implementations or algorithm usage rather than function calls.\n`;
    }
    
    return context;
}

// ============================================================
// CONVENIENCE WRAPPERS (for backward compatibility)
// ============================================================

// Mode is deprecated in v8 (unified search handles all cases)
// These stubs maintain backward compatibility
let _legacyMode = 'detailed';

function setMode(mode) {
    _legacyMode = mode;
    log(`[DEPRECATED] setMode called with: ${mode} (ignored in v8 unified search)`);
}

function getMode() {
    return _legacyMode;
}

function executeDetailedSearch(query, options = {}) {
    return executeSearch(query, { ...options, detailed: true });
}

function executeOverviewSearch(query, options = {}) {
    return executeSearch(query, { ...options, maxResults: 30 });
}

// Legacy callers/callees - now just unified search with intent hints
function executeCallersSearch(funcName, options = {}) {
    return executeSearch(`who calls ${funcName}`, options);
}

function executeCalleesSearch(funcName, options = {}) {
    return executeSearch(`what does ${funcName} call`, options);
}

// ============================================================
// LOOKUP FUNCTIONS (unchanged from v7)
// ============================================================

function lookupSymbol(key) {
    return codebaseIndex?.getSymbol(key) || null;
}

function lookupSymbolsByName(name) {
    return codebaseIndex?.getSymbolsByName(name) || [];
}

function lookupCallers(funcName) {
    return codebaseIndex?.getCallers(funcName) || [];
}

function lookupCallees(funcName) {
    return codebaseIndex?.getCallees(funcName) || [];
}

function getCodeBlock(symbol, options) {
    return codebaseIndex?.getCodeBlock(symbol, options) || null;
}

function getFileContent(filePath) {
    return codebaseIndex?.getFileContent(filePath) || null;
}

function getStats() {
    const codebaseStats = codebaseIndex?.getStats() || {};
    const grepStats = grepIndex?.getStats() || {};
    return { ...codebaseStats, grep: grepStats };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Initialization
    initialize,
    buildGrepIndex,
    
    // Mode (deprecated but kept for compatibility)
    setMode,
    getMode,
    
    // Core search (unified)
    executeSearch,
    executeDetailedSearch,
    executeOverviewSearch,
    
    // Legacy compatibility
    executeCallersSearch,
    executeCalleesSearch,
    
    // Intent detection (exposed for testing)
    detectIntent,
    generateVariants,
    QueryIntent,
    
    // Lookups
    lookupSymbol,
    lookupSymbolsByName,
    lookupCallers,
    lookupCallees,
    getCodeBlock,
    getFileContent,
    getStats,
    
    // Expose indexes
    get grepIndex() { return grepIndex; },
    get codebaseIndex() { return codebaseIndex; }
};
