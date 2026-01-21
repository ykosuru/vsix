/**
 * AstraCode Symbol Search v2.0
 * Symbol indexing, fuzzy matching, and enhanced call graph operations
 * 
 * Key additions in v2.0:
 * - Integration with GrepIndex for call site locations
 * - Enhanced traceSymbol with file:line:context
 * - buildCallGraphFromSymbol with location-aware edges
 */

const pathUtils = require('./pathUtils');

// Logging - uses console by default, can be overridden
let log = (...args) => console.log('[SymbolSearch]', ...args);

function setLogger(logFn) {
    if (typeof logFn === 'function') {
        log = logFn;
    }
}

// ============================================================
// Fuzzy Matching
// ============================================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    
    const matrix = [];
    
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    
    return matrix[b.length][a.length];
}

/**
 * Check if string matches CamelCase abbreviation
 * e.g., "RTE" matches "RangeTblEntry"
 */
function matchesCamelCaseAbbrev(query, target) {
    const upperQuery = query.toUpperCase();
    const targetInitials = target.match(/([A-Z])/g)?.join('').toUpperCase() || '';
    
    if (targetInitials === upperQuery) {
        return true;
    }
    
    // Also check if query is prefix of initials
    if (targetInitials.startsWith(upperQuery) && upperQuery.length >= 2) {
        return true;
    }
    
    return false;
}

/**
 * Check if query matches as subsequence of target
 */
function isSubsequence(query, target) {
    const lowerQuery = query.toLowerCase();
    const lowerTarget = target.toLowerCase();
    
    let queryIdx = 0;
    for (let i = 0; i < lowerTarget.length && queryIdx < lowerQuery.length; i++) {
        if (lowerTarget[i] === lowerQuery[queryIdx]) {
            queryIdx++;
        }
    }
    
    return queryIdx === lowerQuery.length;
}

/**
 * Calculate fuzzy match score
 * Returns a score 0-100 where higher is better
 */
function fuzzyMatchScore(query, target) {
    const lowerQuery = query.toLowerCase();
    const lowerTarget = target.toLowerCase();
    
    // Exact match
    if (lowerTarget === lowerQuery) {
        return 100;
    }
    
    // Contains exact match
    if (lowerTarget.includes(lowerQuery)) {
        // Bonus if it's at the start
        if (lowerTarget.startsWith(lowerQuery)) {
            return 95;
        }
        // Bonus if it's a word boundary match
        const idx = lowerTarget.indexOf(lowerQuery);
        if (idx === 0 || /[^a-z0-9]/.test(lowerTarget[idx - 1])) {
            return 90;
        }
        return 85;
    }
    
    // CamelCase abbreviation match
    if (matchesCamelCaseAbbrev(query, target)) {
        return 80;
    }
    
    // Subsequence match
    if (isSubsequence(query, target)) {
        const ratio = query.length / target.length;
        return 60 + (ratio * 20);
    }
    
    // Levenshtein distance based score
    const distance = levenshteinDistance(lowerQuery, lowerTarget);
    const maxLen = Math.max(lowerQuery.length, lowerTarget.length);
    const similarity = 1 - (distance / maxLen);
    
    if (similarity > 0.5) {
        return similarity * 50;
    }
    
    return 0;
}

// ============================================================
// Symbol Search
// ============================================================

/**
 * Fuzzy search symbols in code index
 */
function fuzzySearchSymbols(query, codeIndex, type = null, maxResults = 50, minScore = 20) {
    const results = [];
    const searchQuery = query.toLowerCase();
    
    for (const [key, symbol] of codeIndex.symbols) {
        // Skip duplicate entries (we have both "name" and "name@path" entries)
        if (key.includes('@')) continue;
        
        // Filter by type if specified
        if (type && symbol.type !== type) continue;
        
        const score = fuzzyMatchScore(searchQuery, symbol.name);
        
        if (score >= minScore) {
            results.push({
                name: symbol.name,
                type: symbol.type,
                file: symbol.file,
                line: symbol.line,
                signature: symbol.signature,
                matchScore: score
            });
        }
    }
    
    // Sort by score descending
    results.sort((a, b) => b.matchScore - a.matchScore);
    
    return results.slice(0, maxResults);
}

