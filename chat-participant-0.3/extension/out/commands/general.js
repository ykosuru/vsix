/**
 * General query handler - handles queries without specific command
 */

const { formatResultsForLLM, formatFileReferences } = require('../search/search-utils');
const { analyzeQuery, executeSearch } = require('../search/query-analyzer');
const { streamResponse } = require('../llm/copilot');
const prompts = require('../prompts/general');

/**
 * Handle general query (no specific command)
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex, token } = ctx;
    
    response.progress('Analyzing query...');
    const searchStrategy = analyzeQuery(query);
    outputChannel.appendLine(`Search strategy: ${JSON.stringify(searchStrategy)}`);
    
    response.progress('Searching codebase...');
    const searchResults = executeSearch(grepIndex, searchStrategy, {
        log: (msg) => outputChannel.appendLine(msg)
    });
    
    if (searchResults.length === 0) {
        response.markdown(`No matches found. Try:\n- Different keywords\n- \`@astra /find <term>\`\n- \`@astra /help\` for commands`);
        return;
    }
    
    response.progress('Analyzing code...');
    const formattedContext = formatResultsForLLM(searchResults, workspaceRoot);
    const userPrompt = prompts.buildUserPrompt(query, searchStrategy, formattedContext);
    
    await streamResponse(prompts.systemPrompt, userPrompt, response, outputChannel, token);
    response.markdown(formatFileReferences(searchResults, workspaceRoot));
}

module.exports = { handle };
