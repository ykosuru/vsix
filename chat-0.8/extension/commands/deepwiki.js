/**
 * /deepwiki command - generate wiki-style documentation
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are a technical documentation expert. Generate comprehensive wiki-style documentation.

Include:
- Overview section with purpose
- Architecture diagram (use Mermaid syntax)
- Key components with descriptions
- Data flow explanation
- Function/method documentation
- Error handling
- Related topics

Use markdown formatting with headers, code blocks, and bullet points.
Reference specific source files with file:line format.`;

async function handle(ctx) {
    const { query, response, outputChannel, token } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /deepwiki <topic>\`

**Examples:**
- \`@astra /deepwiki partition pruning\`
- \`@astra /deepwiki query optimizer\`
- \`@astra /deepwiki transaction handling\``);
        return;
    }
    
    const userPrompt = `Generate comprehensive wiki documentation for: ${query}

Include:
1. **Overview** - What it is and why it exists
2. **Architecture** - Mermaid diagram showing components
3. **Key Components** - Each major piece with its role
4. **Data Flow** - How data moves through the system
5. **API/Functions** - Key functions with signatures and descriptions
6. **Error Handling** - How errors are managed
7. **Related Topics** - Links to related concepts

Reference specific source files throughout.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