/**
 * Get symbol by name
 */
function getSymbol(name, codeIndex) {
    // Try exact match first
    let symbol = codeIndex.symbols.get(name);
    if (symbol) return symbol;
    
    // Try case-insensitive match
    const lowerName = name.toLowerCase();
    for (const [key, sym] of codeIndex.symbols) {
        if (key.toLowerCase() === lowerName || sym.name.toLowerCase() === lowerName) {
            return sym;
        }
    }
    
    return null;
}

/**
 * Find symbols by pattern in file path
 */
function findSymbolsInFiles(filePattern, codeIndex) {
    const results = [];
    const lowerPattern = filePattern.toLowerCase();
    
    for (const [key, symbol] of codeIndex.symbols) {
        if (key.includes('@')) continue;
        
        if (symbol.file && symbol.file.toLowerCase().includes(lowerPattern)) {
            results.push(symbol);
        }
    }
    
    return results;
}

// ============================================================
// Enhanced Call Graph Operations (with GrepIndex integration)
// ============================================================

/**
 * Trace a symbol's call relationships with location info
 * @param {string} symbolName - Function name to trace
 * @param {Object} codeIndex - The code index with call graph
 * @param {GrepIndex} grepIndex - Optional grep index for call site locations
 */
function traceSymbol(symbolName, codeIndex, grepIndex = null) {
    const result = {
        name: symbolName,
        symbol: null,
        callers: [],
        callees: [],
        callSites: []  // NEW: actual call site locations
    };
    
    // Get symbol info
    result.symbol = getSymbol(symbolName, codeIndex);
    
    // Get what this symbol calls
    const calls = codeIndex.callGraph.get(symbolName);
    if (calls) {
        for (const callee of calls) {
            const symbol = getSymbol(callee, codeIndex);
            result.callees.push({
                name: callee,
                file: symbol?.file,
                line: symbol?.line,
                type: symbol?.type,
                summary: symbol?.summary
            });
        }
    }
    
    // Get what calls this symbol
    const callers = codeIndex.reverseCallGraph.get(symbolName);
    if (callers) {
        for (const caller of callers) {
            const symbol = getSymbol(caller, codeIndex);
            result.callers.push({
                name: caller,
                file: symbol?.file,
                line: symbol?.line,
                type: symbol?.type,
                summary: symbol?.summary
            });
        }
    }
    
    // NEW: Get actual call site locations from GrepIndex
    if (grepIndex && grepIndex.hasFunctionCalls) {
        const callResults = grepIndex.searchFunctionCalls(symbolName, {
            excludeDefinitions: true,
            maxResults: 50
        });
        
        if (callResults && callResults.results) {
            result.callSites = callResults.results.map(site => ({
                file: site.file,
                line: site.line,
                column: site.column,
                context: site.context,
                matchText: site.matchText,
                // Try to find which caller function contains this call site
                enclosingFunction: site.enclosingFunction || 
                    findEnclosingFunctionFromCallers(site, result.callers)
            }));
        }
    }
    
    return result;
}

/**
 * Try to match a call site to a known caller based on file
 */
function findEnclosingFunctionFromCallers(callSite, callers) {
    for (const caller of callers) {
        if (caller.file === callSite.file) {
            // Simple heuristic: if call site is after function start, it might be in this function
            // More accurate matching would require full AST analysis
            return {
                name: caller.name,
                file: caller.file,
                line: caller.line
            };
        }
    }
    return null;
}

