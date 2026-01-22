/**
 * Search utilities - common patterns for search operations
 */

const path = require('path');
const config = require('../config.json');

/**
 * Deduplicate results by file:line key
 * @param {Array} results - Search results array
 * @returns {Array} Deduplicated results
 */
function dedupeResults(results) {
    const seen = new Set();
    return results.filter(r => {
        const key = `${r.file}:${r.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Dedupe and limit results
 * @param {Array} results - Search results
 * @param {number} maxResults - Maximum results to return
 * @returns {Array} Deduplicated and limited results
 */
function dedupeAndLimit(results, maxResults = config.search.maxResults) {
    return dedupeResults(results).slice(0, maxResults);
}

/**
 * Group results by file
 * @param {Array} results - Search results
 * @returns {Map} Map of filePath -> results[]
 */
function groupByFile(results) {
    const byFile = new Map();
    for (const result of results) {
        const existing = byFile.get(result.file) || [];
        existing.push(result);
        byFile.set(result.file, existing);
    }
    return byFile;
}

/**
 * Format a single code snippet with context
 * @param {Object} result - Search result with context
 * @returns {string} Formatted snippet
 */
function formatSnippet(result) {
    let snippet = '';
    if (result.context?.before) {
        snippet += result.context.before.join('\n') + '\n';
    }
    snippet += result.matchLine || result.content || '';
    if (result.context?.after) {
        snippet += '\n' + result.context.after.join('\n');
    }
    return snippet.trim();
}

/**
 * Format results for LLM consumption
 * @param {Array} results - Search results
 * @param {string} workspaceRoot - Workspace root path
 * @returns {string} Formatted markdown context
 */
function formatResultsForLLM(results, workspaceRoot) {
    const byFile = groupByFile(results);
    const sections = [];
    
    for (const [file, fileResults] of byFile) {
        const relativePath = path.relative(workspaceRoot, file);
        const ext = path.extname(file).slice(1) || 'txt';
        
        let section = `### ${relativePath}\n\n`;
        
        for (const result of fileResults.slice(0, config.search.maxFilesPerQuery)) {
            const snippet = formatSnippet(result);
            let locationInfo = `Line ${result.line}`;
            if (result.enclosingFunction) {
                locationInfo += ` in \`${result.enclosingFunction.name}()\``;
            }
            section += `**${locationInfo}:**\n\`\`\`${ext}\n${snippet}\n\`\`\`\n\n`;
        }
        
        sections.push(section);
    }
    
    let combined = sections.join('\n');
    if (combined.length > config.llm.maxContextLength) {
        combined = combined.slice(0, config.llm.maxContextLength) + '\n\n... (truncated)';
    }
    
    return combined;
}

/**
 * Format file references for response footer
 * @param {Array} results - Search results
 * @param {string} workspaceRoot - Workspace root path
 * @returns {string} Formatted file references
 */
function formatFileReferences(results, workspaceRoot) {
    const uniqueFiles = [...new Set(results.map(r => r.file))].slice(0, 10);
    let output = '\n\n---\n**📁 Source files:**\n';
    for (const file of uniqueFiles) {
        const relativePath = path.relative(workspaceRoot, file);
        output += `- \`${relativePath}\`\n`;
    }
    return output;
}

/**
 * Extract keywords from search term
 * @param {string} searchTerm - Raw search term
 * @param {number} maxKeywords - Maximum keywords to extract
 * @returns {Array} Array of keywords
 */
function extractKeywords(searchTerm, maxKeywords = config.search.maxKeywords) {
    return searchTerm
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, maxKeywords);
}

/**
 * Deep search across entire workspace for a topic
 * Searches using multiple strategies for comprehensive results
 * @param {GrepIndex} grepIndex - The grep index
 * @param {string} topic - Topic to search for
 * @param {Object} options - Search options
 * @returns {Array} Combined, deduplicated results
 */
function searchWorkspace(grepIndex, topic, options = {}) {
    const { maxResults = 100, includeContext = true, contextLines = 3 } = options;
    
    let allResults = [];
    
    // Strategy 1: Exact phrase search
    const exactResults = grepIndex.searchLiteral(topic, {
        caseSensitive: false,
        maxResults: Math.floor(maxResults / 3),
        includeContext
    });
    allResults.push(...exactResults.results);
    
    // Strategy 2: Individual keyword search
    const keywords = extractKeywords(topic, 10);
    for (const keyword of keywords) {
        if (keyword.length < 3) continue;
        
        // Literal search
        const literalResults = grepIndex.searchLiteral(keyword, {
            caseSensitive: false,
            maxResults: Math.floor(maxResults / keywords.length),
            includeContext
        });
        allResults.push(...literalResults.results);
        
        // Function call search
        const callResults = grepIndex.searchFunctionCalls(keyword, {
            maxResults: Math.floor(maxResults / keywords.length / 2)
        });
        allResults.push(...callResults.results);
    }
    
    // Strategy 3: Pattern variations (camelCase, snake_case, etc.)
    const variations = generateSearchVariations(topic);
    for (const variant of variations.slice(0, 5)) {
        const variantResults = grepIndex.searchLiteral(variant, {
            caseSensitive: false,
            maxResults: 10,
            includeContext
        });
        allResults.push(...variantResults.results);
    }
    
    // Deduplicate and sort by relevance
    return dedupeAndRank(allResults, topic, maxResults);
}

