/**
 * Query Analyzer - determines search strategy from natural language queries
 */

// Stop words to filter from keyword extraction
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
    'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'and', 'but', 'if', 'or', 'because', 'while', 'although', 'this', 'that',
    'what', 'which', 'who', 'how', 'why', 'when', 'where', 'explain', 'show',
    'find', 'tell', 'describe', 'work', 'works', 'working', 'code', 'function',
    'please', 'help', 'understand', 'want', 'like', 'know', 'get', 'make'
]);

// Patterns to detect "who calls X?" style queries
const CALL_PATTERNS = [
    /who\s+calls?\s+['"`]?(\w+)['"`]?/i,
    /callers?\s+of\s+['"`]?(\w+)['"`]?/i,
    /where\s+is\s+['"`]?(\w+)['"`]?\s+called/i,
    /find\s+calls?\s+to\s+['"`]?(\w+)['"`]?/i,
    /usages?\s+of\s+['"`]?(\w+)['"`]?/i,
    /references?\s+to\s+['"`]?(\w+)['"`]?/i
];

/**
 * Analyze a query to determine search strategy
 * @param {string} query - User's natural language query
 * @returns {Object} Search strategy with type, keywords, functionName, etc.
 */
function analyzeQuery(query) {
    const strategy = {
        type: 'general',
        keywords: [],
        functionName: null,
        isCallSearch: false,
        isUsageSearch: false
    };
    
    const lowerQuery = query.toLowerCase();
    
    // Check for call/usage patterns
    for (const pattern of CALL_PATTERNS) {
        const match = query.match(pattern);
        if (match) {
            strategy.functionName = match[1];
            strategy.isCallSearch = lowerQuery.includes('call');
            strategy.isUsageSearch = lowerQuery.includes('usage') || lowerQuery.includes('reference');
            strategy.type = 'function_search';
            return strategy;
        }
    }
    
    // Extract code-like terms (snake_case, camelCase, UPPER_CASE)
    const codeTerms = query.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}(?:_[a-zA-Z0-9_]+)*|[a-z]+(?:[A-Z][a-z]+)+/g) || [];
    
    // Extract general words, filtering stop words
    const words = query
        .toLowerCase()
        .replace(/[^\w\s_-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    
    // Combine and dedupe keywords
    strategy.keywords = [...new Set([...codeTerms, ...words])].slice(0, 10);
    
    // If we found exactly one code term, treat it as a function search
    if (codeTerms.length === 1 && codeTerms[0].length > 3) {
        strategy.functionName = codeTerms[0];
        strategy.type = 'function_search';
    }
    
    return strategy;
}

/**
 * Execute search based on analyzed strategy
 * @param {GrepIndex} index - The grep index to search
 * @param {Object} strategy - Search strategy from analyzeQuery
 * @param {Object} options - Additional options
 * @returns {Array} Search results
 */
function executeSearch(index, strategy, options = {}) {
    const { log = () => {}, maxResults = 50 } = options;
    const { dedupeAndRank } = require('./search-utils');
    let results = [];
    
    // Function-specific search
    if (strategy.type === 'function_search' && strategy.functionName) {
        log(`Searching for function: ${strategy.functionName}`);
        
        if (strategy.isUsageSearch) {
            const usageResults = index.searchSymbolUsages(strategy.functionName, { maxResults: maxResults * 2 });
            results = usageResults.results;
        } else if (strategy.isCallSearch) {
            const callResults = index.searchFunctionCalls(strategy.functionName, { maxResults: maxResults * 2 });
            results = callResults.results;
        } else {
            // Try call search first, fall back to literal
            const callResults = index.searchFunctionCalls(strategy.functionName, { maxResults: 50 });
            if (callResults.results.length > 0) {
                results = callResults.results;
            } else {
                const literalResults = index.searchLiteral(strategy.functionName, { 
                    wholeWord: true, 
                    maxResults: maxResults * 2
                });
                results = literalResults.results;
            }
        }
        log(`Found ${results.length} results`);
    }
    
    // Keyword search fallback
    if (results.length === 0 && strategy.keywords.length > 0) {
        log(`Keyword search: ${strategy.keywords.join(', ')}`);
        
        for (const keyword of strategy.keywords.slice(0, 5)) {
            const literalResults = index.searchLiteral(keyword, { 
                caseSensitive: false, 
                maxResults: 30 
            });
            results.push(...literalResults.results);
            
            if (results.length >= maxResults * 2) break;
        }
        
        log(`Found ${results.length} raw results`);
    }
    
    // Rank results (prioritizes Java/TAL, filters docs)
    const searchTerm = strategy.functionName || strategy.keywords.join(' ');
    results = dedupeAndRank(results, searchTerm, maxResults);
    log(`After ranking: ${results.length} results`);
    
    return results;
}

module.exports = {
    analyzeQuery,
    executeSearch,
    STOP_WORDS,
    CALL_PATTERNS
};
