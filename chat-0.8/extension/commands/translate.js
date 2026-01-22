/**
 * /translate command - translate legacy code
 */

const { streamResponse } = require('../llm/copilot');

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
- \`@astra /translate legacy_payment_check\``);
        return;
    }
    
    const userPrompt = `Translate this code to modern equivalent: ${query}

Provide:
1. Original code analysis
2. Translated code with comments
3. Notes on any behavioral differences
4. Test cases to verify equivalence`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