/**
 * Generate search variations for a topic
 * @param {string} topic - Original topic
 * @returns {Array} Variations to search
 */
function generateSearchVariations(topic) {
    const variations = new Set();
    const words = topic.toLowerCase().split(/\s+/);
    
    // Original
    variations.add(topic);
    
    // snake_case
    variations.add(words.join('_'));
    
    // camelCase
    if (words.length > 1) {
        variations.add(words[0] + words.slice(1).map(w => 
            w.charAt(0).toUpperCase() + w.slice(1)
        ).join(''));
    }
    
    // PascalCase
    variations.add(words.map(w => 
        w.charAt(0).toUpperCase() + w.slice(1)
    ).join(''));
    
    // UPPER_CASE
    variations.add(words.join('_').toUpperCase());
    
    // kebab-case
    variations.add(words.join('-'));
    
    // No spaces
    variations.add(words.join(''));
    
    return Array.from(variations);
}

/**
 * Deduplicate and rank results by relevance
 * ONLY returns Java/TAL files when available - completely excludes docs
 * @param {Array} results - Raw results
 * @param {string} topic - Original search topic
 * @param {number} maxResults - Max results to return
 * @returns {Array} Ranked, deduplicated results
 */
function dedupeAndRank(results, topic, maxResults) {
    const seen = new Map();
    const topicLower = topic.toLowerCase();
    const keywords = topicLower.split(/\s+/);
    
    // PRIMARY: Java and TAL only
    const primaryCode = new Set(['.java', '.tal']);
    
    // SECONDARY: Other source code
    const secondaryCode = new Set([
        '.cbl', '.cob', '.cobol', '.pli',
        '.c', '.cpp', '.h', '.hpp', '.cs',
        '.py', '.js', '.ts', '.tsx', '.jsx',
        '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala',
        '.sql', '.pl', '.pm'
    ]);
    
    // EXCLUDE: Never return these when code exists
    const docExtensions = new Set([
        '.md', '.txt', '.json', '.yaml', '.yml', '.xml',
        '.html', '.css', '.svg', '.ini', '.cfg', '.conf',
        '.properties', '.toml', '.gitignore', '.env'
    ]);
    
    // Separate results by file type
    const primaryResults = [];
    const secondaryResults = [];
    const docResults = [];
    
    for (const result of results) {
        const key = `${result.file}:${result.line}`;
        
        if (!seen.has(key)) {
            seen.set(key, true);
            
            const ext = '.' + (result.file.split('.').pop() || '').toLowerCase();
            const matchLine = (result.matchLine || '').toLowerCase();
            
            // Calculate relevance score
            let score = 0;
            if (matchLine.includes(topicLower)) score += 10;
            for (const kw of keywords) {
                if (matchLine.includes(kw)) score += 3;
            }
            
            // Definition bonus
            if (/^\s*(PROC|SUBPROC)\s+\w+/i.test(result.matchLine)) score += 25;
            if (/^\s*(public|private|protected)\s+/i.test(result.matchLine)) score += 20;
            if (/^\s*(class|interface|function|def)\s+/i.test(result.matchLine)) score += 15;
            
            const scored = { ...result, score, ext };
            
            // Categorize by file type
            if (primaryCode.has(ext)) {
                primaryResults.push(scored);
            } else if (secondaryCode.has(ext)) {
                secondaryResults.push(scored);
            } else if (!docExtensions.has(ext)) {
                // Unknown extension - treat as secondary
                secondaryResults.push(scored);
            } else {
                docResults.push(scored);
            }
        }
    }
    
    // Return ONLY primary (Java/TAL) if available
    if (primaryResults.length > 0) {
        return primaryResults
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
    }
    
    // Fall back to secondary code if no Java/TAL
    if (secondaryResults.length > 0) {
        return secondaryResults
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
    }
    
    // Only return docs if no code at all
    return docResults
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
}

/**
 * Format source list for display
 * @param {Array} fileList - List of file metadata
 * @returns {string} Formatted source list
 */
function formatSourceList(fileList) {
    return fileList.map(f => `\`${f.path}\`, lines ${f.startLine}-${f.endLine}`).join('; ');
}

module.exports = {
    dedupeResults,
    dedupeAndLimit,
    groupByFile,
    formatSnippet,
    formatResultsForLLM,
    formatFileReferences,
    extractKeywords,
    searchWorkspace,
    generateSearchVariations,
    dedupeAndRank,
    formatSourceList
};
