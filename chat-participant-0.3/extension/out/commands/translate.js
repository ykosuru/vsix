/**
 * /translate command handler - Translate TAL to Java
 */

const { formatResultsForLLM, formatFileReferences, extractKeywords, dedupeAndRank } = require('../search/search-utils');
const { streamResponse } = require('../llm/copilot');
const prompts = require('../prompts/translate');

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
 * Handle /translate command
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex, token } = ctx;
    
    const searchTerm = query.trim() || 'PROC';
    
    response.progress(`Finding TAL code: ${searchTerm}...`);
    const results = searchCode(grepIndex, searchTerm, 30);
    
    if (results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\`\n\nTry:\n- \`@astra /translate PROC-NAME\`\n- \`@astra /translate FEDIN\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    const userPrompt = prompts.buildUserPrompt(context);
    
    await streamResponse(prompts.systemPrompt, userPrompt, response, outputChannel, token);
    response.markdown(formatFileReferences(results, workspaceRoot));
}

module.exports = { handle };
