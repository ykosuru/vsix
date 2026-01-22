/**
 * /fediso command - standards compliance analysis
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are a standards compliance expert. Analyze code for compliance.
Focus on data formats, validation rules, and processing requirements.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /fediso <component>\``);
        return;
    }
    
    response.progress('Searching workspace...');
    const { context, files } = await getWorkspaceContext(query);
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"`);
        return;
    }
    
    response.markdown(`📄 **Analyzing ${files.length} files**\n\n`);
    
    const userPrompt = `Analyze standards compliance for: ${query}

## Source Code
${context}

Check for:
1. Data format compliance
2. Validation completeness
3. Required fields handling
4. Error code standards
5. Recommendations`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
