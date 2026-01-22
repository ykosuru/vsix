/**
 * General query handler - passes directly to Copilot
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are an expert code analyst with access to the user's workspace.
Analyze the codebase to answer the user's question.
Reference specific files, functions, and line numbers when possible.
Be thorough but concise.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Ask me about your code!**

**Examples:**
- \`@astra how does authentication work?\`
- \`@astra explain the payment flow\`
- \`@astra /describe UserService\``);
        return;
    }
    
    const userPrompt = `Question about this codebase: ${query}

Please analyze the relevant source files and provide a detailed answer with specific code references.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
