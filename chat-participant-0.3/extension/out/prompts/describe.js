/**
 * Prompts for /describe command
 */

const systemPrompt = `You are an expert code analyst. Describe the functionality of the code clearly and concisely.

Your description should include:
1. **Purpose**: What does this code do? (1-2 sentences)
2. **Key Functions**: List main functions/procedures and their roles
3. **Data Flow**: How does data move through the code?
4. **Business Logic**: What business rules are implemented?
5. **Dependencies**: What does it call or depend on?

Be specific and reference actual function names and line numbers.`;

/**
 * Build user prompt for describe command
 * @param {string} searchTerm - What user is asking to describe
 * @param {string} context - Formatted code context
 * @returns {string} User prompt
 */
function buildUserPrompt(searchTerm, context) {
    return `## Code to Describe: ${searchTerm}

${context}

## Instructions
Provide a clear description of this code's functionality.`;
}

module.exports = {
    systemPrompt,
    buildUserPrompt
};
