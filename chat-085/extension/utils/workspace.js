/**
 * Workspace utilities - file discovery and index building
 */

const vscode = require('vscode');
const path = require('path');
const config = require('../config.json');
const { GrepIndex } = require('../search/grep-index');

/**
 * Get the current workspace root
 * @returns {string|null} Workspace root path or null
 */
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

/**
 * Discover files in workspace matching configured extensions
 * @param {string} workspaceRoot - Workspace root path
 * @returns {Promise<Array>} Array of file URIs
 */
async function discoverFiles(workspaceRoot) {
    const pattern = `**/*.{${config.fileExtensions.join(',')}}`;
    const files = await vscode.workspace.findFiles(
        pattern, 
        config.excludePattern, 
        config.search.maxFilesPerQuery
    );
    return files;
}

/**
 * Read file contents
 * @param {Uri} fileUri - VS Code file URI
 * @returns {Promise<{content: string, language: string}|null>} File info or null on error
 */
async function readFile(fileUri) {
    try {
        const content = await vscode.workspace.fs.readFile(fileUri);
        const text = Buffer.from(content).toString('utf8');
        const ext = path.extname(fileUri.fsPath).slice(1);
        return { content: text, language: ext };
    } catch (e) {
        return null;
    }
}

/**
 * Build grep index from workspace
 * @param {string} workspaceRoot - Workspace root path
 * @param {Object} outputChannel - Output channel for logging
 * @returns {Promise<GrepIndex>} Built grep index
 */
async function buildIndex(workspaceRoot, outputChannel) {
    const contextFiles = new Map();
    const files = await discoverFiles(workspaceRoot);
    
    outputChannel.appendLine(`Found ${files.length} files to index`);
    
    for (const fileUri of files) {
        const fileInfo = await readFile(fileUri);
        if (fileInfo) {
            contextFiles.set(fileUri.fsPath, fileInfo);
        }
    }
    
    const grepIndex = new GrepIndex({
        contextLines: config.index.contextLines,
        maxResults: config.index.maxResults,
        buildCallIndex: config.index.buildCallIndex
    });
    
    grepIndex.build(contextFiles, {
        log: (msg) => outputChannel.appendLine(msg)
    });
    
    return grepIndex;
}

module.exports = {
    getWorkspaceRoot,
    discoverFiles,
    readFile,
    buildIndex
};
