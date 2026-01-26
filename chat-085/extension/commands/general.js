/**
 * General query handler - searches workspace and includes context
 * Respects /sources configuration
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');
const { getSelectedSources } = require('./sources');

const systemPrompt = `You are an expert code analyst. Analyze the provided source code and attachments to answer the user's question.
Reference specific files, functions, and line numbers from the code shown.
Be thorough but concise. Base your answer ONLY on the content provided below.`;

/**
 * Extract previous conversation from chat history
 */
function getPreviousConversation(chatContext, maxTurns = 3) {
    let conversation = '';
    
    if (!chatContext?.history?.length) {
        return '';
    }
    
    // Get last N turns
    const recentHistory = chatContext.history.slice(-maxTurns);
    
    for (const turn of recentHistory) {
        // Get user message
        if (turn.participant === 'astra' || turn.command) {
            const userQuery = turn.prompt || turn.command || '';
            if (userQuery) {
                conversation += `**User:** ${userQuery}\n\n`;
            }
        }
        
        // Get assistant response
        if (turn.response?.length > 0) {
            let responseText = '';
            for (const part of turn.response) {
                if (part.value && typeof part.value === 'string') {
                    responseText += part.value;
                } else if (part.value?.value) {
                    responseText += part.value.value;
                }
            }
            if (responseText) {
                // Truncate long responses
                const truncated = responseText.length > 2000 
                    ? responseText.slice(0, 2000) + '\n... [truncated]' 
                    : responseText;
                conversation += `**Assistant:** ${truncated}\n\n`;
            }
        }
    }
    
    return conversation;
}

async function handle(ctx) {
    const { query, response, outputChannel, token, chatContext, sourceConfig, request } = ctx;
    
    // Get source configuration - from piped /sources or default settings
    const sources = sourceConfig || getSelectedSources();
    
    if (!query.trim()) {
        response.markdown(`**Ask me about your code!**

**Examples:**
- \`@astra how does authentication work?\`
- \`@astra explain partition pruning\`
- \`@astra /describe UserService\`

**Follow-up questions work too:**
- \`@astra\` "how does login work?"
- \`@astra\` "what about the logout flow?"
- \`@astra\` "show me the error handling"`);
        
        // Add configure sources button
        response.button({
            command: 'astracode.configureSources',
            title: '⚙️ Configure Input Sources'
        });
        return;
    }
    
    // Only use history if enabled in sources
    let previousConversation = '';
    let hasHistory = false;
    
    if (sources.history) {
        previousConversation = getPreviousConversation(chatContext, sources.historyCount || 3);
        hasHistory = previousConversation.length > 100;
    }
    
    // Check for attachments
    let attachedContent = '';
    if (sources.attachments && request?.references?.length > 0) {
        for (const ref of request.references) {
            try {
                if (ref.id && typeof ref.id === 'string') {
                    const vscode = require('vscode');
                    const uri = vscode.Uri.parse(ref.id);
                    const data = await vscode.workspace.fs.readFile(uri);
                    const content = Buffer.from(data).toString('utf8');
                    const fileName = uri.path.split('/').pop();
                    attachedContent += `\n### Attached: ${fileName}\n\`\`\`\n${content.slice(0, 30000)}\n\`\`\`\n`;
                }
            } catch (e) {
                outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
            }
        }
    }
    const hasAttachments = attachedContent.length > 100;
    
    // Search workspace for relevant files (if enabled)
    let context = '';
    let files = [];
    let totalLines = 0;
    
    if (sources.workspace) {
        response.progress('Searching workspace...');
        const result = await getWorkspaceContext(query);
        context = result.context;
        files = result.files;
        totalLines = result.totalLines;
    }
    
    // Check if we have any content
    if (!context && !hasHistory && !hasAttachments) {
        response.markdown(`⚠️ **No content found for:** "${query}"

**Try:**
- Attach files to your message
- Enable workspace search in \`/sources\`
- Use \`@astra /find <term>\` to search for specific code`);
        return;
    }
    
    // Show sources being used
    const sourcesUsed = [];
    if (files.length > 0) sourcesUsed.push(`🔍 Workspace (${files.length} files)`);
    if (hasAttachments) sourcesUsed.push('📎 Attachments');
    if (hasHistory) sourcesUsed.push('📜 History');
    
    if (sourcesUsed.length > 0) {
        response.markdown(`**📥 Sources:** ${sourcesUsed.join(', ')}\n\n`);
    }
    
    if (files && files.length > 0) {
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
    
    // Build prompt
    let userPrompt = `## Question\n${query}\n\n`;
    
    if (hasHistory) {
        userPrompt += `## Previous Conversation\n${previousConversation}\n\n`;
    }
    
    if (hasAttachments) {
        userPrompt += `## Attached Files\n${attachedContent}\n\n`;
    }
    
    if (context) {
        userPrompt += `## Source Code Context\n${context}\n\n`;
    }
    
    userPrompt += `Answer the question based on the provided content. Reference specific files and line numbers where applicable.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
