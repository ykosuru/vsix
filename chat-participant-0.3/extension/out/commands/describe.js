/**
 * /describe command handler - Describe functionality of code
 */

const { formatResultsForLLM, formatFileReferences, extractKeywords, dedupeAndRank } = require('../search/search-utils');
const { streamResponse } = require('../llm/copilot');
const prompts = require('../prompts/describe');

/**
 * Search code using grep index with ranking
 */
function searchCode(grepIndex, searchTerm, maxResults = 30) {
    const keywords = extractKeywords(searchTerm);
    let results = [];
    
    for (const keyword of keywords.slice(0, 5)) {
        const literalResults = grepIndex.searchLiteral(keyword, { 
            caseSensitive: false, 
            maxResults: Math.floor(maxResults / keywords.length) + 20
        });
        results.push(...literalResults.results);
    }
    
    return dedupeAndRank(results, searchTerm, maxResults);
}

/**
 * Handle /describe command
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex, token } = ctx;
    
    const searchTerm = query.trim();
    if (!searchTerm) {
        response.markdown('**Usage:** `@astra /describe <function or module>`\n\n**Examples:**\n- `@astra /describe FEDIN-PARSE`\n- `@astra /describe payment validation`');
        return;
    }
    
    response.progress(`Analyzing: ${searchTerm}...`);
    const results = searchCode(grepIndex, searchTerm, 40);
    
    if (results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    const userPrompt = prompts.buildUserPrompt(searchTerm, context);
    
    await streamResponse(prompts.systemPrompt, userPrompt, response, outputChannel, token);
    response.markdown(formatFileReferences(results, workspaceRoot));
}

module.exports = { handle };
