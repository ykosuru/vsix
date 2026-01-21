/**
 * AstraCode Query Classification
 * Query type detection and classification utilities
 */

const { log, debugLog } = require('./logging');

// ============================================================
// Query Type Detection
// ============================================================

/**
 * Check if query is an overview/high-level query
 */
function isOverviewQuery(text) {
    const normalizedText = text.trim().replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+|would\s+you\s+)/i, '').trim();
    
    const overviewPatterns = [
        // Direct overview requests
        /^(?:explain|describe|summarize|overview|analyze)\s+(?:the\s+)?(?:high[\s-]?level\s+)?(?:code|codebase|project|files?|attached|this)/i,
        /^(?:explain|describe|summarize)\s+(?:the\s+)?(?:high[\s-]?level\s+)?(?:functionality|structure|architecture|purpose)/i,
        /^(?:what\s+(?:does|is)\s+(?:this|the)\s+(?:code|codebase|project)|give\s+(?:me\s+)?(?:an?\s+)?overview)/i,
        /^(?:how\s+does\s+(?:this|the)\s+(?:code|codebase|project)\s+work)/i,
        
        // Documentation requests
        /^(?:generate\s+)?(?:full\s+)?(?:doc|documentation|deepwiki|document(?:ation)?)/i,
        
        // General structure questions
        /^(?:what\s+are\s+the\s+main|list\s+(?:the\s+)?(?:main|key))\s+(?:component|module|feature|part)/i,
        /^(?:walk\s+me\s+through|tour\s+of)\s+(?:the\s+)?(?:code|codebase)/i,
        /^(?:give\s+(?:me\s+)?a(?:n?\s+)?)?(?:tour|walkthrough|overview)\s+of/i,
        
        // Simple overview triggers
        /^explain\s+(?:this|these|the)\s+(?:code|files?)/i,
        /^what\s+does\s+this\s+(?:code\s+)?do/i,
        /^describe\s+this/i
    ];
    
    return overviewPatterns.some(p => p.test(normalizedText));
}

/**
 * Check if query is a domain-specific query
 */
function isDomainQuery(text) {
    const normalizedText = text.toLowerCase();
    
    // Domain patterns - specific feature/functionality questions
    const domainPatterns = [
        // Feature/functionality questions
        /how\s+(?:does|is)\s+\w+\s+(?:implement|work|handled|processed)/i,
        /where\s+(?:does|is)\s+\w+\s+(?:implement|handled|defined)/i,
        /what\s+(?:functions?|methods?|code)\s+(?:handles?|implements?|processes?)/i,
        
        // Flow/trace questions
        /(?:trace|follow|track)\s+(?:the\s+)?(?:flow|path|execution)/i,
        /(?:how|what)\s+(?:does|is)\s+the\s+(?:flow|process)/i,
        
        // Specific implementation questions
        /(?:show|find|locate)\s+(?:me\s+)?(?:the\s+)?(?:code|implementation|function)/i,
        /(?:where|how)\s+(?:is|does)\s+(?:the\s+)?\w+\s+(?:validation|processing|handling)/i
    ];
    
    return domainPatterns.some(p => p.test(normalizedText));
}

/**
 * Regex-based fallback classification
 */
function classifyQueryFallback(text) {
    debugLog('CLASSIFY', 'Using regex fallback classification', {
        query: text.substring(0, 80)
    });
    
    const isOverview = isOverviewQuery(text);
    const isDomain = isDomainQuery(text);
    
    if (isOverview) {
        return 'overview';
    }
    
    if (isDomain) {
        return 'domain';
    }
    
    // Check for specific patterns
    const specificPatterns = [
        /what\s+does\s+\w+\s+do/i,
        /explain\s+(?:the\s+)?\w+\s+function/i,
        /how\s+does\s+\w+\s+work/i,
        /find\s+(?:the\s+)?\w+/i,
        /show\s+me\s+\w+/i
    ];
    
    if (specificPatterns.some(p => p.test(text))) {
        return 'specific';
    }
    
    return 'general';
}

/**
 * Decompose a compound question into sub-questions
 */
