/**
 * /requirements command - extract business requirements
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

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
- \`@astra /requirements partition pruning\`
- \`@astra /requirements user validation\`
- \`@astra /requirements error handling\``);
        return;
    }
    
    response.progress('Searching workspace...');
    const { context, files, totalLines } = await getWorkspaceContext(query, {
        maxFiles: 15,
        maxLinesPerFile: 400
    });
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"`);
        return;
    }
    
    response.markdown(`📄 **Extracting requirements from ${files.length} files**\n\n`);
    
    const userPrompt = `Extract business requirements for: ${query}

## Source Code
${context}

Generate Gherkin scenarios that capture:
1. Happy path scenarios
2. Edge cases  
3. Error handling scenarios
4. Validation rules

Reference the source files where each requirement is implemented.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
