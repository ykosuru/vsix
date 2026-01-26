/**
 * /logic command - Extract business logic from code
 * 
 * Usage:
 * @astra /logic MT103              - Extract logic from MT103 code
 * @astra /logic payment validation - Extract validation logic
 * @astra /requirements /logic      - Extract from piped content
 * 
 * Customize output: Edit prompts/logic.md
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');
const { getSelectedSources } = require('./sources');

/**
 * Load prompt from file
 */
function loadPrompt() {
    try {
        const promptPath = path.join(__dirname, '..', 'prompts', 'logic.md');
        return fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
        // Fallback if file not found
        return `Extract all business logic including:
- Validations and preconditions
- If/then/else conditions
- Switch/case statements
- Calculations and transformations
- Exception handling
- External system interactions
- Response code handling`;
    }
}

/**
 * Read attached files
 */
async function readAttachments(references, outputChannel) {
    let content = '';
    const attachedNames = [];
    
    if (!references || references.length === 0) return { content: '', attachedNames: [] };
    
    for (const ref of references) {
        try {
            if (ref.id && typeof ref.id === 'string') {
                const uri = vscode.Uri.parse(ref.id);
                const data = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(data).toString('utf8');
                const fileName = uri.path.split('/').pop();
                
                const maxChars = 50000;
                const truncated = text.length > maxChars 
                    ? text.slice(0, maxChars) + '\n... [truncated]' 
                    : text;
                
                content += `\n### File: ${fileName}\n\`\`\`\n${truncated}\n\`\`\`\n`;
                attachedNames.push(fileName);
                outputChannel?.appendLine(`[AstraCode] Read attachment: ${fileName} (${text.length} chars)`);
            }
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
        }
    }
    
    return { content, attachedNames };
}

async function handle(ctx) {
    const { query, response, outputChannel, token, request, pipedContent: ctxPipedContent, sourceConfig } = ctx;
    
    // Check for piped content
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    // Get source configuration
    const sources = sourceConfig || getSelectedSources();
    
    // Check for attachments
    const { content: attachedContent, attachedNames } = await readAttachments(
        request?.references, 
        outputChannel
    );
    const hasAttachments = attachedContent.length > 100;
    
    if (!query.trim() && !hasPipedContent && !hasAttachments) {
        response.markdown(`**Usage:** \`@astra /logic <functionality>\`

**Extract business logic from code including:**
- Validations & preconditions
- If/then/else conditions
- Switch/case statements  
- Calculations & transformations
- External system interactions
- Response code handling
- Exception handling

**Examples:**
\`\`\`
@astra /logic MT103 processing
@astra /logic payment validation
@astra /logic OFAC screening
\`\`\`

**With attachments:**
\`\`\`
[Attach: PaymentService.java]
@astra /logic
\`\`\`

**In pipeline:**
\`\`\`
@astra /find MT103 /logic
@astra /requirements OFAC /logic
\`\`\`

**Customize output:** Edit \`prompts/logic.md\`
`);
        return;
    }
    
    // Gather content from all sources
    let allContent = '';
    let sourcesUsed = [];
    
    // 1. Piped content
    if (hasPipedContent) {
        allContent += `## Piped Content\n\n${pipedContent}\n\n`;
        sourcesUsed.push('🔗 Piped');
    }
    
    // 2. Attachments
    if (hasAttachments) {
        allContent += `## Attached Files\n\n${attachedContent}\n\n`;
        sourcesUsed.push(`📎 Attachments (${attachedNames.length})`);
    }
    
    // 3. Workspace search (if enabled and query provided)
    let files = [];
    
    if (sources.workspace !== false && query.trim()) {
        response.progress('Searching workspace for code...');
        const result = await getWorkspaceContext(query, {
            maxFiles: 25,
            maxLinesPerFile: 500,
            maxTotalLines: 8000
        });
        
        if (result.context && result.files.length > 0) {
            allContent += `## Workspace Code\n\n${result.context}\n\n`;
            files = result.files;
            sourcesUsed.push(`🔍 Workspace (${files.length} files)`);
        }
    }
    
    // Check if we have any content
    if (allContent.length < 100) {
        response.markdown(`⚠️ **No code found for:** "${query}"

Try:
- More specific search terms
- Attach files directly
- Pipe from \`/find\`: \`@astra /find ${query} /logic\`
`);
        return;
    }
    
    // Show sources being used
    response.markdown(`## 🔍 Extracting Business Logic${query ? `: ${query}` : ''}

**📥 Sources:** ${sourcesUsed.join(', ')}

`);
    
    // Show files if workspace was used
    if (files.length > 0) {
        let filesUsed = `<details><summary>📂 Files analyzed (${files.length})</summary>\n\n`;
        for (const f of files.slice(0, 25)) {
            filesUsed += `- \`${f.path}\`\n`;
        }
        if (files.length > 25) {
            filesUsed += `- *...and ${files.length - 25} more*\n`;
        }
        filesUsed += `\n</details>\n\n---\n\n`;
        response.markdown(filesUsed);
    }
    
    // Load prompt and call LLM
    const basePrompt = loadPrompt();
    
    const systemPrompt = `You are an expert code analyst specializing in extracting business logic from source code.

${basePrompt}

CRITICAL INSTRUCTIONS:
1. Extract EVERY piece of logic - be exhaustive
2. Include ALL conditional branches (if/else/switch)
3. Document ALL external system interactions
4. Capture ALL error/response code handling
5. Reference specific file:line numbers where possible
6. Do not skip edge cases or error handling paths`;

    const userPrompt = `Extract ALL business logic from the following code.

Focus on: ${query || 'all functionality'}

## Source Code

${allContent}

---

Analyze the code thoroughly and extract every piece of business logic following the output format.
Include file and line references where applicable.`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping to next command
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    response.markdown(`

---
**Next steps:**
- \`@astra /jira\` → Create Jira ticket from logic
- \`@astra /fediso\` → Map to ISO 20022
- \`@astra /gencode\` → Generate modern code
`);
}

module.exports = { handle };
