/**
 * /deepwiki command handler - Generate wiki-style documentation like Devin DeepWiki
 */

const path = require('path');
const { searchWorkspace, formatResultsForLLM, formatSourceList } = require('../search/search-utils');
const { streamResponse } = require('../llm/copilot');
const prompts = require('../prompts/deepwiki');

/**
 * Handle /deepwiki command
 * @param {Object} ctx - Command context
 */
async function handle(ctx) {
    const { query, response, outputChannel, workspaceRoot, grepIndex, token } = ctx;
    
    const topic = query.trim();
    if (!topic) {
        response.markdown(`**Usage:** \`@astra /deepwiki <topic>\`

**Examples:**
- \`@astra /deepwiki authentication\`
- \`@astra /deepwiki payment processing\`
- \`@astra /deepwiki Config class\`
- \`@astra /deepwiki error handling\`

**What it generates:**
- 📋 Overview with source file references
- 📊 Architecture/class diagrams (Mermaid)
- 🔧 Component documentation with methods
- 📜 Business logic and validation rules
- ⚠️ Error conditions and handling
- 🔗 Related topics to explore`);
        return;
    }
    
    response.progress(`Searching workspace for: ${topic}...`);
    outputChannel.appendLine(`/deepwiki: ${topic}`);
    
    // Deep search across entire workspace
    const results = searchWorkspace(grepIndex, topic, {
        maxResults: 100,
        includeContext: true,
        contextLines: 5
    });
    
    if (results.length === 0) {
        response.markdown(`No code found for topic: \`${topic}\`

**Try:**
- Different keywords
- Class or function name
- Module name
- \`@astra /find ${topic}\` to explore first`);
        return;
    }
    
    response.progress(`Found ${results.length} matches. Analyzing code structure...`);
    
    // Build file metadata for source references
    const fileMap = new Map();
    for (const result of results) {
        const relPath = path.relative(workspaceRoot, result.file);
        if (!fileMap.has(relPath)) {
            fileMap.set(relPath, {
                path: relPath,
                startLine: result.line,
                endLine: result.line,
                language: path.extname(result.file).slice(1) || 'txt',
                matches: 1
            });
        } else {
            const meta = fileMap.get(relPath);
            meta.startLine = Math.min(meta.startLine, result.line);
            meta.endLine = Math.max(meta.endLine, result.line);
            meta.matches++;
        }
    }
    
    // Sort by relevance (most matches first)
    const fileList = Array.from(fileMap.values())
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 15);
    
    response.progress(`Generating wiki documentation from ${fileList.length} files...`);
    
    const context = formatResultsForLLM(results, workspaceRoot);
    const userPrompt = prompts.buildUserPrompt(topic, context, fileList);
    
    await streamResponse(prompts.systemPrompt, userPrompt, response, outputChannel, token);
    
    // Append source summary
    response.markdown('\n\n---\n');
    response.markdown('**📁 Sources:** ');
    response.markdown(fileList.map(f => `\`${f.path}\`, lines ${f.startLine}-${f.endLine}`).join('; '));
}

module.exports = { handle };
