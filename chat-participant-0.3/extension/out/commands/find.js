/**
 * /find command handler - Search for code by keyword
 */

const path = require('path');
const { dedupeAndRank, groupByFile, formatSnippet, extractKeywords } = require('../search/search-utils');

/**
 * Handle /find command
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex } = ctx;
    
    const searchTerm = query.trim();
    if (!searchTerm) {
        response.markdown('**Usage:** `@astra /find <term>`\n\n**Examples:**\n- `@astra /find FEDIN`\n- `@astra /find wire transfer`\n- `@astra /find validate_payment`');
        return;
    }
    
    response.progress(`Searching for: ${searchTerm}...`);
    outputChannel.appendLine(`/find: ${searchTerm}`);
    
    // Search using multiple strategies
    const keywords = extractKeywords(searchTerm);
    let results = [];
    
    for (const keyword of keywords) {
        const literalResults = grepIndex.searchLiteral(keyword, { 
            caseSensitive: false, 
            maxResults: 50 
        });
        results.push(...literalResults.results);
    }
    
    // Dedupe and rank (prioritizes code over docs)
    results = dedupeAndRank(results, searchTerm, 50);
    
    if (results.length === 0) {
        response.markdown(`No matches found for: \`${searchTerm}\`\n\nTry:\n- Different spelling\n- Partial term\n- \`@astra /rebuild\` to refresh index`);
        return;
    }
    
    // Format results
    response.markdown(`## 🔍 Found ${results.length} matches for \`${searchTerm}\`\n\n`);
    
    const byFile = groupByFile(results);
    for (const [file, fileResults] of byFile) {
        const relativePath = path.relative(workspaceRoot, file);
        const ext = path.extname(file).slice(1) || 'txt';
        response.markdown(`### 📄 ${relativePath}\n\n`);
        
        for (const result of fileResults.slice(0, 3)) {
            const snippet = formatSnippet(result);
            response.markdown(`**Line ${result.line}:**\n\`\`\`${ext}\n${snippet}\n\`\`\`\n\n`);
        }
    }
}

module.exports = { handle };
