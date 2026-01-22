/**
 * /requirements (and /extract) command handler - Extract business requirements
 */

const { formatResultsForLLM, formatFileReferences, extractKeywords, dedupeAndLimit } = require('../search/search-utils');
const { streamResponse } = require('../llm/copilot');
const prompts = require('../prompts/requirements');

/**
 * Search code using grep index
 */
function searchCode(grepIndex, searchTerm, maxResults = 30) {
    const keywords = extractKeywords(searchTerm);
    let results = [];
    
    for (const keyword of keywords.slice(0, 5)) {
        const literalResults = grepIndex.searchLiteral(keyword, { 
            caseSensitive: false, 
            maxResults: Math.floor(maxResults / keywords.length) + 10
        });
        results.push(...literalResults.results);
    }
    
    return dedupeAndLimit(results, maxResults);
}

/**
 * Handle /requirements command
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex, token } = ctx;
    
    const searchTerm = query.trim();
    if (!searchTerm) {
        response.markdown('**Usage:** `@astra /requirements <topic>`\n\n**Examples:**\n- `@astra /requirements wire transfer validation`\n- `@astra /extract payment processing`');
        return;
    }
    
    response.progress(`Extracting requirements for: ${searchTerm}...`);
    const results = searchCode(grepIndex, searchTerm, 50);
    
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
