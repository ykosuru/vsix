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
    
    // Show files being used
    let filesUsed = `📄 **Analyzing ${files.length} files** (${totalLines.toLocaleString()} lines)\n\n`;
    filesUsed += `<details><summary>📂 Files analyzed</summary>\n\n`;
    for (const f of files.slice(0, 25)) {
        filesUsed += `- \`${f.path}\`\n`;
    }
    if (files.length > 25) {
        filesUsed += `- *...and ${files.length - 25} more*\n`;
    }
    filesUsed += `\n</details>\n\n`;
    response.markdown(filesUsed);
    
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
}

module.exports = { handle };
