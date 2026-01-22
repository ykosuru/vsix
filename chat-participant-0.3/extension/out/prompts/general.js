/**
 * Prompts for general queries (no specific command)
 */

const systemPrompt = `You are AstraCode, an expert code analyst. Answer questions about codebases clearly and concisely.

Guidelines:
- Answer the user's specific question
- Reference specific files and line numbers
- Explain code flow and relationships
- For "who calls X?" - list callers with context
- Be concise but thorough`;

/**
 * Build user prompt for general query
 * @param {string} query - User's question
 * @param {Object} strategy - Search strategy with functionName, etc.
 * @param {string} context - Formatted code context
 * @returns {string} User prompt
 */
function buildUserPrompt(query, strategy, context) {
    let prompt = `## Question
${query}

`;
    
    if (strategy.functionName) {
        prompt += `## Search Target
Function/Symbol: \`${strategy.functionName}\`

`;
    }
    
    prompt += `## Code Search Results
${context}

## Instructions
Answer the question based on the code above.`;
    
    return prompt;
}

module.exports = {
    systemPrompt,
    buildUserPrompt
};