/**
 * Build call graph starting from a symbol with enhanced location info
 * @param {string} startSymbol - Starting function name
 * @param {Object} codeIndex - The code index
 * @param {number} depth - Max traversal depth
 * @param {GrepIndex} grepIndex - Optional grep index for call site locations
 */
function buildCallGraphFromSymbol(startSymbol, codeIndex, depth = 3, grepIndex = null) {
    const nodes = new Map(); // name -> {name, file, line, type, summary}
    const edges = [];        // [{from, to, callSites: [{file, line, context}]}]
    const visited = new Set();
    
    function traverse(symbolName, currentDepth, direction) {
        if (currentDepth > depth || visited.has(`${symbolName}-${direction}`)) {
            return;
        }
        visited.add(`${symbolName}-${direction}`);
        
        const symbol = getSymbol(symbolName, codeIndex);
        if (!nodes.has(symbolName)) {
            nodes.set(symbolName, {
                name: symbolName,
                file: symbol?.file,
                line: symbol?.line,
                type: symbol?.type,
                summary: symbol?.summary
            });
        }
        
        if (direction === 'down' || direction === 'both') {
            const callees = codeIndex.callGraph.get(symbolName);
            if (callees) {
                for (const callee of callees) {
                    if (!nodes.has(callee)) {
                        const calleeSymbol = getSymbol(callee, codeIndex);
                        nodes.set(callee, {
                            name: callee,
                            file: calleeSymbol?.file,
                            line: calleeSymbol?.line,
                            type: calleeSymbol?.type,
                            summary: calleeSymbol?.summary
                        });
                    }
                    
                    // Get call site locations for this edge
                    let callSites = [];
                    if (grepIndex && grepIndex.hasFunctionCalls) {
                        const callResults = grepIndex.searchFunctionCalls(callee, {
                            excludeDefinitions: true,
                            maxResults: 10
                        });
                        
                        if (callResults && callResults.results) {
                            // Filter to call sites within the caller's file
                            const callerNode = nodes.get(symbolName);
                            callSites = callResults.results
                                .filter(site => callerNode?.file && site.file === callerNode.file)
                                .map(site => ({
                                    file: site.file,
                                    line: site.line,
                                    context: site.context
                                }));
                        }
                    }
                    
                    edges.push({ 
                        from: symbolName, 
                        to: callee,
                        callSites
                    });
                    traverse(callee, currentDepth + 1, 'down');
                }
            }
        }
        
        if (direction === 'up' || direction === 'both') {
            const callers = codeIndex.reverseCallGraph.get(symbolName);
            if (callers) {
                for (const caller of callers) {
                    if (!nodes.has(caller)) {
                        const callerSymbol = getSymbol(caller, codeIndex);
                        nodes.set(caller, {
                            name: caller,
                            file: callerSymbol?.file,
                            line: callerSymbol?.line,
                            type: callerSymbol?.type,
                            summary: callerSymbol?.summary
                        });
                    }
                    
                    // Get call site locations for this edge
                    let callSites = [];
                    if (grepIndex && grepIndex.hasFunctionCalls) {
                        const callResults = grepIndex.searchFunctionCalls(symbolName, {
                            excludeDefinitions: true,
                            maxResults: 10
                        });
                        
                        if (callResults && callResults.results) {
                            // Filter to call sites within the caller's file
                            const callerNode = nodes.get(caller);
                            callSites = callResults.results
                                .filter(site => callerNode?.file && site.file === callerNode.file)
                                .map(site => ({
                                    file: site.file,
                                    line: site.line,
                                    context: site.context
                                }));
                        }
                    }
                    
                    edges.push({ 
                        from: caller, 
                        to: symbolName,
                        callSites
                    });
                    traverse(caller, currentDepth + 1, 'up');
                }
            }
        }
    }
    
    traverse(startSymbol, 0, 'both');
    
    return { nodes, edges };
}

/**
 * Find entry points (functions not called by others)
 */
