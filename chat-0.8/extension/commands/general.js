/**
 * General query handler - searches workspace and includes context
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are an expert code analyst. Analyze the provided source code to answer the user's question.
Reference specific files, functions, and line numbers from the code shown.
Be thorough but concise. Base your answer ONLY on the code provided below.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Ask me about your code!**

**Examples:**
- \`@astra how does authentication work?\`
- \`@astra explain partition pruning\`
- \`@astra /describe UserService\``);
        return;
    }
    
    // Search workspace for relevant files
    response.progress('Searching workspace...');
    const { context, files, totalLines, searchTerms } = await getWorkspaceContext(query);
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"

**Try:**
- More specific terms (e.g., function names, file names)
- \`@astra /find <term>\` to search for specific code`);
        return;
    }
    
    // Show what we found
    response.markdown(`📄 **Found ${files.length} files** (${totalLines.toLocaleString()} lines)\n\n`);
    
    const userPrompt = `Question: ${query}

## Source Code Context
${context}

Based on the code above, please answer the question. Reference specific files and line numbers.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Show sources
    const sources = files.slice(0, 8).map(f => `\`${f.path}\``).join(', ');
    response.markdown(`\n\n---\n**Sources:** ${sources}`);
}

module.exports = { handle };
