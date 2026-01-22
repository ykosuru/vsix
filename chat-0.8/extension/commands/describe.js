/**
 * /describe command - describe code functionality
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are an expert code analyst. Your task is to describe how specific code works.
Focus on:
- Purpose and functionality
- Key functions and their roles
- Data flow and dependencies
- Important implementation details
Reference specific files and line numbers.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /describe <function or module>\`

**Examples:**
- \`@astra /describe parseConfig\`
- \`@astra /describe partition pruning\`
- \`@astra /describe user authentication\``);
        return;
    }
    
    const userPrompt = `Describe how this works in the codebase: ${query}

Provide:
1. Overview of what it does
2. Key components/functions involved
3. How they work together
4. Important implementation details

Reference specific source files and functions.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