function findEntryPoints(codeIndex) {
    const entryPoints = [];
    
    for (const [funcName, callees] of codeIndex.callGraph) {
        const callers = codeIndex.reverseCallGraph.get(funcName);
        if (!callers || callers.size === 0) {
            const symbol = getSymbol(funcName, codeIndex);
            if (symbol) {
                entryPoints.push({
                    name: funcName,
                    file: symbol.file,
                    line: symbol.line,
                    type: symbol.type,
                    callCount: callees.size
                });
            }
        }
    }
    
    // Sort by number of calls (more calls = more important entry point)
    entryPoints.sort((a, b) => b.callCount - a.callCount);
    
    return entryPoints;
}

/**
 * Find leaf functions (functions that don't call others)
 */
function findLeafFunctions(codeIndex) {
    const leafFunctions = [];
    
    // Get all functions that are called
    const calledFunctions = new Set();
    for (const [, callees] of codeIndex.callGraph) {
        for (const callee of callees) {
            calledFunctions.add(callee);
        }
    }
    
    // Find functions that are called but don't call others
    for (const funcName of calledFunctions) {
        const callees = codeIndex.callGraph.get(funcName);
        if (!callees || callees.size === 0) {
            const symbol = getSymbol(funcName, codeIndex);
            const callers = codeIndex.reverseCallGraph.get(funcName);
            if (symbol) {
                leafFunctions.push({
                    name: funcName,
                    file: symbol.file,
                    line: symbol.line,
                    type: symbol.type,
                    callerCount: callers?.size || 0
                });
            }
        }
    }
    
    // Sort by number of callers (more callers = more important leaf)
    leafFunctions.sort((a, b) => b.callerCount - a.callerCount);
    
    return leafFunctions;
}

/**
 * Trace call path between two functions
 * Returns array of paths from source to target
 */
function findCallPath(sourceFunc, targetFunc, codeIndex, maxDepth = 10) {
    const paths = [];
    const visited = new Set();
    
    function dfs(current, path) {
        if (path.length > maxDepth) return;
        if (current === targetFunc) {
            paths.push([...path, current]);
            return;
        }
        if (visited.has(current)) return;
        
        visited.add(current);
        
        const callees = codeIndex.callGraph.get(current);
        if (callees) {
            for (const callee of callees) {
                dfs(callee, [...path, current]);
            }
        }
        
        visited.delete(current); // Allow revisiting in different paths
    }
    
    dfs(sourceFunc, []);
    
    // Sort by path length (shortest first)
    paths.sort((a, b) => a.length - b.length);
    
    return paths;
}

/**
 * Get call graph statistics
 */
function getCallGraphStats(codeIndex) {
    let totalEdges = 0;
    let maxOutDegree = 0;
    let maxInDegree = 0;
    let maxOutFunc = null;
    let maxInFunc = null;
    
    for (const [funcName, callees] of codeIndex.callGraph) {
        totalEdges += callees.size;
        if (callees.size > maxOutDegree) {
            maxOutDegree = callees.size;
            maxOutFunc = funcName;
        }
    }
    
    for (const [funcName, callers] of codeIndex.reverseCallGraph) {
        if (callers.size > maxInDegree) {
            maxInDegree = callers.size;
            maxInFunc = funcName;
        }
    }
    
    return {
        functions: codeIndex.callGraph.size,
        edges: totalEdges,
        avgOutDegree: totalEdges / Math.max(1, codeIndex.callGraph.size),
        maxOutDegree,
        maxOutFunction: maxOutFunc,
        maxInDegree,
        maxInFunction: maxInFunc
    };
}

// ============================================================
// Utilities
// ============================================================

/**
 * Generate summary from function name
 */
