/**
 * /fediso command handler - Uplift to Fed ISO 20022
 */

const { formatResultsForLLM, formatFileReferences, dedupeAndLimit } = require('../search/search-utils');
const { streamResponse } = require('../llm/copilot');
const prompts = require('../prompts/fediso');

/**
 * Handle /fediso command
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex, token } = ctx;
    
    const searchTerm = query.trim() || 'FEDIN FED wire';
    
    response.progress(`Finding Fed wire code: ${searchTerm}...`);
    
    // Search for Fed-related terms
    const fedTerms = ['FEDIN', 'FEDOUT', 'FED', 'wire', 'transfer', searchTerm];
    let results = [];
    
    for (const term of fedTerms) {
        const termResults = grepIndex.searchLiteral(term, { 
            caseSensitive: false, 
            maxResults: 15 
        });
        results.push(...termResults.results);
    }
    
    // Dedupe and limit
    results = dedupeAndLimit(results, 40);
    
    if (results.length === 0) {
        response.markdown(`No Fed wire code found.\n\nTry:\n- \`@astra /find FEDIN\`\n- \`@astra /fediso wire message\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    const userPrompt = prompts.buildUserPrompt(context);
    
    await streamResponse(prompts.systemPrompt, userPrompt, response, outputChannel, token);
    response.markdown(formatFileReferences(results, workspaceRoot));
}

module.exports = { handle };
