/**
 * AstraCode Chat Participant - Simplified
 * 
 * Passes queries to Copilot with command-specific prompts.
 * Copilot handles file discovery via @workspace internally.
 */

const vscode = require('vscode');
const { getHandler, PIPELINE_COMMANDS } = require('./commands');
const { streamResponse } = require('./llm/copilot');

// Global state
let outputChannel = null;

/**
 * Main request handler
 */
async function handleRequest(request, chatContext, response, token, channel, getWorkspaceRoot) {
    if (channel) {
        outputChannel = channel;
    }
    
    const command = request.command || '';
    const query = request.prompt || '';
    
    log(`Request: /${command || 'general'} ${query.slice(0, 50)}...`);
    
    // Get workspace for context
    const workspaceRoot = getWorkspaceRoot ? getWorkspaceRoot() : getDefaultWorkspaceRoot();
    
    // Handle utility commands
    if (command === 'help') {
        const handler = getHandler('help');
        return handler({ query, response, outputChannel });
    }
    
    if (command === 'stats') {
        return showWorkspaceInfo(response, workspaceRoot);
    }
    
    // For all other commands, build context and pass to handler
    const ctx = {
        query,
        response,
        outputChannel,
        workspaceRoot,
        token,
        // No pre-built context - handlers will use Copilot directly
        context: null,
        contextStats: null
    };
    
    const handler = getHandler(command);
    await handler(ctx);
}

/**
 * Show workspace info
 */
function showWorkspaceInfo(response, workspaceRoot) {
    const folders = vscode.workspace.workspaceFolders || [];
    
    response.markdown(`## 📊 Workspace Info

**Root:** \`${workspaceRoot || 'No workspace'}\`
**Folders:** ${folders.length}
${folders.map(f => `- \`${f.uri.fsPath}\``).join('\n')}

**Note:** AstraCode now uses Copilot's built-in workspace search for better results.

**Usage:**
- \`@astra explain <topic>\` - Explain code concepts
- \`@astra /describe <function>\` - Describe functionality  
- \`@astra /deepwiki <topic>\` - Generate documentation
- \`@astra /find <term>\` - Search for code`);
}

/**
 * Get workspace root
 */
function getDefaultWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function log(msg) {
    if (outputChannel) {
        outputChannel.appendLine(`[AstraCode] ${msg}`);
    }
    console.log(`[AstraCode] ${msg}`);
}

function clearIndex() {
    // No-op now - no index to clear
}

module.exports = {
    handleRequest,
    clearIndex
};