function generateSummaryFromName(name) {
    if (!name) return 'Unknown function';
    
    // Split on common separators
    const words = name
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // XMLParser -> XML Parser
        .replace(/_/g, ' ')                     // snake_case
        .replace(/-/g, ' ')                     // kebab-case
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 0);
    
    if (words.length === 0) return `Function ${name}`;
    
    // Build sentence
    const actionWords = ['get', 'set', 'create', 'delete', 'update', 'find', 'search', 'load', 'save', 'init', 'check', 'validate', 'process', 'handle', 'parse', 'build', 'format', 'convert'];
    const firstWord = words[0];
    
    if (actionWords.includes(firstWord)) {
        const rest = words.slice(1).join(' ');
        return `${firstWord.charAt(0).toUpperCase() + firstWord.slice(1)}s ${rest}`;
    }
    
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Get code index summary statistics
 */
function getIndexStats(codeIndex) {
    const stats = {
        files: codeIndex.files.size,
        symbols: codeIndex.symbols.size,
        functions: 0,
        classes: 0,
        variables: codeIndex.variables.size,
        callGraphEdges: 0,
        summaries: codeIndex.summaries.size
    };
    
    // Count by type
    const typeCounts = {};
    for (const [key, sym] of codeIndex.symbols) {
        if (key.includes('@')) continue;
        typeCounts[sym.type] = (typeCounts[sym.type] || 0) + 1;
    }
    
    stats.functions = (typeCounts['function'] || 0) + (typeCounts['procedure'] || 0) + 
                      (typeCounts['method'] || 0) + (typeCounts['subproc'] || 0);
    stats.classes = (typeCounts['class'] || 0) + (typeCounts['struct'] || 0) + 
                    (typeCounts['interface'] || 0);
    
    // Count call graph edges
    for (const [_, calls] of codeIndex.callGraph) {
        stats.callGraphEdges += calls.size;
    }
    
    stats.typeCounts = typeCounts;
    
    return stats;
}

/**
 * Format call graph as Mermaid diagram
 */
function formatCallGraphAsMermaid(nodes, edges, options = {}) {
    const { direction = 'TB', maxNodes = 50 } = options;
    
    let mermaid = `graph ${direction}\n`;
    
    // Add nodes (limit to prevent huge diagrams)
    let nodeCount = 0;
    const includedNodes = new Set();
    
    for (const [name, node] of nodes) {
        if (nodeCount >= maxNodes) break;
        
        const label = node.type ? `${name}<br/><i>${node.type}</i>` : name;
        const fileName = pathUtils.getFileName(node.file || '') || '';
        mermaid += `    ${sanitizeNodeId(name)}["${label}"]\n`;
        includedNodes.add(name);
        nodeCount++;
    }
    
    // Add edges
    for (const edge of edges) {
        if (includedNodes.has(edge.from) && includedNodes.has(edge.to)) {
            const label = edge.callSites?.length ? `${edge.callSites.length} calls` : '';
            if (label) {
                mermaid += `    ${sanitizeNodeId(edge.from)} -->|"${label}"| ${sanitizeNodeId(edge.to)}\n`;
            } else {
                mermaid += `    ${sanitizeNodeId(edge.from)} --> ${sanitizeNodeId(edge.to)}\n`;
            }
        }
    }
    
    return mermaid;
}

/**
 * Sanitize node ID for Mermaid (remove special characters)
 */
function sanitizeNodeId(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

module.exports = {
    // Logging
    setLogger,
    
    // Fuzzy matching
    levenshteinDistance,
    matchesCamelCaseAbbrev,
    isSubsequence,
    fuzzyMatchScore,
    
    // Symbol search
    fuzzySearchSymbols,
    getSymbol,
    findSymbolsInFiles,
    
    // Call graph (enhanced with GrepIndex support)
    traceSymbol,
    buildCallGraphFromSymbol,
    findEntryPoints,
    findLeafFunctions,
    findCallPath,
    getCallGraphStats,
    
    // Utilities
    generateSummaryFromName,
    getIndexStats,
    formatCallGraphAsMermaid
};
