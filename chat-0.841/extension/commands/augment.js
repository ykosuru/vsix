/**
 * /augment command - Enhance previously generated code
 * 
 * Usage:
 * @astra /augment add exception handling              - LLM enhancement (default: history)
 * @astra /augment /source h,w add MT103 patterns      - History + workspace
 * @astra /augment /source h,a add like attachment     - History + attachments
 * 
 * Sources:
 *   llm - Pure LLM (uses only instruction, no code context)
 *   h   - History (previous response) - DEFAULT
 *   w   - Workspace search
 *   a   - Attachments
 * 
 * Customize: Edit prompts/augment.md
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

/**
 * Load prompt from file
 */
function loadPrompt() {
    try {
        const promptPath = path.join(__dirname, '..', 'prompts', 'augment.md');
        return fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
        return `Enhance the code based on the instruction. Preserve existing functionality. Output complete code.`;
    }
}

/**
 * Parse /source modifier from query
 */
function parseSourceModifier(query) {
    const sourceMatch = query.match(/^\/source\s+([a-z,]+)\s*/i);
    
    if (sourceMatch) {
        const sourceStr = sourceMatch[1].toLowerCase();
        const cleanQuery = query.slice(sourceMatch[0].length).trim();
        
        if (sourceStr === 'llm') {
            return { sources: { llm: true, h: false, w: false, a: false }, cleanQuery };
        }
        
        return {
            sources: {
                llm: false,
                h: sourceStr.includes('h'),
                w: sourceStr.includes('w'),
                a: sourceStr.includes('a')
            },
            cleanQuery
        };
    }
    
    // Default: history only
    return { sources: { llm: false, h: true, w: false, a: false }, cleanQuery: query };
}

/**
 * Extract history content
 */
function extractHistoryContent(chatContext, count = 1) {
    let content = '';
    let extracted = 0;
    
    if (!chatContext?.history?.length) return '';
    
    for (let i = chatContext.history.length - 1; i >= 0 && extracted < count; i--) {
        const turn = chatContext.history[i];
        let responseText = '';
        
        if (turn.response?.length > 0) {
            for (const part of turn.response) {
                if (part.value && typeof part.value === 'string') {
                    responseText += part.value;
                } else if (part.value?.value) {
                    responseText += part.value.value;
                }
            }
        }
        
        if (responseText.length > 50) {
            content = responseText + '\n\n---\n\n' + content;
            extracted++;
        }
    }
    
    return content;
}

/**
 * Read attachments
 */
async function readAttachments(references, outputChannel) {
    let content = '';
    const names = [];
    
    if (!references?.length) return { content: '', names: [] };
    
    for (const ref of references) {
        try {
            if (ref.id && typeof ref.id === 'string') {
                const uri = vscode.Uri.parse(ref.id);
                const data = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(data).toString('utf8');
                const fileName = uri.path.split('/').pop();
                
                content += `\n### Reference: ${fileName}\n\`\`\`\n${text.slice(0, 30000)}\n\`\`\`\n`;
                names.push(fileName);
                outputChannel?.appendLine(`[AstraCode] Read attachment: ${fileName}`);
            }
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
        }
    }
    
    return { content, names };
}

/**
 * Extract search terms from instruction
 */
function extractSearchTerms(instruction) {
    const patterns = [
        /(?:from|like|based on|learn from|patterns? from|handling from)\s+(\w+)/gi,
        /(\w+)\s+(?:patterns?|validation|handling|logic|style)/gi
    ];
    
    const terms = new Set();
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(instruction)) !== null) {
            const term = match[1].toLowerCase();
            if (!['the', 'add', 'like', 'from', 'based', 'this', 'that', 'code', 'with', 'and'].includes(term)) {
                terms.add(term);
            }
        }
    }
    
    return Array.from(terms);
}