function decomposeQuestion(question) {
    const subQuestions = [];
    
    // Check for explicit list markers
    const numberedMatch = question.match(/^\d+[.)]\s*(.+)$/gm);
    if (numberedMatch && numberedMatch.length > 1) {
        return numberedMatch.map(m => m.replace(/^\d+[.)]\s*/, '').trim());
    }
    
    // Check for bullet points
    const bulletMatch = question.match(/^[-*â€¢]\s*(.+)$/gm);
    if (bulletMatch && bulletMatch.length > 1) {
        return bulletMatch.map(m => m.replace(/^[-*â€¢]\s*/, '').trim());
    }
    
    // Check for "and" conjunctions that create multiple questions
    const andPattern = /(.+?)\s+and\s+(?:also\s+)?(.+)/i;
    const andMatch = question.match(andPattern);
    if (andMatch) {
        const first = andMatch[1].trim();
        const second = andMatch[2].trim();
        
        // Only split if both parts look like questions
        const questionWords = ['what', 'how', 'where', 'why', 'when', 'which', 'who', 'show', 'list', 'find', 'explain'];
        const firstLooksLikeQuestion = questionWords.some(w => first.toLowerCase().startsWith(w));
        const secondLooksLikeQuestion = questionWords.some(w => second.toLowerCase().startsWith(w));
        
        if (firstLooksLikeQuestion && secondLooksLikeQuestion) {
            subQuestions.push(first);
            subQuestions.push(second);
            return subQuestions;
        }
    }
    
    // Check for "?" multiple questions
    const questionMarks = question.split('?').filter(q => q.trim().length > 10);
    if (questionMarks.length > 1) {
        return questionMarks.map(q => q.trim() + '?');
    }
    
    // Single question
    return [question.trim()];
}

/**
 * Extract search keywords from query
 */
function extractSearchKeywords(query) {
    // Remove common stop words and extract meaningful terms
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'up', 'about', 'into', 'over', 'after', 'this', 'that',
        'these', 'those', 'what', 'which', 'who', 'whom', 'whose', 'where',
        'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
        'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
        'same', 'so', 'than', 'too', 'very', 'just', 'but', 'and', 'or',
        'if', 'then', 'because', 'as', 'until', 'while', 'me', 'my', 'i',
        'you', 'your', 'we', 'our', 'they', 'their', 'it', 'its', 'show',
        'tell', 'find', 'get', 'explain', 'describe', 'list'
    ]);
    
    // Extract words
    const words = query
        .toLowerCase()
        .replace(/[^a-z0-9_\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    
    // Also extract camelCase/snake_case identifiers
    const identifiers = query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
    const filteredIdentifiers = identifiers
        .filter(id => id.length > 3 && !stopWords.has(id.toLowerCase()));
    
    // Combine and deduplicate
    const allKeywords = [...new Set([...words, ...filteredIdentifiers.map(id => id.toLowerCase())])];
    
    return allKeywords;
}

/**
 * Determine boost factors based on query type
 */
function getQueryBoostFactors(query, queryType) {
    // Default boosts
    const boosts = {
        sym: 1.0,      // Symbol index
        tri: 1.0,      // Trigram index
        vec: 1.0,      // Vector index
        sum: 1.0,      // Summary index
        file: 1.0      // File name matches
    };
    
    const lowerQuery = query.toLowerCase();
    
    // Adjust based on query type
    switch (queryType) {
        case 'overview':
            boosts.sum = 2.5;
            boosts.file = 2.0;
            boosts.sym = 0.5;
            break;
            
        case 'domain':
            boosts.sum = 2.0;
            boosts.sym = 1.5;
            boosts.tri = 1.2;
            break;
            
        case 'specific':
            boosts.sym = 2.0;
            boosts.tri = 1.5;
            boosts.sum = 0.8;
            break;
            
        case 'general':
        default:
            // Keep defaults
            break;
    }
    
    // Additional pattern-based adjustments
    if (/(?:concept|understand|how|why)/i.test(query)) {
        boosts.sum *= 1.3;
        boosts.vec *= 1.2;
    }
    
    if (/(?:find|search|locate|where)/i.test(query)) {
        boosts.tri *= 1.3;
        boosts.sym *= 1.2;
    }
    
    if (/(?:function|method|class|struct)/i.test(query)) {
        boosts.sym *= 1.5;
    }
    
    if (/(?:file|module|directory)/i.test(query)) {
        boosts.file *= 2.0;
    }
    
    return boosts;
}

/**
 * Check if response indicates an LLM error
 */
function isLlmErrorResponse(response) {
    if (!response) return false;
    
    const errorPatterns = [
        /^âš ï¸\s*\*\*LLM Error\*\*/i,
        /^âš ï¸\s*\*\*Model Error\*\*/i,
        /API\s+(?:key|error|unavailable)/i,
        /rate\s+limit/i,
        /no\s+(?:LLM|model)\s+available/i
    ];
    
    return errorPatterns.some(p => p.test(response));
}

module.exports = {
    // Primary export - the only function currently used by extension.js
    extractSearchKeywords,
    
    // Kept for potential future use or external consumers
    isOverviewQuery,
    isDomainQuery,
    classifyQueryFallback,
    decomposeQuestion,
    getQueryBoostFactors,
    isLlmErrorResponse
};
