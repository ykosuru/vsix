/**
 * /requirements command - extract business requirements as Gherkin
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are a requirements analyst. Extract business requirements from code as Gherkin scenarios.

Format:
Feature: <feature name>
  Scenario: <scenario name>
    Given <precondition>
    When <action>
    Then <expected result>

Include edge cases and error scenarios. Reference source files.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /requirements <feature>\`

**Examples:**
- \`@astra /requirements user login\`
- \`@astra /requirements partition pruning\`
- \`@astra /requirements data validation\``);
        return;
    }
    
    const userPrompt = `Extract business requirements for: ${query}

Analyze the code and generate Gherkin scenarios that capture:
1. Happy path scenarios
2. Edge cases
3. Error handling scenarios
4. Validation rules

Reference the source files where each requirement is implemented.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
