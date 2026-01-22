/**
 * /deepwiki command - generate wiki-style documentation
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are a technical documentation expert. Generate comprehensive wiki-style documentation.

Include:
- Overview section with purpose
- Architecture diagram using Mermaid syntax
- Key components with descriptions
- Data flow explanation
- Function documentation with signatures
- Error handling
- Related topics

Use markdown with headers, code blocks, and bullet points.
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
    
    response.progress('Searching workspace...');
    const { context, files, totalLines } = await getWorkspaceContext(query, {
        maxFiles: 25,
        maxLinesPerFile: 400,
        maxTotalLines: 5000
    });
    
    if (!context || files.length === 0) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"`);
        return;
    }
    
    response.markdown(`📄 **Generating documentation from ${files.length} files** (${totalLines.toLocaleString()} lines)\n\n`);
    
    const userPrompt = `Generate comprehensive wiki documentation for: ${query}

## Source Code
${context}

Create documentation with:
1. **Overview** - What it is and why it exists
2. **Architecture** - Mermaid diagram showing components
3. **Key Components** - Each major piece with its role
4. **Data Flow** - How data moves through the system
5. **API/Functions** - Key functions with signatures
6. **Error Handling** - How errors are managed
7. **Related Topics** - Links to related concepts

Reference specific source files and line numbers throughout.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
