/**
 * /describe command - describe code functionality
 * 
 * Supports:
 * - Workspace search
 * - Attached files
 * - Piped content from /sources, /history, etc.
 */

const vscode = require('vscode');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');
const { getSelectedSources } = require('./sources');

const systemPrompt = `You are an expert code analyst. Describe how the specified code works.
Focus on:
- Purpose and functionality
- Key functions and their roles  
- Data flow and dependencies
- Important implementation details
Reference specific files and line numbers from the code provided.`;

/**
 * Read attached files
 */
async function readAttachments(references, outputChannel) {
    let content = '';
    const attachedNames = [];
    
    if (!references || references.length === 0) {
        outputChannel?.appendLine(`[AstraCode] readAttachments: No references provided`);
        return { content: '', attachedNames: [] };
    }
    
    outputChannel?.appendLine(`[AstraCode] readAttachments: ${references.length} references`);
    
    for (const ref of references) {
        try {
            let fileContent = '';
            let fileName = '';
            
            // Log the reference structure
            outputChannel?.appendLine(`[AstraCode] Reference: id=${ref.id}, value type=${typeof ref.value}`);
            
            // Method 1: ref.id is a URI string (most common in Copilot chat)
            if (ref.id && typeof ref.id === 'string' && (ref.id.startsWith('file:') || ref.id.includes('/'))) {
                const uri = vscode.Uri.parse(ref.id);
                const data = await vscode.workspace.fs.readFile(uri);
                fileContent = Buffer.from(data).toString('utf8');
                fileName = uri.path.split('/').pop() || uri.fsPath?.split(/[/\\]/).pop() || 'unknown';
                outputChannel?.appendLine(`[AstraCode] Method 1 (URI string): ${fileName}`);
            }
            // Method 2: ref.value is a URI object
            else if (ref.value && (ref.value.scheme === 'file' || ref.value.fsPath || ref.value.path)) {
                const data = await vscode.workspace.fs.readFile(ref.value);
                fileContent = Buffer.from(data).toString('utf8');
                fileName = ref.value.path?.split('/').pop() || ref.value.fsPath?.split(/[/\\]/).pop() || ref.name || 'unknown';
                outputChannel?.appendLine(`[AstraCode] Method 2 (URI object): ${fileName}`);
            }
            // Method 3: ref.value is direct content
            else if (ref.value && typeof ref.value === 'string') {
                fileContent = ref.value;
                fileName = ref.name || 'attached-content';
                outputChannel?.appendLine(`[AstraCode] Method 3 (string content): ${fileName}`);
            }
            
            if (fileContent) {
                // Truncate if too large
                const maxChars = 50000;
                const truncated = fileContent.length > maxChars 
                    ? fileContent.slice(0, maxChars) + '\n... [truncated]' 
                    : fileContent;
                
                content += `\n### File: ${fileName}\n\`\`\`\n${truncated}\n\`\`\`\n`;
                attachedNames.push(fileName);
                outputChannel?.appendLine(`[AstraCode] ✅ Read: ${fileName} (${fileContent.length} chars)`);
            }
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] ❌ Error reading attachment: ${e.message}`);
        }
    }
    
    return { content, attachedNames };
}

async function handle(ctx) {
    const { query, response, outputChannel, token, request, pipedContent: ctxPipedContent, sourceConfig } = ctx;
    
    // Debug: log what we received
    outputChannel?.appendLine(`[AstraCode] /describe: query="${query}"`);
    outputChannel?.appendLine(`[AstraCode] /describe: references=${request?.references?.length || 0}`);
    outputChannel?.appendLine(`[AstraCode] /describe: pipedContent=${(ctxPipedContent || '').length} chars`);
    outputChannel?.appendLine(`[AstraCode] /describe: sourceConfig=${JSON.stringify(sourceConfig || 'null')}`);
    
    // Check for piped content
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    // Check source configuration (from /sources command)
    const sources = sourceConfig || getSelectedSources();
    const useWorkspace = sources.workspace !== false; // default true
    
    outputChannel?.appendLine(`[AstraCode] /describe: useWorkspace=${useWorkspace}`);
    
    // Check for attachments
    const { content: attachedContent, attachedNames } = await readAttachments(
        request?.references, 
        outputChannel
    );
    const hasAttachments = attachedContent.length > 100;
    
    outputChannel?.appendLine(`[AstraCode] /describe: hasAttachments=${hasAttachments}, attachedNames=${attachedNames.join(', ')}`);
    outputChannel?.appendLine(`[AstraCode] /describe: attachedContent length=${attachedContent.length}`);
    
    if (!query.trim() && !hasPipedContent && !hasAttachments) {
        response.markdown(`**Usage:** \`@astra /describe <function or module>\`

**Examples:**
- \`@astra /describe partition pruning\`
- \`@astra /describe ExecFindPartition\`
- \`@astra /describe query optimizer\`

**With attachments:**
\`\`\`
[Attach: code.js, architecture.md]
@astra /describe this code
\`\`\`

**From other commands:**
\`\`\`
@astra /sources /describe
@astra /history 3 /describe
\`\`\``);
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
    let totalLines = 0;
    
    if (useWorkspace && query.trim()) {
        response.progress('Searching workspace...');
        const result = await getWorkspaceContext(query, {
            maxFiles: 20,
            maxLinesPerFile: 500
        });
        
        if (result.context && result.files.length > 0) {
            allContent += `## Workspace Code\n\n${result.context}\n\n`;
            files = result.files;
            totalLines = result.totalLines;
            sourcesUsed.push(`🔍 Workspace (${files.length} files)`);
        }
    }
    
    // Check if we have any content
    if (allContent.length < 100) {
        response.markdown(`⚠️ **No content found for:** "${query || '(no query)'}"

**Make sure to:**
1. **Attach files in the SAME message** as \`/describe\`
2. Or enable workspace search in \`/sources\`
3. Or pipe from another command

**Debug:** Check Output → AstraCode panel for details.

**Example:**
\`\`\`
[Drag file into chat input]
@astra /describe this code
\`\`\`
`);
        return;
    }
    
    // Show sources being used
    response.markdown(`**📥 Input Sources:** ${sourcesUsed.join(', ')}\n\n`);
    
    // Show files if workspace was used
    if (files.length > 0) {
        let filesUsed = `<details><summary>📂 Files analyzed (${files.length})</summary>\n\n`;
        for (const f of files.slice(0, 25)) {
            filesUsed += `- \`${f.path}\`\n`;
        }
        if (files.length > 25) {
            filesUsed += `- *...and ${files.length - 25} more*\n`;
        }
        filesUsed += `\n</details>\n\n`;
        response.markdown(filesUsed);
    }
    
    // Show attached files
    if (attachedNames.length > 0) {
        let attached = `<details><summary>📎 Attached files (${attachedNames.length})</summary>\n\n`;
        for (const name of attachedNames) {
            attached += `- \`${name}\`\n`;
        }
        attached += `\n</details>\n\n`;
        response.markdown(attached);
    }
    
    const userPrompt = `Describe how this works: ${query || 'the provided code/documentation'}

## Content
${allContent}

Provide:
1. Overview of what it does
2. Key components/functions
3. How they work together
4. Important implementation details

Reference specific files and line numbers where applicable.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
