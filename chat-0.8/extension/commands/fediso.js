/**
 * /fediso command - standards compliance analysis
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are a standards compliance expert. Analyze code for compliance with industry standards.
Focus on data formats, validation rules, and processing requirements.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /fediso <component>\`

**Examples:**
- \`@astra /fediso payment processing\`
- \`@astra /fediso message validation\``);
        return;
    }
    
    const userPrompt = `Analyze standards compliance for: ${query}

Check for:
1. Data format compliance
2. Validation completeness
3. Required fields handling
4. Error code standards
5. Recommendations for improvement`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
