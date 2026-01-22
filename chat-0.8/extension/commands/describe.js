/**
 * /describe command - describe code functionality with workspace context
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are an expert code analyst. Describe how the specified code works.
Focus on:
- Purpose and functionality
- Key functions and their roles  
- Data flow and dependencies
- Important implementation details
Reference specific files and line numbers from the code provided.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /describe <function or module>\`

**Examples:**
- \`@astra /describe partition pruning\`
- \`@astra /describe ExecFindPartition\`
- \`@astra /describe query optimizer\``);
        return;
    }
    
    response.progress('Searching workspace...');
    const { context, files, totalLines } = await getWorkspaceContext(query, {
        maxFiles: 20,
        maxLinesPerFile: 500
    });
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"`);
        return;
    }
    
    response.markdown(`📄 **Analyzing ${files.length} files** (${totalLines.toLocaleString()} lines)\n\n`);
    
    const userPrompt = `Describe how this works: ${query}

## Source Code
${context}

Provide:
1. Overview of what it does
2. Key components/functions
3. How they work together
4. Important implementation details

Reference specific files and line numbers.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    const sources = files.slice(0, 8).map(f => `\`${f.path}\``).join(', ');
    response.markdown(`\n\n---\n**Sources:** ${sources}`);
}

module.exports = { handle };
