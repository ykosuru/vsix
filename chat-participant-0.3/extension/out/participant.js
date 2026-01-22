/**
 * Chat Participant - handles routing and state management
 */

const { getHandler } = require('./commands');
const { buildIndex } = require('./utils/workspace');

// Global state
let grepIndex = null;
let indexedWorkspace = null;

/**
 * Clear the index
 */
function clearIndex() {
    grepIndex = null;
    indexedWorkspace = null;
}

/**
 * Get the current index
 * @returns {GrepIndex|null}
 */
function getIndex() {
    return grepIndex;
}

/**
 * Check if index needs rebuild
 * @param {string} workspaceRoot - Current workspace root
 * @returns {boolean}
 */
function needsRebuild(workspaceRoot) {
    return !grepIndex || indexedWorkspace !== workspaceRoot;
}

/**
 * Ensure index is built for workspace
 * @param {string} workspaceRoot - Workspace root path
 * @param {Object} outputChannel - Output channel for logging
 * @param {Object} response - Chat response for progress
 */
async function ensureIndex(workspaceRoot, outputChannel, response) {
    if (needsRebuild(workspaceRoot)) {
        response.progress('Building code index...');
        grepIndex = await buildIndex(workspaceRoot, outputChannel);
        indexedWorkspace = workspaceRoot;
    }
}

/**
 * Handle /clear command
 * @param {Object} response - Chat response
 * @param {Object} outputChannel - Output channel
 */
function handleClear(response, outputChannel) {
    clearIndex();
    outputChannel.appendLine('Index cleared');
    response.markdown('🗑️ **Index cleared.** Next query will rebuild fresh from workspace files.');
}

/**
 * Handle /rebuild command
 * @param {Object} response - Chat response
 * @param {Object} outputChannel - Output channel
 */
function handleRebuild(response, outputChannel) {
    clearIndex();
    outputChannel.appendLine('Forcing index rebuild...');
    response.progress('Rebuilding index from scratch...');
}

/**
 * Handle /stats command
 * @param {Object} response - Chat response
 */
function handleStats(response) {
    if (grepIndex) {
        const stats = grepIndex.getStats();
        response.markdown(`📊 **Index Statistics**\n\n`);
        response.markdown(`- **Files indexed:** ${stats.files}\n`);
        response.markdown(`- **Total lines:** ${stats.totalLines.toLocaleString()}\n`);
        response.markdown(`- **Unique functions:** ${stats.uniqueFunctions.toLocaleString()}\n`);
        response.markdown(`- **Call sites tracked:** ${stats.indexedCalls.toLocaleString()}\n`);
        response.markdown(`- **Build time:** ${stats.buildTime}ms\n`);
        response.markdown(`- **Last updated:** ${stats.lastUpdated?.toLocaleTimeString() || 'N/A'}\n`);
    } else {
        response.markdown('⚠️ No index built yet. Run a query to build the index.');
    }
}

/**
 * Handle incoming chat request
 * @param {Object} request - Chat request
 * @param {Object} chatContext - Chat context
 * @param {Object} response - Chat response stream
 * @param {CancellationToken} token - Cancellation token
 * @param {Object} outputChannel - Output channel
 * @param {Function} getWorkspaceRoot - Function to get workspace root
 */
async function handleRequest(request, chatContext, response, token, outputChannel, getWorkspaceRoot) {
    const query = request.prompt;
    const command = request.command;
    
    outputChannel.appendLine(`\n=== New Query: ${query} ===`);
    outputChannel.appendLine(`Command: ${command || 'none'}`);
    
    // Handle /help - no workspace needed
    if (command === 'help') {
        return getHandler('help')(response);
    }
    
    // Handle /clear - no workspace needed
    if (command === 'clear') {
        return handleClear(response, outputChannel);
    }
    
    // Handle /stats - no workspace needed
    if (command === 'stats') {
        return handleStats(response);
    }
    
    // Handle /rebuild - clears index, then continues
    if (command === 'rebuild') {
        handleRebuild(response, outputChannel);
    }
    
    // All other commands need a workspace
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        response.markdown('❌ No workspace folder open. Please open a folder first.');
        return;
    }
    
    // Ensure index is built
    await ensureIndex(workspaceRoot, outputChannel, response);
    
    try {
        // Build command context
        const ctx = {
            query,
            response,
            outputChannel,
            workspaceRoot,
            grepIndex,
            token
        };
        
        // Route to handler
        const handler = getHandler(command);
        await handler(ctx);
        
    } catch (error) {
        outputChannel.appendLine(`Error: ${error.stack || error}`);
        response.markdown(`❌ Error: ${error.message}`);
    }
}

module.exports = {
    handleRequest,
    clearIndex,
    getIndex,
    needsRebuild,
    ensureIndex
};
