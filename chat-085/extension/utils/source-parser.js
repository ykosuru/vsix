/**
 * Shared /source modifier parser for all commands
 * 
 * Usage in commands:
 *   const { parseModifiers, gatherSources } = require('../utils/source-parser');
 *   const { sources, specName, cleanQuery } = parseModifiers(query);
 *   const gathered = await gatherSources(ctx, sources, cleanQuery);
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/**
 * Parse /source and /spec modifiers from query
 * 
 * @param {string} query - The raw query string
 * @param {object} defaults - Default source settings { h: true, w: false, a: false }
 * @returns {{ sources: object, specName: string|null, cleanQuery: string }}
 */
function parseModifiers(query, defaults = { llm: false, h: true, w: false, a: false }) {
    let cleanQuery = query;
    let sources = { ...defaults };
    let specName = null;
    
    // Parse /source
    const sourceMatch = cleanQuery.match(/^\/source\s+([a-z,]+)\s*/i);
    if (sourceMatch) {
        const sourceStr = sourceMatch[1].toLowerCase();
        cleanQuery = cleanQuery.slice(sourceMatch[0].length).trim();
        
        if (sourceStr === 'llm') {
            sources = { llm: true, h: false, w: false, a: false };
        } else {
            sources = {
                llm: false,
                h: sourceStr.includes('h'),
                w: sourceStr.includes('w'),
                a: sourceStr.includes('a')
            };
        }
    }
    
    // Parse /spec
    const specMatch = cleanQuery.match(/^\/spec\s+(\S+)\s*/i);
    if (specMatch) {
        specName = specMatch[1];
        cleanQuery = cleanQuery.slice(specMatch[0].length).trim();
    }
    
    return { sources, specName, cleanQuery };
}

/**
 * Extract content from chat history
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
 * Read attachments from request references
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
                
                content += `\n### File: ${fileName}\n\`\`\`\n${text.slice(0, 50000)}\n\`\`\`\n`;
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
 * Gather all sources based on parsed modifiers
 * 
 * @param {object} ctx - Command context
 * @param {object} sources - Parsed sources { h, w, a, llm }
 * @param {string} searchQuery - Query for workspace search
 * @param {object} options - { maxFiles, maxLinesPerFile }
 * @returns {Promise<object>} - { history, workspace, attachments, workspaceFiles, attachmentNames, sourcesUsed }
 */
async function gatherSources(ctx, sources, searchQuery, options = {}) {
    const { chatContext, request, outputChannel, response, pipedContent } = ctx;
    const { maxFiles = 15, maxLinesPerFile = 400 } = options;
    
    const result = {
        history: '',
        workspace: '',
        attachments: '',
        piped: pipedContent || '',
        workspaceFiles: [],
        attachmentNames: [],
        sourcesUsed: []
    };
    
    // Piped content takes priority
    if (result.piped && result.piped.length > 50) {
        result.sourcesUsed.push('🔗 Piped');
    }
    
    // History
    if (sources.h && !result.piped) {
        result.history = extractHistoryContent(chatContext, 1);
        if (result.history.length > 50) {
            result.sourcesUsed.push('📜 History');
        }
    }
    
    // Workspace
    if (sources.w && searchQuery.trim()) {
        try {
            const { getWorkspaceContext } = require('../llm/workspace-search');
            response?.progress(`Searching workspace for: ${searchQuery}...`);
            const wsResult = await getWorkspaceContext(searchQuery, { maxFiles, maxLinesPerFile });
            if (wsResult.context) {
                result.workspace = wsResult.context;
                result.workspaceFiles = wsResult.files || [];
                result.sourcesUsed.push(`🔍 Workspace (${result.workspaceFiles.length} files)`);
            }
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] Workspace search error: ${e.message}`);
        }
    }
    
    // Attachments
    if (sources.a) {
        const { content, names } = await readAttachments(request?.references, outputChannel);
        if (content.length > 50) {
            result.attachments = content;
            result.attachmentNames = names;
            result.sourcesUsed.push(`📎 Attachments (${names.length})`);
        }
    }
    
    // LLM only
    if (sources.llm) {
        result.sourcesUsed.push('🤖 LLM only');
    }
    
    return result;
}

/**
 * Format sources summary for display
 */
function formatSourcesSummary(gathered) {
    return gathered.sourcesUsed.length > 0 
        ? gathered.sourcesUsed.join(', ')
        : 'None';
}

/**
 * Get combined content from all sources
 */
function getCombinedContent(gathered) {
    let content = '';
    
    if (gathered.piped) {
        content += gathered.piped + '\n\n';
    }
    if (gathered.history) {
        content += gathered.history + '\n\n';
    }
    if (gathered.workspace) {
        content += '## Reference Code from Workspace\n\n' + gathered.workspace + '\n\n';
    }
    if (gathered.attachments) {
        content += '## Reference from Attachments\n\n' + gathered.attachments + '\n\n';
    }
    
    return content;
}

/**
 * Standard help text for /source modifier
 */
const SOURCE_HELP = `
## Source Options (\`/source\`)

| Option | Meaning |
|--------|---------|
| \`llm\` | Pure LLM - no context (fresh generation) |
| \`h\` | History - use previous response |
| \`w\` | Workspace - search codebase |
| \`a\` | Attachments - use attached files |

**Combine:** \`/source h,w\` or \`/source w,a\` or \`/source h,w,a\`

**Note:** Piped content (from command chains) always takes priority over /source.
`;

module.exports = {
    parseModifiers,
    gatherSources,
    formatSourcesSummary,
    getCombinedContent,
    extractHistoryContent,
    readAttachments,
    SOURCE_HELP
};
