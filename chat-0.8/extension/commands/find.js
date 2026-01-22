/**
 * /find command - search for code
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are a code search expert. Summarize the search results.
For each relevant file, show:
- File path and key line numbers
- Brief description of what the code does
- Code snippet showing the most relevant part

Group results by functionality. Prioritize source code over documentation.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /find <search term>\`

**Examples:**
- \`@astra /find partprune\`
- \`@astra /find ExecFindPartition\`
- \`@astra /find "partition bounds"\``);
        return;
    }
    
    response.progress('Searching workspace...');
    const { context, files, totalLines, searchTerms } = await getWorkspaceContext(query, {
        maxFiles: 15,
        maxLinesPerFile: 200
    });
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matches found for:** "${query}"

**Searched for:** ${searchTerms?.join(', ') || query}`);
        return;
    }
    
    response.markdown(`🔍 **Found ${files.length} files matching "${query}"**\n\n`);
    
    const userPrompt = `Summarize the search results for: ${query}

## Files Found
${context}

For each relevant file:
1. Show the file path
2. Identify the most relevant lines/functions
3. Briefly explain what the code does
4. Show a key code snippet

Focus on the most relevant matches.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
