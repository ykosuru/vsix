/**
 * /find command - search for code
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are a code search expert. Find relevant code in the workspace.
For each match, show:
- File path
- Line number
- Code snippet with context
- Brief explanation of relevance

Group results by file. Prioritize source code over documentation.`;

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
    
    const userPrompt = `Search the codebase for: ${query}

Find all relevant occurrences and show:
1. File path and line number
2. Code snippet (3-5 lines of context)
3. Brief note on what this code does

Prioritize:
- Source files (.c, .h, .java, .py) over docs
- Function definitions over references
- Key implementation files over tests`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
