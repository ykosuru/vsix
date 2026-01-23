/**
 * /translate command - translate legacy code
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are a code translation expert specializing in legacy modernization.
Translate code while:
- Preserving business logic exactly
- Using modern idioms and patterns
- Adding clear comments
- Handling edge cases properly`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /translate <code or function name>\`

**Examples:**
- \`@astra /translate PROC-VALIDATE to Java\`
- \`@astra /translate legacy_check to Python\``);
        return;
    }
    
    response.progress('Searching workspace...');
    const { context, files } = await getWorkspaceContext(query, {
        maxFiles: 10,
        maxLinesPerFile: 300
    });
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"`);
        return;
    }
    
    response.markdown(`📄 **Found ${files.length} files**\n\n`);
    
    const userPrompt = `Translate this code: ${query}

## Source Code
${context}

Provide:
1. Original code analysis
2. Translated code with comments
3. Notes on any behavioral differences
4. Test cases to verify equivalence`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