async function handle(ctx) {
    const { query, response, outputChannel, token, chatContext, request, pipedContent } = ctx;
    
    // Parse /source modifier
    const { sources, cleanQuery } = parseSourceModifier(query);
    
    if (!cleanQuery.trim() && !pipedContent) {
        response.markdown(`**Usage:** \`@astra /augment [/source <sources>] <instruction>\`

**Enhance previously generated code.**

**Sources:**
| Source | Meaning |
|--------|---------|
| \`llm\` | Pure LLM enhancement (instruction only) |
| \`h\` | History (previous response) - **default** |
| \`w\` | Workspace (search for reference code) |
| \`a\` | Attachments (use as reference) |

**Examples:**
\`\`\`
@astra /augment add exception handling
@astra /augment refactor to clean architecture
@astra /augment /source h,w add MT103 validation patterns
@astra /augment /source h,a add retry logic like attachment
@astra /augment make production ready
\`\`\`

**Workflow:**
\`\`\`
@astra /gencode /source llm pacs.008 service
@astra /augment add validation
@astra /augment /source h,w learn error handling from MT103
@astra /augment add logging and metrics
@astra /jira epic
\`\`\`

**Customize:** Edit \`prompts/augment.md\`
`);
        return;
    }
    
    // Gather content based on sources
    let codeToAugment = pipedContent || '';
    let referenceCode = '';
    const sourcesUsed = [];
    let workspaceFiles = [];
    let attachmentNames = [];
    
    // History (default)
    if (sources.h && !pipedContent) {
        const histContent = extractHistoryContent(chatContext, 1);
        if (histContent.length > 50) {
            codeToAugment = histContent;
            sourcesUsed.push('📜 History');
        }
    }
    
    // Use piped content if available
    if (pipedContent && pipedContent.length > 50) {
        codeToAugment = pipedContent;
        sourcesUsed.push('🔗 Piped');
    }
    
    // Workspace
    if (sources.w) {
        const searchTerms = extractSearchTerms(cleanQuery);
        if (searchTerms.length > 0) {
            response.progress(`Searching workspace for: ${searchTerms.join(', ')}...`);
            const result = await getWorkspaceContext(searchTerms.join(' '), {
                maxFiles: 15,
                maxLinesPerFile: 400
            });
            if (result.context) {
                referenceCode += `## Reference Code from Workspace\n\n${result.context}\n\n`;
                workspaceFiles = result.files;
                sourcesUsed.push(`🔍 Workspace (${result.files.length} files)`);
            }
        } else {
            outputChannel?.appendLine(`[AstraCode] /augment: No search terms detected for workspace`);
        }
    }
    
    // Attachments
    if (sources.a) {
        const { content: attachContent, names } = await readAttachments(request?.references, outputChannel);
        if (attachContent.length > 50) {
            referenceCode += `## Reference Code from Attachments\n\n${attachContent}\n\n`;
            attachmentNames = names;
            sourcesUsed.push(`📎 Attachments (${names.length})`);
        }
    }
    
    // LLM only
    if (sources.llm) {
        sourcesUsed.push('🤖 LLM only');
    }
    
    // Check we have something to augment
    if (!codeToAugment && !sources.llm) {
        response.markdown(`⚠️ **No code to augment.**

Generate code first:
\`\`\`
@astra /gencode /source llm pacs.008 service
@astra /augment add exception handling
\`\`\`
`);
        return;
    }
    
    // Show sources
    response.markdown(`## 🔧 Augmenting Code

**Instruction:** ${cleanQuery}
**Sources:** ${sourcesUsed.join(', ') || 'History (default)'}

`);
    
    // Show workspace files if used
    if (workspaceFiles.length > 0) {
        let details = `<details><summary>📂 Reference files (${workspaceFiles.length})</summary>\n\n`;
        for (const f of workspaceFiles.slice(0, 15)) {
            details += `- \`${f.path}\`\n`;
        }
        details += `\n</details>\n\n`;
        response.markdown(details);
    }
    
    response.markdown(`---\n\n`);
    
    // Build prompt
    const basePrompt = loadPrompt();
    
    const systemPrompt = `You are an expert software engineer enhancing existing code.

${basePrompt}

CRITICAL:
1. Output the COMPLETE enhanced code (not just changes)
2. Preserve all existing functionality
3. Follow the existing code style and patterns
4. If reference code provided, extract and apply patterns appropriately
5. List all changes made at the beginning`;

    let userPrompt = `## Enhancement Instruction
${cleanQuery}

`;

    if (codeToAugment && !sources.llm) {
        userPrompt += `## Code to Enhance
${codeToAugment.slice(0, 50000)}

`;
    }
    
    if (referenceCode) {
        userPrompt += `${referenceCode}

Learn from the reference code above. Extract relevant patterns and apply them to enhance the target code.

`;
    }
    
    userPrompt += `Provide:
1. Summary of changes made
2. Complete enhanced code (not just snippets)`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    response.markdown(`

---
**Continue iterating:**
- \`@astra /augment add logging\`
- \`@astra /augment /source h,w learn from MT103\`
- \`@astra /jira\` → Create ticket
`);
}

module.exports = { handle };
