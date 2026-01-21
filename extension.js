/**
 * AstraCode v5.2.0 - Agentic Code Assistant
 * 
 * Refactored modular architecture with Grep-based Scoped Search
 * 
 * NEW: GREP SCOPED SEARCH COMMANDS
 * ============================================
 *   /grep <keywords>   - Find files matching keywords (full-text search)
 *   /grep              - Show current scope status
 *   /ungrep            - Exit scoped mode, search all files
 * 
 * CLEAN 3-LAYER SEARCH ARCHITECTURE
 * ============================================
 * 
 * ┌─────────────────────────────────────────────────────────┐
 * │                     SEARCH QUERY                        │
 * └─────────────────────────────────────────────────────────┘
 *                            │
 *        ┌───────────────────┼───────────────────┐
 *        ▼                   ▼                   ▼
 * ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
 * │   SYMBOL    │     │   TRIGRAM   │     │   VECTOR    │
 * │   INDEX     │     │   INDEX     │     │   INDEX     │
 * └─────────────┘     └─────────────┘     └─────────────┘
 * 
 * Key Tools:
 * - search_code: Combines Layer 1 + Layer 2 (PREFERRED)
 * - search_trigram: Layer 2 only (exact text)
 * - search_semantic: Layer 3 only (concepts)
 * - hybridSearch(): All 3 layers with result fusion
 */

const vscode = require('vscode');
const path = require('path');

// Path utilities for cross-platform compatibility (Windows/Unix)
const pathUtils = require('./pathUtils');

// Core modules
const searchModule = require('./search-module');
const { PersistenceManager } = require('./persistence');
const { PromptLibrary } = require('./prompts');
const { CodeIndex } = require('./index-module');
const { SessionMemory } = require('./session-memory');
const { CobolQueryClassifier } = require('./cobol-query-classifier');

// State management
const { 
    createCodeIndex, 
    createVectorIndex, 
    createTrigramIndex,
    createTfidfVocabulary 
} = require('./state');

// Configuration
const { LLMConfig, AGENT_CONFIG } = require('./config');

// Logging
const logging = require('./logging');

// Vector/Trigram search
const { 
    searchVectorIndex,
    clearVectorIndex,
    getVectorIndexStats,
    buildTfidfVocabulary,
    generateTfidfEmbedding
} = require('./vector-index');

// File utilities
const {
    detectLanguage,
    isBinaryFile,
    addFileToContext,
    removeFileFromContext,
    clearContext,
    addDirectoryToContext,
    addToContext
} = require('./file-utils');

// Query utilities
const { extractSearchKeywords } = require('./query-utils');

// Symbol search
const { fuzzySearchSymbols, getIndexStats } = require('./symbol-search');

// UI
const { getWebviewContent } = require('./webview-html');

// Indexing
const { IndexingState, buildAllIndexes } = require('./indexing');
const { InvertedIndex } = require('./inverted-index');

// LLM
const { LLMClient } = require('./llm-client');

// *** NEW: Import CodebaseIndex for unified search ***
const { CodebaseIndex } = require('./codebase-index');

const { buildContext } = require('./context-builder');

const { DocGenerator, DOC_TYPES } = require('./doc-generator');

const { generateCallGraphFile, generateCallGraphHTML, saveCallGraphToFile } = require('./call-graph-visualizer');

// *** NEW: Scoped Search - narrow searches to specific files ***
const scopedSearch = require('./scoped-search');

// ============================================================
// Module-level State (migrating from globals)
// ============================================================

// Global persistence manager instance
let persistenceManager = null;

// Global code index instance (new modular approach)
let codeIndexManager = null;

// Global session memory instance
let sessionMemory = null;

// Context files map
const contextFiles = new Map();

// Code index structure (legacy - kept for compatibility)
const codeIndex = createCodeIndex();

// Vector index
const vectorIndex = createVectorIndex();

// Trigram index  
const trigramIndex = createTrigramIndex();

// TF-IDF vocabulary
const tfidfVocabulary = createTfidfVocabulary();

// Inverted index for keyword search (legacy - kept for compatibility)
const invertedIndex = new InvertedIndex();

// *** NEW: Unified CodebaseIndex instance ***
let codebaseIndex = null;

// Chat history
let chatHistory = [];

// Webview reference
let chatWebviewView;

// Output channel
let outputChannel;

// Status bar item
let summaryStatusBarItem;

// *** NEW: Scope status bar item ***
let scopeStatusBarItem;

// Last used model tracking
let lastUsedModel = null;
let llmClient = null;
const failedModelsCache = new Set();
let lastCopilotModelSetting = null;

// Current mode
let currentMode = 'auto';

// Pending plan
let pendingPlan = null;

// Context tree provider
let contextTreeProvider;

// ============================================================
// Logging Setup (delegate to logging module)
// ============================================================

function log(...args) {
    logging.log(...args);
}

function debugLog(category, message, data) {
    logging.debugLog(category, message, data);
}

function showProgress(message, type) {
    logging.showProgress(message, type);
}

function updateSummaryStatus(progress, message, count) {
    logging.updateSummaryStatus(progress, message, count);
}

// ============================================================
// Initialize Search Module (UPDATED for CodebaseIndex)
// ============================================================

function initializeSearchModule() {
    log('=== initializeSearchModule called ===');
    
    // Create CodebaseIndex if it doesn't exist
    if (!codebaseIndex) {
        codebaseIndex = new CodebaseIndex({ 
            log: log,
            enableTrigrams: true,
            enableInvertedIndex: true,
            enableCallGraph: true,
            enableSummaries: true
        });
        log('Created new CodebaseIndex instance');
    }
    
    // Log current state
    const stats = codebaseIndex.getStats();
    log(`  CodebaseIndex stats: files=${stats.files}, symbols=${stats.symbols}, functions=${stats.functions}`);
    log(`  contextFiles size: ${contextFiles.size}`);
    
    // Initialize search module with the unified CodebaseIndex
    searchModule.initialize(codebaseIndex, log);

    // Only build GrepIndex if not already built (check if it has data)
    const grepStats = searchModule.getStats()?.grep;
    if (!grepStats || grepStats.files === 0) {
        if (contextFiles.size > 0) {
            log('Building GrepIndex (first time)...');
            searchModule.buildGrepIndex(contextFiles, { log });
        }
    } else {
        log(`GrepIndex already built: ${grepStats.uniqueFunctions} functions, ${grepStats.indexedCalls} call sites`);
    }
    
    // Set search mode from config
    const config = vscode.workspace.getConfiguration('astra');
    const mode = config.get('searchMode', 'detailed');
    searchModule.setMode(mode);
    searchModule.setMode('detailed');
    
    log(`Search module initialized, mode: ${searchModule.getMode()}`);
}

/**
 * Build or rebuild the CodebaseIndex from contextFiles
 * Call this after files are added or when rebuilding index
 */
async function buildCodebaseIndex(options = {}) {
    if (!codebaseIndex) {
        codebaseIndex = new CodebaseIndex({ log: log });
    }
    
    if (contextFiles.size === 0) {
        log('No context files to build index from');
        return { files: 0, symbols: 0, functions: 0 };
    }
    
    log(`Building CodebaseIndex from ${contextFiles.size} context files...`);
    
    const stats = await codebaseIndex.build(contextFiles, {
        onProgress: options.onProgress,
        onChatMessage: options.onChatMessage,
        verbose: options.verbose || false
    });
    
    // Re-initialize search module with updated index
    searchModule.initialize(codebaseIndex, log);
    
    // Build GrepIndex for "who calls X?" support
    searchModule.buildGrepIndex(contextFiles, { log });
    
    log(`CodebaseIndex built: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions`);
    
    return stats;
}

// ============================================================
// Context Files Provider (Tree View)
// ============================================================

class ContextFilesProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren() {
        const items = [];
        
        log(`[TreeView] getChildren called, contextFiles.size = ${contextFiles.size}`);
        
        for (const [filePath, file] of contextFiles) {
            const item = new vscode.TreeItem(
                pathUtils.getFileName(file.uri.path),
                vscode.TreeItemCollapsibleState.None
            );
            item.description = `${file.language} • ${(file.content.length / 1024).toFixed(1)}KB`;
            item.tooltip = file.uri.fsPath;
            item.contextValue = 'contextFile';
            item.resourceUri = file.uri;
            item.command = {
                command: 'vscode.open',
                arguments: [file.uri],
                title: 'Open File'
            };
            items.push(item);
        }
        
        if (items.length === 0) {
            const emptyItem = new vscode.TreeItem('No files in context');
            emptyItem.description = 'Right-click a file to add';
            return [emptyItem];
        }
        
        log(`[TreeView] Returning ${items.length} items`);
        return items;
    }
}

// ============================================================
// Chat History Restoration
// ============================================================

function restoreChatToWebview() {
    if (!chatWebviewView || chatHistory.length === 0) {
        return;
    }
    
    log(`Restoring ${chatHistory.length} chat messages to webview`);
    
    // Format history for the webview
    const formattedHistory = chatHistory.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp instanceof Date 
            ? msg.timestamp.toISOString() 
            : msg.timestamp
    }));
    
    chatWebviewView.webview.postMessage({
        type: 'restoreHistory',
        history: formattedHistory
    });
    
    // Update status with current context file count
    updateChatStatus();
}

// ============================================================
// Status Updates
// ============================================================

// Track if index is ready for searches
let isIndexReady = false;

function updateChatStatus() {
    if (!chatWebviewView) return;
    
    const fileCount = contextFiles.size;
    
    // Use CodebaseIndex stats if available, fall back to legacy codeIndex
    let symbolCount = 0, funcCount = 0, summaryCount = 0;
    
    if (codebaseIndex) {
        // Try getStats() method first
        if (typeof codebaseIndex.getStats === 'function') {
            const stats = codebaseIndex.getStats();
            symbolCount = stats.symbols || 0;
            funcCount = stats.functions || 0;
            summaryCount = stats.summaries || 0;
        }
        // Fallback to direct stats object
        if (symbolCount === 0 && codebaseIndex.stats) {
            symbolCount = codebaseIndex.stats.symbols || 0;
            funcCount = codebaseIndex.stats.functions || 0;
            summaryCount = codebaseIndex.stats.summaries || 0;
        }
        // Final fallback - count from Maps directly
        if (symbolCount === 0 && codebaseIndex.symbols) {
            symbolCount = codebaseIndex.symbols.size || 0;
        }
        if (funcCount === 0 && codebaseIndex.callGraph) {
            funcCount = codebaseIndex.callGraph.size || 0;
        }
    }
    
    // Fallback to legacy codeIndex
    if (symbolCount === 0 && codeIndex && codeIndex.symbols) {
        symbolCount = codeIndex.symbols.size || 0;
        funcCount = codeIndex.callGraph?.size || 0;
        summaryCount = codeIndex.summaries?.size || 0;
    }
    
    log(`updateChatStatus: files=${fileCount}, symbols=${symbolCount}, functions=${funcCount}`);
    
    // Build file list with names and paths for the context bar
    const fileList = [];
    for (const [filePath, fileData] of contextFiles) {
        fileList.push({
            name: pathUtils.getFileName(filePath),
            path: filePath,
            language: fileData.language || 'unknown'
        });
    }
    
    // Get scope status
    const scopeStatus = scopedSearch.getScopeStatus();
    
    // Determine if index is ready (has symbols)
    isIndexReady = symbolCount > 0;
    
    const status = {
        text: fileCount > 0 
            ? `${fileCount} files | ${symbolCount} symbols | ${funcCount} funcs`
            : 'No files in context',
        mode: currentMode,
        files: fileList,
        indexStats: {
            files: fileCount,
            symbols: symbolCount,
            functions: funcCount,
            summaries: summaryCount
        },
        scope: scopeStatus,
        isIndexReady: isIndexReady
    };
    
    chatWebviewView.webview.postMessage({ type: 'updateStatus', status });
    
    // Send scope status separately for banner update
    chatWebviewView.webview.postMessage({ 
        type: 'scopeStatus', 
        status: scopeStatus 
    });
    
    // Update scope status bar
    updateScopeStatusBar();
}

// *** NEW: Update scope status bar indicator ***
function updateScopeStatusBar() {
    if (!scopeStatusBarItem) return;
    
    const status = scopedSearch.getScopeStatus();
    if (status && status.isActive) {
        scopeStatusBarItem.text = `$(search) Scope: ${status.fileCount} files`;
        scopeStatusBarItem.tooltip = `Scoped search active: "${status.query}"\nClick to exit scope`;
        scopeStatusBarItem.show();
    } else {
        scopeStatusBarItem.hide();
    }
}

function updateChatStatusUI() {
    updateChatStatus();
}

function updateChatUI() {
    if (!chatWebviewView) return;
    chatWebviewView.webview.postMessage({ 
        type: 'renderChat', 
        history: chatHistory 
    });
}

// ============================================================
// Model Display Name
// ============================================================

function getModelDisplayName() {
    if (lastUsedModel) {
        return LLMConfig.getDisplayName(lastUsedModel.name || lastUsedModel.id);
    }
    return LLMConfig.getDisplayName(LLMConfig.getDefaultModel());
}

// ============================================================
// Extension Activation
// ============================================================

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AstraCode');
    logging.initialize(outputChannel);
    
    log('AstraCode v5.1.3 (Refactored) activating...');
    
    // Initialize the new modular CodeIndex (legacy)
    codeIndexManager = new CodeIndex({
        log: log,
        onProgress: (pct, msg) => {
            chatWebviewView?.webview.postMessage({ 
                type: 'indexProgress', 
                progress: pct, 
                message: msg 
            });
        }
    });
    log('CodeIndex module initialized');
    
    // *** NEW: Initialize CodebaseIndex ***
    codebaseIndex = new CodebaseIndex({
        log: log,
        enableTrigrams: true,
        enableInvertedIndex: true,
        enableCallGraph: true
    });
    log('CodebaseIndex initialized');
    
    // Register tree view provider for context files
    contextTreeProvider = new ContextFilesProvider();
    vscode.window.registerTreeDataProvider('astra.contextView', contextTreeProvider);
    
    // Initialize persistence manager (after tree provider so we can refresh)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        persistenceManager = new PersistenceManager(workspaceFolder.uri, {
            log: log,
            codeIndex: codeIndex,
            contextFiles: contextFiles
        });
        await persistenceManager.initialize();
        log('PersistenceManager initialized');
        
        // Refresh tree view after persistence loads files
        if (contextFiles.size > 0) {
            log(`Persistence loaded ${contextFiles.size} context files, refreshing tree view`);
            contextTreeProvider.refresh();
            // Defer status update until webview is ready
            setTimeout(() => updateChatStatus(), 500);
        }
    }
    
    // Initialize session memory
    sessionMemory = new SessionMemory({
        log: log,
        maxTurns: 50,
        maxReferences: 20
    });
    log('SessionMemory initialized');
    
    // Create status bar item for summary progress
    summaryStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    summaryStatusBarItem.name = 'AstraCode Summary';
    context.subscriptions.push(summaryStatusBarItem);
    logging.setStatusBarItem(summaryStatusBarItem);
    
    // *** NEW: Create scope status bar item ***
    scopeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    scopeStatusBarItem.name = 'AstraCode Scope';
    scopeStatusBarItem.command = 'astra.exitScope';
    context.subscriptions.push(scopeStatusBarItem);
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('astra.addToContext', async (uri) => {
            if (!uri) {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: 'Add to AstraCode Context'
                });
                if (uris) {
                    for (const u of uris) {
                        await addFileToContext(u, contextFiles, {
                            onRefresh: () => contextTreeProvider.refresh(),
                            onStatusUpdate: () => updateChatStatus()
                        });
                    }
                }
            } else {
                await addToContext(uri, contextFiles, {
                    onRefresh: () => contextTreeProvider.refresh(),
                    onStatusUpdate: () => updateChatStatus()
                });
            }
        }),
        
        vscode.commands.registerCommand('astra.removeFromContext', (item) => {
            if (item?.resourceUri) {
                removeFileFromContext(item.resourceUri, contextFiles, {
                    onRefresh: () => contextTreeProvider.refresh(),
                    onStatusUpdate: () => updateChatStatus()
                });
            }
        }),
        
        vscode.commands.registerCommand('astra.clearContext', () => {
            clearContext(contextFiles, codeIndex, {
                onRefresh: () => contextTreeProvider.refresh(),
                onStatusUpdate: () => updateChatStatus()
            });
            // Also clear CodebaseIndex
            if (codebaseIndex) {
                codebaseIndex.clear();
            }
            vscode.window.showInformationMessage('AstraCode context cleared');
        }),
        
        vscode.commands.registerCommand('astra.rebuildIndex', async () => {
            if (contextFiles.size === 0) {
                vscode.window.showWarningMessage('No files in context to index');
                return;
            }
            
            log('Rebuilding index for', contextFiles.size, 'files');
            
            // *** Disable input during indexing ***
            chatWebviewView?.webview.postMessage({ 
                type: 'setIndexing', 
                value: true,
                message: 'Building index...'
            });
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Building AstraCode Index',
                cancellable: false
            }, async (progress) => {
                try {
                    const stats = await buildCodebaseIndex({
                        verbose: true,
                        onProgress: (pct, message, progressStats) => {
                            progress.report({ message, increment: pct - (IndexingState.progress || 0) });
                            
                            // Update webview with stats from progress callback
                            chatWebviewView?.webview.postMessage({
                                type: 'indexProgress',
                                progress: pct,
                                message: message,
                                stats: progressStats || {
                                    files: IndexingState.filesIndexed || 0,
                                    symbols: IndexingState.symbolsFound || 0,
                                    functions: IndexingState.functionsFound || 0
                                }
                            });
                        },
                        onChatMessage: (text) => {
                            chatWebviewView?.webview.postMessage({
                                type: 'appendResponse',
                                text: text
                            });
                        }
                    });
                    
                    // Keep progress bar visible during legacy index build
                    chatWebviewView?.webview.postMessage({
                        type: 'indexProgress',
                        progress: 82,
                        message: 'Building search indexes...'
                    });
                    
                    // Also build legacy indexes for backward compatibility
                    await buildAllIndexes(contextFiles, codeIndex, {
                        log: log,
                        trigramIndex: trigramIndex,
                        invertedIndex: invertedIndex,
                        vectorIndex: vectorIndex,
                        tfidfVocabulary: tfidfVocabulary,
                        buildTrigrams: true,
                        buildVectors: true,  // ENABLED: Build vector embeddings for semantic search
                        buildInverted: true,
                        verbose: false  // Don't double-log
                    });
                    
                    // Keep progress visible before Phase 5
                    chatWebviewView?.webview.postMessage({
                        type: 'indexProgress',
                        progress: 84,
                        message: 'Preparing vector embeddings...'
                    });
                    
                    // *** BUILD VECTOR INDEX ***
                    // Create chunks from codebase and generate embeddings
                    log('Building vector index...');
                    
                    // Send progress update - Phase 5 starting (85%)
                    chatWebviewView?.webview.postMessage({
                        type: 'indexProgress',
                        progress: 85,
                        message: 'Building vector embeddings...'
                    });
                    
                    chatWebviewView?.webview.postMessage({
                        type: 'appendResponse',
                        text: `**Phase 5/5:** Building vector embeddings for semantic search...\n`
                    });
                    
                    try {
                        const chunks = [];
                        
                        // File extensions to EXCLUDE from vector indexing
                        const excludeExtensions = new Set([
                            '.map', '.dat', '.txt', '.md', '.json', '.xml', '.html',
                            '.css', '.svg', '.png', '.jpg', '.gif', '.ico', '.woff',
                            '.eot', '.ttf', '.pdf', '.zip', '.tar', '.gz', '.bin',
                            '.po', '.pot', '.mo', '.sql', '.out', '.log', '.sample'
                        ]);
                        
                        // File extensions to INCLUDE (code files)
                        const codeExtensions = new Set([
                            '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx',
                            '.java', '.py', '.js', '.ts', '.jsx', '.tsx',
                            '.go', '.rs', '.rb', '.pl', '.pm', '.php',
                            '.cs', '.vb', '.swift', '.kt', '.scala',
                            '.cob', '.cbl', '.tal', '.pco'
                        ]);
                        
                        // Create chunks from functions and file content
                        for (const [filePath, fileData] of contextFiles) {
                            const fileName = filePath.split('/').pop();
                            const ext = '.' + fileName.split('.').pop().toLowerCase();
                            
                            // Skip non-code files
                            if (excludeExtensions.has(ext)) continue;
                            
                            // Only include known code files or files with functions
                            const isCodeFile = codeExtensions.has(ext);
                            
                            const content = fileData.content || '';
                            
                            // Get functions/symbols for this file
                            const fileSymbols = Array.from(codebaseIndex.symbols?.values() || [])
                                .filter(s => s.file === filePath);
                            
                            // Skip files with no symbols unless they're known code files
                            if (fileSymbols.length === 0 && !isCodeFile) continue;
                            
                            // Create chunk for each function
                            for (const sym of fileSymbols) {
                                if (sym.type === 'function' && sym.source) {
                                    chunks.push({
                                        id: `${filePath}:${sym.name}`,
                                        file: filePath,
                                        fileName: fileName,
                                        startLine: sym.line || 0,
                                        endLine: sym.endLine || sym.line || 0,
                                        type: 'function',
                                        symbolName: sym.name,
                                        text: `${sym.name} ${sym.source || ''}`
                                    });
                                }
                            }
                            
                            // Also create a chunk for the whole file (first 2000 chars) - only for code files
                            if (content.length > 0 && (isCodeFile || fileSymbols.length > 0)) {
                                chunks.push({
                                    id: `${filePath}:file`,
                                    file: filePath,
                                    fileName: fileName,
                                    startLine: 1,
                                    endLine: content.split('\n').length,
                                    type: 'file',
                                    symbolName: null,
                                    text: content.substring(0, 2000)
                                });
                            }
                        }
                        
                        log(`Created ${chunks.length} chunks for vector index`);
                        
                        // Build vocabulary
                        if (chunks.length > 0) {
                            buildTfidfVocabulary(chunks, tfidfVocabulary);
                            log(`Built TF-IDF vocabulary with ${tfidfVocabulary.terms?.size || 0} terms`);
                            
                            // Generate embeddings
                            const dimensions = 384;
                            vectorIndex.chunks = chunks;
                            vectorIndex.dimensions = dimensions;
                            vectorIndex.embeddings = new Float32Array(chunks.length * dimensions);
                            vectorIndex.model = 'tfidf-384';
                            
                            for (let i = 0; i < chunks.length; i++) {
                                const embedding = generateTfidfEmbedding(chunks[i].text, tfidfVocabulary, dimensions);
                                vectorIndex.embeddings.set(embedding, i * dimensions);
                                
                                if (i % 200 === 0) {
                                    log(`Embedding progress: ${i}/${chunks.length}`);
                                    // Update progress bar (85% to 99% during embeddings)
                                    const embedProgress = 85 + Math.round((i / chunks.length) * 14);
                                    chatWebviewView?.webview.postMessage({
                                        type: 'indexProgress',
                                        progress: embedProgress,
                                        message: `Building embeddings: ${i}/${chunks.length}`
                                    });
                                    await new Promise(r => setTimeout(r, 1)); // Yield
                                }
                            }
                            
                            vectorIndex.lastUpdated = new Date();
                            log(`Vector index built: ${chunks.length} chunks, ${dimensions} dimensions`);
                            
                            chatWebviewView?.webview.postMessage({
                                type: 'appendResponse',
                                text: `   ✓ Built ${chunks.length} vector embeddings (${tfidfVocabulary.terms?.size || 0} vocabulary terms)\n`
                            });
                        }
                    } catch (vectorError) {
                        log('Vector index build error (non-fatal):', vectorError.message);
                        chatWebviewView?.webview.postMessage({
                            type: 'appendResponse',
                            text: `   ⚠️ Vector index build skipped: ${vectorError.message}\n`
                        });
                    }
                    
                    // *** Show completion message AFTER all phases including vectors ***
                    const totalBuildTime = stats.buildTime || 0;
                    chatWebviewView?.webview.postMessage({
                        type: 'appendResponse',
                        text: `\n**✅ Index Build Complete**\n` +
                              `- 📁 ${stats.files} files indexed (${stats.filesSkipped || 0} skipped)\n` +
                              `- 🔧 ${stats.symbols} symbols found\n` +
                              `- ⚡ ${stats.functions} functions indexed\n` +
                              `- 🔗 ${stats.callGraphEdges || 0} call graph edges\n` +
                              `- 🔍 ${stats.invertedTerms || 0} search terms\n` +
                              `- 🧠 ${vectorIndex.chunks?.length || 0} vector embeddings\n` +
                              `- ⏱️ Built in ${totalBuildTime}ms\n\n`
                    });
                    
                    // Finalize the chat response
                    chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
                    
                    // *** Force status update with actual stats from build ***
                    log(`Index complete: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions`);
                    
                    // Send direct status update with known stats (don't rely on getStats())
                    const directStatus = {
                        text: `${stats.files} files | ${stats.symbols} symbols | ${stats.functions} funcs`,
                        mode: currentMode,
                        files: Array.from(contextFiles.entries()).map(([filePath, fileData]) => ({
                            name: pathUtils.getFileName(filePath),
                            path: filePath,
                            language: fileData.language || 'unknown'
                        })),
                        indexStats: {
                            files: stats.files,
                            symbols: stats.symbols,
                            functions: stats.functions,
                            summaries: stats.summaries || 0
                        },
                        isIndexReady: true
                    };
                    chatWebviewView?.webview.postMessage({ type: 'updateStatus', status: directStatus });
                    
                    // Also call updateChatStatus for scope status bar etc.
                    updateChatStatus();
                    
                    // Refresh tree view to ensure context files are visible
                    if (contextTreeProvider) {
                        contextTreeProvider.refresh();
                        log(`[TreeView] Refreshed after index build, contextFiles.size = ${contextFiles.size}`);
                    }
                    
                    // Send final indexProgress at 100% to trigger input enable in webview
                    chatWebviewView?.webview.postMessage({
                        type: 'indexProgress',
                        progress: 100,
                        message: 'Index ready',
                        stats: {
                            files: stats.files,
                            symbols: stats.symbols,
                            functions: stats.functions
                        }
                    });
                    
                    // *** Re-enable input explicitly ***
                    chatWebviewView?.webview.postMessage({ 
                        type: 'setIndexing', 
                        value: false 
                    });
                    
                    vscode.window.showInformationMessage(
                        `Index built: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions`
                    );
                    
                } catch (error) {
                    log('Index build error:', error);
                    vscode.window.showErrorMessage(`Index build failed: ${error.message}`);
                    
                    chatWebviewView?.webview.postMessage({
                        type: 'appendResponse',
                        text: `\n**❌ Index build failed:** ${error.message}\n`
                    });
                    chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
                    
                    chatWebviewView?.webview.postMessage({
                        type: 'indexProgress',
                        progress: 0,
                        message: 'Index failed: ' + error.message
                    });
                    
                    // *** Re-enable input even on error ***
                    chatWebviewView?.webview.postMessage({ 
                        type: 'setIndexing', 
                        value: false 
                    });
                }
            });
        }),
        
        vscode.commands.registerCommand('astra.clearIndex', () => {
            // Clear legacy indexes
            codeIndex.files.clear();
            codeIndex.symbols.clear();
            codeIndex.variables.clear();
            codeIndex.callGraph.clear();
            codeIndex.reverseCallGraph.clear();
            codeIndex.dependencies.clear();
            codeIndex.summaries.clear();
            codeIndex.fileSummaries.clear();
            codeIndex.overallSummary = null;
            
            // Clear vector and trigram indexes
            clearVectorIndex(vectorIndex);
            trigramIndex.clear();
            tfidfVocabulary.clear();
            
            // Clear inverted index
            invertedIndex.clear();
            
            // *** NEW: Clear CodebaseIndex ***
            if (codebaseIndex) {
                codebaseIndex.clear();
            }
            
            vscode.window.showInformationMessage('AstraCode indexes cleared');
            log('All indexes cleared');
        }),
        
        vscode.commands.registerCommand('astra.showIndexStats', () => {
            // Use CodebaseIndex stats primarily
            let stats;
            if (codebaseIndex) {
                stats = codebaseIndex.getStats();
            } else {
                stats = getIndexStats(codeIndex);
            }
            const vectorStats = getVectorIndexStats(vectorIndex);
            const invertedStats = invertedIndex.getStats();
            
            const message = `Files: ${stats.files} | Symbols: ${stats.symbols} | Functions: ${stats.functions} | Call Graph: ${stats.callGraphEdges || codeIndex.callGraph.size} | Trigrams: ${stats.trigramTerms || trigramIndex.index?.size || 0} | Inverted Terms: ${stats.invertedTerms || invertedStats.uniqueTerms || 0} | Vector Chunks: ${vectorStats.chunks}`;
            vscode.window.showInformationMessage(message);
            log('Index stats:', stats, vectorStats, invertedStats);
        }),
        
        vscode.commands.registerCommand('astra.showCallGraph', async () => {
            await openCallGraphInBrowser();
        }),

        vscode.commands.registerCommand('astra.openCallGraphInBrowser', async () => {
            await openCallGraphInBrowser();
        }),

        
        vscode.commands.registerCommand('astra.semanticSearch', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Enter semantic search query',
                placeHolder: 'e.g., functions that validate user input'
            });
            if (query) {
                let results = searchVectorIndex(query, vectorIndex, tfidfVocabulary, 20);
                
                // Filter to scoped files if scope is active
                const scopeStatus = scopedSearch.getScopeStatus() || { isActive: false, files: [] };
                if (scopeStatus.isActive && scopeStatus.files?.length > 0) {
                    const scopedFilePaths = new Set(scopeStatus.files.map(f => f.path));
                    results = results.filter(r => scopedFilePaths.has(r.file));
                    log(`Semantic search filtered to ${results.length} scoped results`);
                }
                
                log('Semantic search results:', results.length);
                const scopeNote = scopeStatus.isActive ? ` (scoped to "${scopeStatus.query}")` : '';
                vscode.window.showInformationMessage(`Found ${results.length} results for: ${query}${scopeNote}`);
            }
        }),
        
        vscode.commands.registerCommand('astra.toggleMode', () => {
            const modes = ['auto', 'local', 'api'];
            const currentIndex = modes.indexOf(currentMode);
            currentMode = modes[(currentIndex + 1) % modes.length];
            updateChatStatus();
            vscode.window.showInformationMessage(`AstraCode mode: ${currentMode.toUpperCase()}`);
        }),
        
        vscode.commands.registerCommand('astra.toggleVerbose', () => {
            AGENT_CONFIG.verboseSearch = !AGENT_CONFIG.verboseSearch;
            const status = AGENT_CONFIG.verboseSearch ? 'ON' : 'OFF';
            vscode.window.showInformationMessage(`AstraCode Verbose Search: ${status}`);
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n**🔧 Verbose Search Mode: ${status}**\n\n`
            });
        }),
        
        vscode.commands.registerCommand('astra.exportState', async () => {
            if (persistenceManager) {
                await persistenceManager.saveAll();
                vscode.window.showInformationMessage('AstraCode state exported');
            }
        }),
        
        vscode.commands.registerCommand('astra.showConfig', () => {
            const config = vscode.workspace.getConfiguration('astra');
            log('Current configuration:', {
                mode: config.get('mode'),
                searchMode: config.get('searchMode'),
                debugMode: config.get('debugMode'),
                enableJudge: config.get('agent.enableJudge'),
                maxIterations: config.get('agent.maxIterations'),
                verboseSearch: config.get('agent.verboseSearch')
            });
            vscode.commands.executeCommand('workbench.action.openSettings', 'astra');
        }),
        
        // *** NEW: Exit scope command (for status bar click) ***
        vscode.commands.registerCommand('astra.exitScope', () => {
            scopedSearch.scopeState.deactivate();
            updateChatStatus();
            updateScopeStatusBar();
            chatWebviewView?.webview.postMessage({
                type: 'appendResponse',
                text: '\n📂 **Scope Deactivated** - Now searching all files.\n\n'
            });
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
        }),
        
        vscode.commands.registerCommand('astra.showOutput', () => {
            outputChannel.show();
        })
    );
    
    // Register webview provider
    const chatProvider = {
        resolveWebviewView(webviewView) {
            chatWebviewView = webviewView;
            logging.setWebviewView(webviewView);
            
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [context.extensionUri],
                retainContextWhenHidden: true
            };
            
            // Set HTML content
            webviewView.webview.html = getWebviewContent();
            
            // Restore chat history after HTML is set
            restoreChatToWebview();
            
            // Handle visibility changes
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    log('Webview became visible, restoring state...');
                    restoreChatToWebview();
                    updateChatStatus();
                    contextTreeProvider?.refresh();
                }
            });
            
            // Handle webview disposal
            webviewView.onDidDispose(() => {
                log('Webview disposed, saving state...');
                if (persistenceManager) {
                    persistenceManager.saveAll().catch(err => {
                        log('Error saving state on dispose:', err.message);
                    });
                }
            });
            
            // Handle messages from webview
            webviewView.webview.onDidReceiveMessage(async (message) => {
                try {
                    switch (message.type) {
                        case 'chat':
                            await handleUserMessage(message.text);
                            break;
                        case 'setMode':
                            currentMode = message.mode;
                            updateChatStatus();
                            log('Mode changed to:', currentMode);
                            if (persistenceManager) {
                                persistenceManager.markDirty();
                            }
                            break;
                        case 'clearHistory':
                            chatHistory = [];
                            updateChatUI();
                            if (persistenceManager) {
                                persistenceManager.clearChatHistory();
                            }
                            break;
                        case 'addFiles':
                            const uris = await vscode.window.showOpenDialog({
                                canSelectMany: true,
                                canSelectFiles: true,
                                canSelectFolders: true,
                                openLabel: 'Add to AstraCode Context'
                            });
                            if (uris && uris.length > 0) {
                                for (const uri of uris) {
                                    await addToContext(uri, contextFiles, {
                                        onRefresh: () => contextTreeProvider.refresh(),
                                        onStatusUpdate: () => updateChatStatus()
                                    });
                                }
                                // Trigger index build after adding files
                                updateChatStatus();
                                // Auto-trigger index rebuild
                                vscode.commands.executeCommand('astra.rebuildIndex');
                            }
                            break;
                        case 'clearContext':
                            clearContext(contextFiles, codeIndex, {
                                onRefresh: () => contextTreeProvider.refresh(),
                                onStatusUpdate: () => updateChatStatus()
                            });
                            if (codebaseIndex) {
                                codebaseIndex.clear();
                            }
                            if (persistenceManager) {
                                persistenceManager.clearContextFiles();
                            }
                            log('Context cleared from UI');
                            break;
                        case 'removeFile':
                            if (message.path) {
                                removeFileFromContext(vscode.Uri.file(message.path), contextFiles, {
                                    onRefresh: () => contextTreeProvider.refresh(),
                                    onStatusUpdate: () => updateChatStatus()
                                });
                                if (persistenceManager) {
                                    persistenceManager.removeContextFile(message.path);
                                }
                                log('Removed file from UI:', message.path);
                            }
                            break;
                        case 'command':
                            if (message.command) {
                                vscode.commands.executeCommand(`astra.${message.command}`);
                            }
                            break;
                        case 'openFile':
                        case 'revealFile':
                            if (message.path || message.filePath) {
                                const fileUri = vscode.Uri.file(message.path || message.filePath);
                                await vscode.window.showTextDocument(fileUri);
                            }
                            break;
                        case 'setSearchMode':
                            if (message.mode) {
                                searchModule.setMode(message.mode);
                                log('Search mode set to:', message.mode);
                            }
                            break;
                        case 'getSearchMode':
                            chatWebviewView?.webview.postMessage({
                                type: 'searchMode',
                                mode: searchModule.getMode() || 'detailed'
                            });
                            break;
                        case 'executeCommand':
                            if (message.command) {
                                vscode.commands.executeCommand(message.command, ...(message.args || []));
                            }
                            break;
                        case 'openFileUri':
                            if (message.fileUri) {
                                try {
                                    const uri = vscode.Uri.parse(message.fileUri);
                                    await vscode.window.showTextDocument(uri);
                                } catch (err) {
                                    log('Error opening file URI:', err.message);
                                }
                            }
                            break;
                        case 'generateDocumentation':
                            await handleDocumentationGeneration(message);
                            break;
                        case 'cancelTask':
                            log('Cancel task requested');
                            // TODO: Implement task cancellation
                            chatWebviewView?.webview.postMessage({
                                type: 'setProcessing',
                                value: false
                            });
                            break;
                        case 'getSystemPrompt':
                            // TODO: Implement system prompt retrieval
                            chatWebviewView?.webview.postMessage({
                                type: 'systemPrompt',
                                prompt: '',
                                isCustom: false
                            });
                            break;
                        case 'setSystemPrompt':
                            // TODO: Implement system prompt setting
                            log('System prompt set:', message.prompt?.substring(0, 50));
                            break;
                        case 'resetSystemPrompt':
                            // TODO: Implement system prompt reset
                            log('System prompt reset requested');
                            break;
                            
                        // *** NEW: Handle scope selection from webview ***
                        case 'applyScopeSelection':
                            log('Applying scope selection:', message.selectedPaths?.length, 'files');
                            const scopeResult = scopedSearch.applyScopeSelection(
                                message.query,
                                message.selectedPaths
                            );
                            for (const msg of scopeResult.messages) {
                                chatWebviewView?.webview.postMessage(msg);
                            }
                            updateChatStatus();
                            break;
                    }
                } catch (error) {
                    log('Error handling webview message:', error.message);
                    vscode.window.showErrorMessage(`AstraCode error: ${error.message}`);
                }
            });
            
            // Initial status update
            updateChatStatus();
        }
    };
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('astra.chatView', chatProvider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );
    
    log('AstraCode activated');
}

// ============================================================
// Webview HTML Content (imported from webview-html.js)
// ============================================================

// getWebviewContent() is imported from './webview-html'

// ============================================================
// Message Handling (placeholder - to be completed)
// ============================================================

async function handleUserMessage(text) {
    log('User message:', text.substring(0, 100));
    
    // Debug: Test CodebaseIndex search directly
    if (codebaseIndex && codebaseIndex.stats.symbols > 0) {
        const testResults = codebaseIndex.search("partition pruning", { maxResults: 10 });
        log(`Direct CodebaseIndex test: ${testResults.symbols.length} symbols found`);
        for (const r of testResults.symbols.slice(0, 3)) {
            log(`  - ${r.name} [${r.type}] @ ${r.file}:${r.line}`);
        }
    }


    // Check for debug commands
    if (text.toLowerCase().startsWith('/debug') || text.toLowerCase().startsWith('/dump')) {
        await handleDebugCommand(text);
        return;
    }
    
    // *** NEW: Check for scope commands FIRST ***
    const scopeCmd = scopedSearch.parseScopeCommand(text);
    if (scopeCmd) {
        log('Handling scope command:', scopeCmd.type);
        
        // Ensure llmClient is initialized for LLM ranking
        if (!llmClient) {
            llmClient = new LLMClient({ llm: LLMConfig }, log);
        }
        
        // Start conversation for scope command
        chatWebviewView?.webview.postMessage({ 
            type: 'newConversation', 
            question: text 
        });
        
        // Pass all search indexes for combined semantic search + LLM ranking
        const result = await scopedSearch.handleScopeCommand(scopeCmd, codebaseIndex, { 
            log,
            invertedIndex: invertedIndex,
            vectorIndex: vectorIndex,
            vocabulary: tfidfVocabulary,
            grepIndex: searchModule.grepIndex,
            llmClient: llmClient
        });
        
        for (const msg of result.messages) {
            chatWebviewView?.webview.postMessage(msg);
        }
        
        updateChatStatus();
        chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
        return;
    }
    
    // Add user message to chat history
    chatHistory.push({
        role: 'user',
        content: text,
        timestamp: new Date()
    });
    
    // Start a new conversation in the UI (creates user message + empty assistant message)
    chatWebviewView?.webview.postMessage({ 
        type: 'newConversation', 
        question: text 
    });
    
    // Show processing indicator
    chatWebviewView?.webview.postMessage({ 
        type: 'setProcessing', 
        value: true 
    });
    
    // Helper to show progress
    const showProgressMsg = (step, detail) => {
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `⏳ ${step}${detail ? ': ' + detail : '...'}\n`
        });
        log(`Progress: ${step} ${detail || ''}`);
    };
    
    try {
        // Check if we have files indexed
        if (contextFiles.size === 0) {
            const response = "⚠️ No files in context. Please add files or a folder first using the '+' button above.";
            await appendResponseToChat(response);
            return;  // ✅ Now safe - finally will handle finalization
        }
        
        // Check CodebaseIndex first, then fall back to legacy
        const symbolCount = codebaseIndex ? codebaseIndex.stats.symbols : codeIndex.symbols.size;
        if (symbolCount === 0) {
            const response = "⚠️ Code index is empty. Please rebuild the index using the refresh button or add files to context.";
            await appendResponseToChat(response);
            return;  // ✅ Now safe - finally will handle finalization
        }
        
        // Step 1: Classify the query
        // Step 1: Extract search keywords
        showProgressMsg('Step 1/4', 'Extracting keywords');
        let keywords = [];
        try {
            keywords = extractSearchKeywords(text);
        } catch (e) {
            log('extractSearchKeywords failed, using fallback:', e.message);
        }
        
        // Fallback keyword extraction if needed
        if (!keywords || keywords.length === 0) {
            keywords = extractKeywordsFallback(text);
        }
        log('Keywords:', keywords.slice(0, 10).join(', '));
        
        // Step 2: Execute search (v8 unified search handles all query types)
        // *** NEW: Show scope info if active ***
        const scopeStatus = scopedSearch.getScopeStatus();
        if (scopeStatus && scopeStatus.isActive) {
            showProgressMsg('Step 2/4', `Searching ${scopeStatus.fileCount} scoped files`);
        } else {
            showProgressMsg('Step 2/4', `Searching ${symbolCount} symbols`);
        }
        log('Index state: symbols=' + symbolCount + ', files=' + contextFiles.size);
        let searchResults = await executeCodeSearch(text, keywords);
        
        // *** NEW: Filter results to scope ***
        searchResults = scopedSearch.filterResultsToScope(searchResults);
        if (searchResults._scopeInfo) {
            log(`Scoped search: ${searchResults._scopeInfo.filteredSymbols}/${searchResults._scopeInfo.originalSymbols} symbols`);
        }
        
        if (!searchResults || searchResults.totalResults === 0) {
            // Try one more search with just key terms
            log('Primary search found nothing, trying direct symbol lookup...');
            showProgressMsg('Step 2/4', 'Trying alternate search');
            let directResults = await tryDirectSymbolSearch(text, keywords);
            // *** NEW: Filter direct results to scope too ***
            directResults = scopedSearch.filterResultsToScope(directResults);
            if (directResults && directResults.totalResults > 0) {
                Object.assign(searchResults, directResults);
            }
        }
        
        if (!searchResults || searchResults.totalResults === 0) {
            // Clear the progress messages and show error
            chatWebviewView?.webview.postMessage({ type: 'clearLastResponse' });
            
            // *** NEW: Add scope hint if scope is active ***
            let response = `🔍 No relevant code found for: "${text.substring(0, 50)}..."\n\n`;
            if (scopeStatus && scopeStatus.isActive) {
                response += `**Note:** Search was limited to ${scopeStatus.fileCount} scoped files.\n`;
                response += `Try \`/unscope\` to search all files.\n\n`;
            }
            response += `**Suggestions:**\n` +
                       `- Try different keywords\n` +
                       `- Check if the relevant files are indexed\n` +
                       `- Use specific function or type names\n\n` +
                       `**Index stats:** ${symbolCount} symbols in ${contextFiles.size} files\n` +
                       `**Keywords tried:** ${keywords.join(', ')}`;
            await appendResponseToChat(response);
            return;  // ✅ Now safe - finally will handle finalization
        }
        
        showProgressMsg('Step 2/4', `Found ${searchResults.symbols.length} symbols, ${searchResults.codeBlocks.length} code blocks`);
        log(`Found: ${searchResults.totalResults} results`);
        
        // Show search details
        const searchDetails = formatSearchDetails(searchResults);
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: searchDetails
        });
        
        // Ensure LLM client is initialized for context building (needed for LLM-based relevance scoring)
        if (!llmClient) {
            llmClient = new LLMClient({ llm: LLMConfig }, log);
        }
        
        // Step 3: Build context for LLM (with hierarchical summarization for large contexts)
        showProgressMsg('Step 3/4', 'Building compressed context for analysis');
        const context = await buildContextForLLM(searchResults, text, {
            useHierarchical: true,
            onProgress: (msg) => {
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `⏳ ${msg}\n`
                });
            }
        });
        log(`Context size: ${(context.length / 1024).toFixed(1)}KB`);
        
        // Step 4: Generate response with LLM
        showProgressMsg('Step 4/4', 'Generating response (this may take a moment)');
        const response = await synthesizeResponse(text, context);
        
        // Clear progress and show final response
        chatWebviewView?.webview.postMessage({ type: 'clearLastResponse' });
        
        // Add to history and display
        await appendResponseToChat(response);
        
        // Update session memory
        if (sessionMemory) {
            sessionMemory.addTurn(text, response, {
                searchResults: searchResults.totalResults
            });
        }
        
        log('Query processing complete');
        
    } catch (error) {
        log('Error handling message:', error);
        console.error('Full error:', error);
        chatWebviewView?.webview.postMessage({ type: 'clearLastResponse' });
        const errorResponse = `❌ **Error processing query:** ${error.message}\n\n` +
                             `**Troubleshooting:**\n` +
                             `- Check VS Code Output panel (View → Output → AstraCode)\n` +
                             `- Verify GitHub Copilot is signed in\n` +
                             `- Or configure OpenAI/Anthropic API key in settings`;
        await appendResponseToChat(errorResponse);
        // Don't return here - let finally run
    } finally {
        // ✅ ALWAYS runs - even on early returns and exceptions
        // This is the FIX - moved from outside try/catch to finally block
        chatWebviewView?.webview.postMessage({ 
            type: 'setProcessing', 
            value: false 
        });
        chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
    }
}

/**
 * Handle debug/dump commands
 */
async function handleDebugCommand(text) {
    const cmd = text.toLowerCase().trim();
    let output = [];
    
    // Ensure search module is initialized
    initializeSearchModule();
    
    output.push('# 🔧 Debug Index Dump\n');
    
    // Basic stats - use CodebaseIndex primarily
    output.push('## Index Statistics\n');
    output.push(`- **contextFiles**: ${contextFiles.size} files`);
    
    if (codebaseIndex) {
        const stats = codebaseIndex.getStats();
        output.push(`- **CodebaseIndex.symbols**: ${stats.symbols} entries`);
        output.push(`- **CodebaseIndex.files**: ${stats.files} files`);
        output.push(`- **CodebaseIndex.functions**: ${stats.functions} functions`);
        output.push(`- **CodebaseIndex.callGraphEdges**: ${stats.callGraphEdges} edges`);
        output.push(`- **CodebaseIndex.invertedTerms**: ${stats.invertedTerms} terms`);
        output.push(`- **CodebaseIndex.trigramTerms**: ${stats.trigramTerms} trigrams`);
    } else {
        output.push(`- **codeIndex.symbols**: ${codeIndex.symbols.size} entries`);
        output.push(`- **codeIndex.files**: ${codeIndex.files.size} files`);
        output.push(`- **codeIndex.callGraph**: ${codeIndex.callGraph.size} entries`);
    }
    output.push('');
    
    // Dump contextFiles keys
    output.push('## contextFiles Keys (first 20)\n');
    output.push('```');
    let count = 0;
    for (const [key, value] of contextFiles) {
        if (count++ >= 20) break;
        const hasContent = value && value.content && value.content.length > 0;
        output.push(`${key} [${hasContent ? value.content.length + ' chars' : 'NO CONTENT'}]`);
    }
    output.push('```\n');
    
    // Test CodebaseIndex search
    output.push('## CodebaseIndex Search Test\n');
    if (codebaseIndex && codebaseIndex.stats.symbols > 0) {
        const testQuery = 'partition';
        const testResults = codebaseIndex.search(testQuery, { maxResults: 20 });
        output.push(`Query: "${testQuery}"`);
        output.push(`- Symbols found: ${testResults.symbols.length}`);
        output.push(`- Code blocks: ${testResults.codeBlocks.length}`);
        output.push(`- Stats: pattern=${testResults.stats.pattern_match}, trigram=${testResults.stats.trigram_code}, inverted=${testResults.stats.inverted_index}`);
        output.push('');
        output.push('### Top symbols:\n```');
        for (const sym of testResults.symbols.slice(0, 10)) {
            output.push(`${sym.name} [${sym.type}] @ ${sym.file}:${sym.line} (source: ${sym.matchSource})`);
        }
        output.push('```');
    } else {
        output.push('(CodebaseIndex not built or empty)');
    }
    output.push('');
    
    // Dump symbols containing "partition" or "prune"
    output.push('## Symbols containing "partition" or "prune"\n');
    output.push('```');
    let partitionSymbols = 0;
    const symbolSource = codebaseIndex ? codebaseIndex.symbols : codeIndex.symbols;
    for (const [key, sym] of symbolSource) {
        const keyLower = key.toLowerCase();
        const nameLower = (sym.name || '').toLowerCase();
        if (keyLower.includes('partition') || keyLower.includes('prune') ||
            nameLower.includes('partition') || nameLower.includes('prune')) {
            output.push(`${sym.name} [${sym.type}] @ ${sym.file}:${sym.line}`);
            partitionSymbols++;
            if (partitionSymbols >= 30) {
                output.push('... (truncated)');
                break;
            }
        }
    }
    if (partitionSymbols === 0) {
        output.push('(none found)');
    }
    output.push('```\n');
    
    // Dump files containing "partprune" or "partition"
    output.push('## Files with "partition" or "prune" in path\n');
    output.push('```');
    let partitionFiles = 0;
    for (const [key, value] of contextFiles) {
        if (key.toLowerCase().includes('partition') || key.toLowerCase().includes('prune')) {
            const hasContent = value && value.content && value.content.length > 0;
            output.push(`${key} [${hasContent ? value.content.length + ' chars' : 'NO CONTENT'}]`);
            partitionFiles++;
        }
    }
    if (partitionFiles === 0) {
        output.push('(none found)');
    }
    output.push('```\n');
    
    // Check inverted index in CodebaseIndex
    output.push('## Inverted Index Sample\n');
    if (codebaseIndex && codebaseIndex.invertedIndex) {
        const invIdx = codebaseIndex.invertedIndex;
        output.push(`- **Total terms**: ${invIdx.index?.size || 0}`);
        output.push('');
        output.push('### Terms containing "partition" or "prune":\n');
        output.push('```');
        let termCount = 0;
        if (invIdx.index) {
            for (const [term, postings] of invIdx.index) {
                if (term.includes('partition') || term.includes('prune')) {
                    const docCount = postings.size || postings.length || 0;
                    output.push(`"${term}" -> ${docCount} docs`);
                    termCount++;
                    if (termCount >= 20) break;
                }
            }
        }
        if (termCount === 0) {
            output.push('(no partition/prune terms found)');
        }
        output.push('```');
    } else {
        output.push('(CodebaseIndex inverted index not available)');
    }
    output.push('');
    
    // Dump symbols from partprune.c specifically
    output.push('## Symbols from partprune.c\n');
    output.push('```');
    let partpruneSymbols = 0;
    for (const [key, sym] of symbolSource) {
        if (sym.file && sym.file.includes('partprune.c')) {
            output.push(`${sym.name} [${sym.type}] @ line ${sym.line}`);
            partpruneSymbols++;
            if (partpruneSymbols >= 15) {
                output.push('... (more)');
                break;
            }
        }
    }
    if (partpruneSymbols === 0) {
        output.push('(none found - partprune.c symbols missing from index!)');
    } else {
        output.push(`Total: ${partpruneSymbols}+ symbols from partprune.c`);
    }
    output.push('```\n');
    
    // Check search module state
    output.push('## Search Module State\n');
    output.push('```');
    output.push(`searchModule exists: ${!!searchModule}`);
    output.push(`searchModule.getMode(): ${searchModule.getMode?.() || 'N/A'}`);
    output.push(`searchModule.getStats(): ${JSON.stringify(searchModule.getStats?.() || {})}`);
    output.push(`codebaseIndex exists: ${!!codebaseIndex}`);
    output.push(`extension contextFiles has: ${contextFiles.size} files`);
    output.push('```\n');
    
    // Test code block fetch for a known symbol
    output.push('## Code Block Fetch Test\n');
    let testSymbol = null;
    for (const [key, sym] of symbolSource) {
        if (sym.name?.toLowerCase().includes('partition') && sym.type === 'function') {
            testSymbol = sym;
            break;
        }
    }
    if (testSymbol) {
        output.push(`Testing fetch for: \`${testSymbol.name}\` @ ${testSymbol.file}:${testSymbol.line}\n`);
        try {
            const block = searchModule.getCodeBlock(testSymbol, { contextAfter: 10 });
            if (block && block.code && block.code.length > 0) {
                output.push('✅ Code block fetched successfully:');
                output.push('```c');
                output.push(block.code.substring(0, 500));
                if (block.code.length > 500) output.push('... (truncated)');
                output.push('```');
            } else {
                output.push('❌ Code block is empty');
                output.push(`- contextFiles.has("${testSymbol.file}"): ${contextFiles.has(testSymbol.file)}`);
            }
        } catch (e) {
            output.push(`❌ Error: ${e.message}`);
        }
    } else {
        output.push('(no partition function found to test)');
    }
    
    // Send output to chat
    await appendResponseToChat(output.join('\n'));
    
    chatWebviewView?.webview.postMessage({ 
        type: 'setProcessing', 
        value: false 
    });
    chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
}

/**
 * Handle documentation generation requests from webview
 * 
 * Supports:
 * - 'business' - Full business documentation with technical sprinkles
 * - 'useCases' - Use cases, personas, requirements
 * - 'technical' - Technical API documentation
 * - 'businessSummary' - Quick business summary
 * - 'useCasesSummary' - Quick use cases summary
 */
async function handleDocumentationGeneration(message) {
    const docType = message.docType || 'business';
    const moduleName = message.moduleName || 'Codebase';
    const focusArea = message.focusArea || '';  // Optional: specific functionality
    const options = message.options || {};
    
    log(`Documentation generation: ${docType} for "${moduleName}"${focusArea ? ` (focus: ${focusArea})` : ''}`);
    
    // Show processing
    chatWebviewView?.webview.postMessage({ 
        type: 'setProcessing', 
        value: true 
    });
    
    // Start chat message
    const requestDesc = focusArea 
        ? `Generate ${getDocTypeName(docType)} for "${moduleName}" → "${focusArea}"`
        : `Generate ${getDocTypeName(docType)} for "${moduleName}"`;
    
    chatWebviewView?.webview.postMessage({ 
        type: 'newConversation', 
        question: requestDesc
    });
    
    try {
        // Check prerequisites
        if (contextFiles.size === 0) {
            chatWebviewView?.webview.postMessage({
                type: 'appendResponse',
                text: "⚠️ **No files in context.** Please add files first using the '+' button.\n"
            });
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            return;
        }
        
        const symbolCount = codebaseIndex ? codebaseIndex.stats.symbols : codeIndex.symbols.size;
        if (symbolCount === 0) {
            chatWebviewView?.webview.postMessage({
                type: 'appendResponse',
                text: "⚠️ **Code index is empty.** Please rebuild the index (refresh button).\n"
            });
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            return;
        }
        
        // Initialize LLM
        if (!llmClient) {
            llmClient = new LLMClient({ llm: LLMConfig }, log);
        }
        
        // Progress updates
        const onProgress = (msg) => {
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `⏳ ${msg}\n`
            });
        };
        
        onProgress(`Preparing ${getDocTypeName(docType)}...`);
        
        // Get scoped files if scope is active, otherwise use all contextFiles
        const scopeStatus = scopedSearch.getScopeStatus() || { isActive: false, query: '', fileCount: 0, files: [] };
        const filesToUse = scopedSearch.getScopedFiles(contextFiles);
        
        // When scope is active, use scope query as focus area (unless explicitly provided)
        const effectiveFocusArea = focusArea || (scopeStatus.isActive ? scopeStatus.query : '');
        
        if (scopeStatus.isActive && filesToUse.size > 0) {
            onProgress(`Using ${filesToUse.size} scoped files (from /grep "${scopeStatus.query}")`);
            log(`[DocGen] Scope active: query="${scopeStatus.query}", focusArea="${effectiveFocusArea}"`);
        }
        
        // Create generator
        const { DocGenerator, DOC_TYPES } = require('./doc-generator');
        const generator = new DocGenerator({
            llmClient: llmClient,
            codebaseIndex: codebaseIndex,
            contextFiles: filesToUse,  // Use scoped files
            log: log,
            onProgress: onProgress
        });
        
        // Generate documentation
        let result;
        const genOptions = {
            focusArea: effectiveFocusArea,
            openInEditor: true,
            ...options
        };
        
        switch (docType) {
            case 'business':
            case 'BUSINESS':
                result = await generator.generateBusinessDoc(moduleName, genOptions);
                break;
                
            case 'useCases':
            case 'USE_CASES':
                result = await generator.generateUseCases(moduleName, genOptions);
                break;
                
            case 'technical':
            case 'TECHNICAL':
                result = await generator.generateTechnicalDoc(moduleName, genOptions);
                break;
                
            case 'businessRules':
            case 'BUSINESS_RULES':
                result = await generator.extractBusinessRules(focusArea || moduleName, genOptions);
                break;
                
            case 'businessSummary':
                result = await generator.generateBusinessSummary(moduleName);
                break;
                
            case 'useCasesSummary':
                result = await generator.generateUseCasesSummary(moduleName);
                break;
                
            default:
                result = await generator.generateBusinessDoc(moduleName, genOptions);
        }
        
        // Clear progress messages
        chatWebviewView?.webview.postMessage({ type: 'clearLastResponse' });
        
        // Show result in chat with link
        const { documentation, filePath, title } = result;
        
        // Build response message
        let responseMsg = '';
        
        if (filePath) {
            responseMsg = `✅ **${title || 'Documentation'}** generated and opened in editor.\n\n`;
            responseMsg += `📄 **File:** \`${filePath}\`\n\n`;
            responseMsg += `---\n\n`;
            responseMsg += `*Preview (full document in editor):*\n\n`;
            responseMsg += documentation.substring(0, 2000);
            if (documentation.length > 2000) {
                responseMsg += `\n\n*... [${documentation.length - 2000} more characters in editor]*`;
            }
        } else {
            // No file opened, show full content in chat
            responseMsg = `📄 **${title || 'Documentation'}**\n\n`;
            responseMsg += documentation;
        }
        
        // Add to chat history
        chatHistory.push({
            role: 'assistant',
            content: responseMsg,
            timestamp: new Date()
        });
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: responseMsg 
        });
        
        log(`Documentation complete: ${documentation.length} chars, file: ${filePath || 'none'}`);
        
    } catch (error) {
        log('Documentation generation error:', error);
        chatWebviewView?.webview.postMessage({ type: 'clearLastResponse' });
        chatWebviewView?.webview.postMessage({
            type: 'appendResponse',
            text: `❌ **Error generating documentation:** ${error.message}\n\n` +
                  `**Troubleshooting:**\n` +
                  `- Ensure an LLM provider is configured\n` +
                  `- Check that files are in context\n` +
                  `- Try a different search term\n` +
                  `- Try rebuilding the index\n`
        });
    } finally {
        chatWebviewView?.webview.postMessage({ 
            type: 'setProcessing', 
            value: false 
        });
        chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
    }
}

/**
 * Get human-readable doc type name
 */
function getDocTypeName(docType) {
    const names = {
        'business': 'Business Documentation',
        'useCases': 'Use Cases & Requirements',
        'technical': 'Technical Documentation',
        'businessSummary': 'Business Summary',
        'useCasesSummary': 'Use Cases Summary',
        'businessRules': 'Business Rules'
    };
    return names[docType] || 'Documentation';
}


/**
 * Open call graph visualization in browser
 */
async function openCallGraphInBrowser() {
    log('[Graph] Starting openCallGraphInBrowser...');
    
    // Check if we have data
    const callGraphSize = codebaseIndex ? codebaseIndex.callGraph.size : codeIndex.callGraph.size;
    
    log(`[Graph] callGraphSize=${callGraphSize}, contextFiles.size=${contextFiles.size}`);
    
    if (callGraphSize === 0) {
        vscode.window.showWarningMessage(
            'Call graph is empty. Please add files to context and rebuild the index first.'
        );
        return;
    }
    
    // Check scope status (with null safety)
    const scopeStatus = scopedSearch.getScopeStatus() || { isActive: false, query: '', fileCount: 0, files: [] };
    log(`[Graph] scopeStatus.isActive=${scopeStatus.isActive}, scopeStatus.fileCount=${scopeStatus.fileCount}`);
    
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Call Graph',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Building visualization...' });
            
            let filePath;
            let graphEdgeCount = 0;
            let title = `Call Graph - ${contextFiles.size} files`;
            
            // Use codebaseIndex if available
            if (codebaseIndex && codebaseIndex.callGraph.size > 0) {
                // Check if scope is active and we want to filter
                if (scopeStatus && scopeStatus.isActive && scopeStatus.fileCount > 0) {
                    log('[Graph] Filtering call graph for scoped files...');
                    log(`[Graph] Scope query: "${scopeStatus.query}", files: ${scopeStatus.fileCount}`);
                    
                    // Get scoped file paths
                    const scopedPaths = new Set(scopeStatus.files.map(f => f.path));
                    log(`[Graph] Scoped paths sample: ${Array.from(scopedPaths).slice(0, 3).join(', ')}`);
                    
                    // Build suffix set for flexible path matching
                    const scopeSuffixes = new Set();
                    for (const p of scopedPaths) {
                        scopeSuffixes.add(p);
                        const parts = p.split('/').filter(Boolean);
                        for (let i = 0; i < Math.min(parts.length, 5); i++) {
                            scopeSuffixes.add(parts.slice(-(i + 1)).join('/'));
                        }
                    }
                    log(`[Graph] Built ${scopeSuffixes.size} suffixes for matching`);
                    
                    // Check a sample symbol's file path
                    const sampleFunc = codebaseIndex.callGraph.keys().next().value;
                    if (sampleFunc) {
                        const sampleSym = codebaseIndex.symbols.get(sampleFunc);
                        log(`[Graph] Sample symbol: ${sampleFunc}, file: ${sampleSym?.file}`);
                    }
                    
                    // Helper to check if a file path matches scoped files
                    const matchesScope = (filePath) => {
                        if (!filePath) return false;
                        if (scopeSuffixes.has(filePath)) return true;
                        const parts = filePath.split('/').filter(Boolean);
                        for (let i = 0; i < Math.min(parts.length, 5); i++) {
                            if (scopeSuffixes.has(parts.slice(-(i + 1)).join('/'))) return true;
                        }
                        return false;
                    };
                    
                    // Filter call graph
                    const filteredCallGraph = new Map();
                    const filteredReverseCallGraph = new Map();
                    let matchCount = 0;
                    let skipCount = 0;
                    
                    for (const [func, callees] of codebaseIndex.callGraph) {
                        const sym = codebaseIndex.symbols.get(func);
                        if (matchesScope(sym?.file)) {
                            matchCount++;
                            // Convert Set to Array for filtering
                            const calleesArray = Array.from(callees);
                            const filteredCallees = calleesArray.filter(callee => {
                                const calleeSym = codebaseIndex.symbols.get(callee);
                                return matchesScope(calleeSym?.file);
                            });
                            if (filteredCallees.length > 0) {
                                // Store as Set for compatibility with visualizer
                                filteredCallGraph.set(func, new Set(filteredCallees));
                                for (const callee of filteredCallees) {
                                    if (!filteredReverseCallGraph.has(callee)) {
                                        filteredReverseCallGraph.set(callee, new Set());
                                    }
                                    filteredReverseCallGraph.get(callee).add(func);
                                }
                            }
                        } else {
                            skipCount++;
                            if (skipCount <= 2) {
                                log(`[Graph] Skip: ${func} (file: ${sym?.file})`);
                            }
                        }
                    }
                    
                    log(`[Graph] Matched ${matchCount} funcs, skipped ${skipCount}, filtered graph: ${filteredCallGraph.size}`);
                    
                    if (filteredCallGraph.size > 0) {
                        title = `Call Graph - ${scopedPaths.size} scoped files (${scopeStatus.query})`;
                        graphEdgeCount = filteredCallGraph.size;
                        
                        const graphData = {
                            callGraph: filteredCallGraph,
                            reverseCallGraph: filteredReverseCallGraph,
                            symbols: codebaseIndex.symbols
                        };
                        filePath = generateCallGraphFile(graphData, { title });
                    } else {
                        // No functions matched scope - fall back to full graph
                        log('[Graph] No functions matched scope, showing full graph');
                        vscode.window.showWarningMessage('No functions matched scope - showing full call graph');
                        graphEdgeCount = codebaseIndex.callGraph.size;
                        filePath = generateCallGraphFile(codebaseIndex, { title: `Call Graph - ${contextFiles.size} files` });
                    }
                } else {
                    // No scope active - use full codebaseIndex
                    log('[Graph] No scope active, using full call graph');
                    graphEdgeCount = codebaseIndex.callGraph.size;
                    filePath = generateCallGraphFile(codebaseIndex, { title });
                }
            } else {
                // Fallback to legacy codeIndex
                log('[Graph] Using legacy codeIndex');
                graphEdgeCount = codeIndex.callGraph.size;
                const html = generateCallGraphHTML({
                    callGraph: codeIndex.callGraph,
                    reverseCallGraph: codeIndex.reverseCallGraph,
                    symbols: codeIndex.symbols,
                    title: title
                });
                filePath = saveCallGraphToFile(html);
            }
            
            log(`[Graph] Graph saved to: ${filePath}`);
            
            // Open in default browser
            const uri = vscode.Uri.file(filePath);
            await vscode.env.openExternal(uri);
            
            const scopeNote = scopeStatus.isActive ? ` (scoped to "${scopeStatus.query}")` : '';
            vscode.window.showInformationMessage(
                `Call graph opened in browser (${graphEdgeCount} relationships)${scopeNote}`
            );
        });
        
    } catch (error) {
        log('[Graph] Error generating call graph:', error);
        vscode.window.showErrorMessage(`Failed to generate call graph: ${error.message}`);
    }
}

/**
 * Execute search against code index (v8 unified search)
 */
async function executeCodeSearch(query, keywords) {
    const results = {
        symbols: [],
        codeBlocks: [],
        files: [],
        summaries: [],
        totalResults: 0,
        // New: for callers/callees queries
        specialSearchType: null,
        preformattedContext: null
    };
    
    // Ensure search module is initialized with CodebaseIndex
    initializeSearchModule();
    
    try {
        // Primary: Use CodebaseIndex.search() via searchModule
        log('Running executeDetailedSearch via CodebaseIndex...');
        const detailedResults = searchModule.executeSearch(query, {
            mode: 'detailed',
            maxResults: 50
        });
        
        // Check if this is a special search type (callers/callees/literal/regex)
        if (detailedResults && detailedResults.type) {
            const searchType = detailedResults.type;
            
            if (searchType === 'callers' || searchType === 'callees') {
                log(`Special search type: ${searchType}`);
                results.specialSearchType = searchType;
                results.preformattedContext = detailedResults.context;
                
                // Convert callers/callees results to symbols format for compatibility
                if (searchType === 'callers') {
                    // Add call sites as symbols
                    for (const site of (detailedResults.callSites || [])) {
                        results.symbols.push({
                            name: site.enclosingFunction?.name || `call at ${site.line}`,
                            file: site.file,
                            line: site.line,
                            type: 'call_site',
                            context: site.context
                        });
                    }
                    // Add caller functions
                    for (const caller of (detailedResults.callerFunctions || [])) {
                        results.symbols.push({
                            name: caller.name,
                            file: caller.file,
                            line: caller.line,
                            type: caller.type || 'function',
                            summary: caller.summary
                        });
                    }
                    // Add suggestions
                    for (const suggestion of (detailedResults.suggestions || [])) {
                        results.symbols.push({
                            name: suggestion.name,
                            file: suggestion.file,
                            line: suggestion.line,
                            type: suggestion.type || 'function',
                            matchScore: suggestion.score,
                            isSuggestion: true
                        });
                    }
                } else if (searchType === 'callees') {
                    for (const callee of (detailedResults.callees || [])) {
                        results.symbols.push({
                            name: callee.name,
                            file: callee.file,
                            line: callee.line,
                            type: callee.type || 'function',
                            summary: callee.summary
                        });
                    }
                }
                
                results.totalResults = results.symbols.length;
                log(`${searchType} search found: ${results.symbols.length} results`);
                
                // For callers/callees, we have pre-formatted context, so skip additional searches
                // unless we found no results
                if (results.symbols.length > 0 || detailedResults.suggestions?.length > 0) {
                    return results;
                }
            }
        }
        
        // Standard semantic search results
        if (detailedResults) {
            results.symbols = detailedResults.symbols || [];
            results.codeBlocks = detailedResults.codeBlocks || [];
            log(`DetailedSearch found: ${results.symbols.length} symbols, ${results.codeBlocks.length} code blocks`);
            
            // Log search stats if available
            if (detailedResults.stats) {
                log(`Search stats: pattern=${detailedResults.stats.pattern_match}, trigram=${detailedResults.stats.trigram_code}, inverted=${detailedResults.stats.inverted_index}`);
            }
        }
        
        // Secondary: Search by file pattern for related files
        log('Running file pattern search...');
        
        // Extract likely file name patterns from query
        const filePatterns = [];
        const queryLower = query.toLowerCase();
        
        // Add direct matches from keywords
        for (const kw of keywords) {
            if (kw.length >= 4) {
                filePatterns.push(kw);
            }
        }
        
        // Add combined patterns (e.g., "partition pruning" -> "partprune")
        if (queryLower.includes('partition') && queryLower.includes('prun')) {
            filePatterns.push('partprune');
        }
        if (queryLower.includes('partition')) {
            filePatterns.push('partition');
            filePatterns.push('partbound');
        }
        
        // Search for each pattern in contextFiles
        const matchedFiles = new Set();
        for (const pattern of [...new Set(filePatterns)]) {
            for (const [filePath] of contextFiles) {
                if (filePath.toLowerCase().includes(pattern.toLowerCase())) {
                    matchedFiles.add(filePath);
                }
            }
        }
        
        if (matchedFiles.size > 0) {
            for (const filePath of matchedFiles) {
                if (!results.files.some(f => f === filePath)) {
                    results.files.push(filePath);
                    
                    // Get symbols from this file using CodebaseIndex
                    if (codebaseIndex) {
                        for (const [key, sym] of codebaseIndex.symbols) {
                            if (sym.file === filePath) {
                                if (isGarbageSymbol(sym.name)) continue;
                                if (!results.symbols.some(s => s.name === sym.name && s.file === sym.file)) {
                                    results.symbols.push(sym);
                                }
                            }
                        }
                    }
                }
            }
            log(`File search found: ${matchedFiles.size} files`);
        }
        
        // Tertiary: Direct keyword-based symbol search using CodebaseIndex
        log('Running symbol pattern search for keywords...');
        if (codebaseIndex) {
            for (const keyword of keywords.slice(0, 5)) {
                if (keyword.length < 3) continue;
                // Search CodebaseIndex directly
                const keywordResults = codebaseIndex.search(keyword, { maxResults: 15 });
                for (const sym of keywordResults.symbols) {
                    if (!results.symbols.some(s => s.name === sym.name && s.file === sym.file)) {
                        results.symbols.push(sym);
                    }
                }
            }
        }
        
        // Quaternary: Fuzzy symbol search on full query (legacy fallback)
        log('Running fuzzy symbol search...');
        const fuzzyMatches = fuzzySearchSymbols(query, codeIndex, null, 20, 25);
        if (fuzzyMatches.length > 0) {
            for (const sym of fuzzyMatches) {
                if (!results.symbols.some(s => s.name === sym.name)) {
                    results.symbols.push(sym);
                }
            }
            log(`Fuzzy search found: ${fuzzyMatches.length} symbols`);
        }
        
        // Get code blocks for symbols that don't have them yet
        log('Fetching code blocks for symbols...');
        log(`contextFiles has ${contextFiles.size} files`);
        
        const seenBlocks = new Set(results.codeBlocks.map(b => `${b.file}:${b.line}`));
        let blocksAdded = 0;
        let blocksFailed = 0;
        
        for (const sym of results.symbols.slice(0, 30)) {
            const key = `${sym.file}:${sym.line}`;
            if (!seenBlocks.has(key) && sym.file && sym.line) {
                try {
                    // Use searchModule.getCodeBlock (which delegates to CodebaseIndex)
                    let block = searchModule.getCodeBlock(sym, { contextAfter: 40 });
                    
                    // If that returns empty, try reading file directly from contextFiles
                    if (!block || !block.code || block.code.length === 0) {
                        let fileContent = null;
                        
                        // Try exact match
                        const fileData = contextFiles.get(sym.file);
                        if (fileData && fileData.content) {
                            fileContent = fileData.content;
                        } else {
                            // Try matching by filename only
                            const fileName = pathUtils.getFileName(sym.file);
                            for (const [path, data] of contextFiles) {
                                if (path.endsWith(fileName) || path.endsWith('/' + fileName)) {
                                    fileContent = data.content;
                                    break;
                                }
                            }
                        }
                        
                        if (fileContent) {
                            const lines = fileContent.split('\n');
                            const startLine = Math.max(0, sym.line - 3);
                            const endLine = Math.min(lines.length, sym.line + 40);
                            const codeSnippet = lines.slice(startLine, endLine)
                                .map((line, i) => `${(startLine + i + 1).toString().padStart(5)}: ${line}`)
                                .join('\n');
                            block = { code: codeSnippet };
                        }
                    }
                    
                    if (block && block.code && block.code.length > 0) {
                        results.codeBlocks.push({
                            file: sym.file,
                            line: sym.line,
                            symbol: sym.name,
                            type: sym.type,
                            code: block.code
                        });
                        seenBlocks.add(key);
                        blocksAdded++;
                    } else {
                        blocksFailed++;
                    }
                } catch (e) {
                    log(`Failed to get code block for ${sym.name}: ${e.message}`);
                    blocksFailed++;
                }
            }
        }
        log(`Code blocks: ${blocksAdded} added, ${blocksFailed} failed`);
        
        results.totalResults = results.symbols.length + results.codeBlocks.length + 
                              results.files.length + results.summaries.length;
        
        log(`Total search results: ${results.totalResults}`);
        
        // Final deduplication pass
        const dedupedResults = deduplicateSearchResults(results);
        log(`After dedup: ${dedupedResults.symbols.length} symbols, ${dedupedResults.codeBlocks.length} code blocks`);
        
        return dedupedResults;
        
    } catch (error) {
        log('Search error:', error.message);
        console.error('Full search error:', error);
    }
    
    return results;
}

/**
 * Deduplicate search results to prevent redundant content in LLM context
 */
function deduplicateSearchResults(results) {
    const deduped = {
        symbols: [],
        codeBlocks: [],
        files: [...new Set(results.files)], // Simple array dedup
        summaries: results.summaries,
        totalResults: 0,
        specialSearchType: results.specialSearchType,
        preformattedContext: results.preformattedContext
    };
    
    // Deduplicate symbols by file:line (most accurate) and name
    const seenSymbols = new Map(); // key: "file:line" or "name" -> symbol
    const seenSymbolNames = new Set(); // Track names for same-name-different-location
    
    for (const sym of results.symbols) {
        const locationKey = sym.file && sym.line ? `${sym.file}:${sym.line}` : null;
        const nameKey = sym.name?.toLowerCase();
        
        // Skip if exact same location already seen
        if (locationKey && seenSymbols.has(locationKey)) {
            continue;
        }
        
        // For symbols without location, dedupe by name
        if (!locationKey && seenSymbolNames.has(nameKey)) {
            continue;
        }
        
        // If same name exists but different location, keep both (could be overloads)
        // but limit to 3 per name to prevent spam
        const sameNameCount = deduped.symbols.filter(s => 
            s.name?.toLowerCase() === nameKey
        ).length;
        
        if (sameNameCount >= 3) {
            continue;
        }
        
        deduped.symbols.push(sym);
        if (locationKey) seenSymbols.set(locationKey, sym);
        if (nameKey) seenSymbolNames.add(nameKey);
    }
    
    // Deduplicate code blocks - merge overlapping ranges in same file
    const blocksByFile = new Map(); // file -> array of {startLine, endLine, block}
    
    for (const block of results.codeBlocks) {
        if (!block.file || !block.line) {
            deduped.codeBlocks.push(block);
            continue;
        }
        
        // Estimate end line from code content
        const lineCount = (block.code?.split('\n') || []).length;
        const startLine = block.line;
        const endLine = block.line + lineCount;
        
        if (!blocksByFile.has(block.file)) {
            blocksByFile.set(block.file, []);
        }
        
        const fileBlocks = blocksByFile.get(block.file);
        
        // Check for overlap with existing blocks
        let merged = false;
        for (let i = 0; i < fileBlocks.length; i++) {
            const existing = fileBlocks[i];
            
            // Check if ranges overlap (with 5-line tolerance for nearby blocks)
            const tolerance = 5;
            if (startLine <= existing.endLine + tolerance && 
                endLine >= existing.startLine - tolerance) {
                // Merge: keep the larger block or expand range
                if (lineCount > (existing.endLine - existing.startLine)) {
                    // New block is larger, replace
                    fileBlocks[i] = { startLine, endLine, block };
                }
                // Otherwise keep existing (it's larger or equal)
                merged = true;
                break;
            }
        }
        
        if (!merged) {
            fileBlocks.push({ startLine, endLine, block });
        }
    }
    
    // Flatten deduplicated blocks
    for (const [file, fileBlocks] of blocksByFile) {
        for (const { block } of fileBlocks) {
            deduped.codeBlocks.push(block);
        }
    }
    
    // Sort code blocks by file then line for consistent ordering
    deduped.codeBlocks.sort((a, b) => {
        const fileCompare = (a.file || '').localeCompare(b.file || '');
        if (fileCompare !== 0) return fileCompare;
        return (a.line || 0) - (b.line || 0);
    });
    
    // Update total
    deduped.totalResults = deduped.symbols.length + deduped.codeBlocks.length + 
                          deduped.files.length + deduped.summaries.length;
    
    return deduped;
}

/**
 * Build context string for LLM from search results
 * Uses hierarchical summarization if context is too large
 */
async function buildContextForLLM(searchResults, query, options = {}) {
    const { useHierarchical = true, onProgress = null } = options;
    
    // If we have a pre-formatted context from callers/callees search, use it directly
    if (searchResults.preformattedContext && searchResults.specialSearchType) {
        log(`Using pre-formatted context for ${searchResults.specialSearchType} search`);
        log(`Context size: ${(searchResults.preformattedContext.length / 1024).toFixed(1)}KB`);
        return searchResults.preformattedContext;
    }
    
    const result = await buildContext(searchResults, query, {
        llmClient: llmClient,
        log: log,
        onProgress: onProgress,
        maxContextChars: 48000
    });
    
    log(`Context builder: ${result.stats.method} method`);
    log(`Context builder: ${result.stats.primarySymbols} primary (verbatim)`);
    log(`Context size: ${(result.stats.finalSize / 1024).toFixed(1)}KB`);
    
    return result.context;
}

/**
 * Smart truncation that preserves important information
 */
function smartTruncateContext(context, maxChars) {
    if (context.length <= maxChars) return context;
    
    const lines = context.split('\n');
    const result = [];
    let currentSize = 0;
    
    // Priority 1: Headers and structure definitions (first 40%)
    for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('**') || 
            line.includes('struct ') || line.includes('typedef ') ||
            line.includes('function:') || line.includes('procedure:')) {
            if (currentSize + line.length < maxChars * 0.4) {
                result.push(line);
                currentSize += line.length + 1;
            }
        }
    }
    
    // Priority 2: Function signatures and summaries (next 30%)
    for (const line of lines) {
        if ((line.includes('Signature:') || line.includes('Summary:') || 
             line.match(/^### \w+:/)) && !result.includes(line)) {
            if (currentSize + line.length < maxChars * 0.7) {
                result.push(line);
                currentSize += line.length + 1;
            }
        }
    }
    
    // Priority 3: Code blocks (remaining space)
    let inCodeBlock = false;
    let codeBlockContent = [];
    for (const line of lines) {
        if (line.startsWith('```')) {
            if (inCodeBlock && codeBlockContent.length > 0) {
                const block = codeBlockContent.join('\n');
                if (currentSize + block.length < maxChars) {
                    result.push('```');
                    result.push(...codeBlockContent.slice(0, 30)); // Max 30 lines per block
                    result.push('```');
                    currentSize += block.length;
                }
                codeBlockContent = [];
            }
            inCodeBlock = !inCodeBlock;
        } else if (inCodeBlock) {
            codeBlockContent.push(line);
        }
    }
    
    return result.join('\n') + '\n\n[Context truncated for size]';
}

/**
 * Format a symbol with its actual code
 */
function formatSymbolWithCode(sym) {
    // Null check for file
    const filePath = sym.file || 'unknown';
    const lang = filePath !== 'unknown' ? (detectLanguage(filePath) || 'c') : 'c';
    let text = `### ${sym.type}: \`${sym.name}\`\n`;
    text += `**File:** ${filePath}:${sym.line || 0}\n`;
    if (sym.signature) {
        text += `**Signature:** \`${sym.signature}\`\n`;
    }
    
    // Get actual code using searchModule.getCodeBlock
    try {
        if (sym.file && sym.line) {
            const codeBlock = searchModule.getCodeBlock(sym, { contextAfter: 40 });
            if (codeBlock && codeBlock.code) {
                text += `\`\`\`${lang}\n${codeBlock.code}\n\`\`\`\n`;
            }
        }
    } catch (e) {
        // Ignore code fetch errors
        log(`formatSymbolWithCode error for ${sym.name}: ${e.message}`);
    }
    
    return text + '\n';
}

/**
 * Format a code block with context
 */
function formatCodeBlockWithContext(block) {
    // Null checks
    const filePath = block.file || 'unknown';
    const lang = filePath !== 'unknown' ? (detectLanguage(filePath) || 'c') : 'c';
    let text = `### ${filePath}:${block.line || 0}`;
    if (block.function || block.symbol) {
        text += ` (in \`${block.function || block.symbol}\`)`;
    }
    text += '\n';
    const codeContent = block.code || block.text || '// No code available';
    text += `\`\`\`${lang}\n${codeContent}\n\`\`\`\n`;
    return text + '\n';
}

/**
 * Synthesize response using LLM
 */
async function synthesizeResponse(query, context) {
    // Ensure LLM client exists
    if (!llmClient) {
        // LLMClient expects config.llm, so wrap LLMConfig
        llmClient = new LLMClient({ llm: LLMConfig }, log);
    }
    
    // Check availability
    let isAvailable = false;
    try {
        isAvailable = await llmClient.isAvailable();
    } catch (e) {
        log('Error checking LLM availability:', e.message);
    }
    
    if (!isAvailable) {
        log('No LLM available, returning search results only');
        return formatFallbackResponse(query, context);
    }
    
    // Build prompts
    const systemPrompt = PromptLibrary.system.default();
    const symbolCount = codebaseIndex ? codebaseIndex.stats.symbols : codeIndex.symbols.size;
    const callGraphSize = codebaseIndex ? codebaseIndex.stats.callGraphEdges : codeIndex.callGraph.size;
    const indexSummary = `Index: ${symbolCount} symbols, ${contextFiles.size} files, ${callGraphSize} call graph entries`;
    const userPrompt = PromptLibrary.query.directQuestion(context, indexSummary, query);
    
    log(`Calling LLM with prompt size: ${(userPrompt.length / 1024).toFixed(1)}KB`);
    
    try {
        const startTime = Date.now();
        
        const response = await llmClient.completeForAnalysis(userPrompt, {
            systemPrompt: systemPrompt
        });

        const elapsed = Date.now() - startTime;
        const modelName = llmClient.getModelDisplayName();
        log(`LLM response in ${elapsed}ms from ${modelName}`);
        
        if (!response || response.length === 0) {
            log('LLM returned empty response');
            return formatFallbackResponse(query, context);
        }
        
        // Add model attribution to response
        const modelAttribution = `\n\n---\n*Generated by ${modelName} in ${(elapsed/1000).toFixed(1)}s*`;
        return response + modelAttribution;
        
    } catch (error) {
        log('LLM synthesis failed:', error.message);
        console.error('Full LLM error:', error);
        return formatFallbackResponse(query, context);
    }
}

/**
 * Format search details for display
 */
function formatSearchDetails(searchResults) {
    const lines = ['\n📊 **Search Results:**\n'];
    
    // Files found
    const filesFound = new Set();
    for (const sym of searchResults.symbols || []) {
        if (sym.file) {
            const fileName = pathUtils.getFileName(sym.file);
            filesFound.add(fileName);
        }
    }
    
    if (filesFound.size > 0) {
        const fileList = Array.from(filesFound).slice(0, 10).join(', ');
        const moreFiles = filesFound.size > 10 ? ` (+${filesFound.size - 10} more)` : '';
        lines.push(`📁 **Files:** ${fileList}${moreFiles}`);
    }
    
    // Top symbols
    const topSymbols = (searchResults.symbols || []).slice(0, 8);
    if (topSymbols.length > 0) {
        const symbolNames = topSymbols.map(s => `\`${s.name}\``).join(', ');
        const moreSymbols = (searchResults.symbols?.length || 0) > 8 ? ` (+${searchResults.symbols.length - 8} more)` : '';
        lines.push(`🔧 **Symbols:** ${symbolNames}${moreSymbols}`);
    }
    
    // Symbol types breakdown
    const typeCounts = {};
    for (const sym of searchResults.symbols || []) {
        typeCounts[sym.type] = (typeCounts[sym.type] || 0) + 1;
    }
    if (Object.keys(typeCounts).length > 0) {
        const typeBreakdown = Object.entries(typeCounts)
            .map(([type, count]) => `${count} ${type}s`)
            .join(', ');
        lines.push(`📋 **Types:** ${typeBreakdown}`);
    }
    
    lines.push('\n');
    return lines.join('\n');
}

/**
 * Fallback response when LLM is unavailable
 */
function formatFallbackResponse(query, context) {
    return `## Search Results for: "${query}"\n\n` +
           `> *LLM synthesis unavailable. Configure GitHub Copilot, OpenAI, or Anthropic API key.*\n\n` +
           `---\n\n` +
           context.substring(0, 8000) +
           (context.length > 8000 ? '\n\n*[Results truncated...]*' : '');
}

/**
 * Helper to append response to chat
 */
async function appendResponseToChat(response) {
    chatHistory.push({
        role: 'assistant',
        content: response,
        timestamp: new Date()
    });
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: response 
    });
}

/**
 * Check if a symbol name is likely garbage (common English words incorrectly parsed)
 */
function isGarbageSymbol(name) {
    if (!name || name.length < 2) return true;
    
    const garbageWords = new Set([
        // Common English words that shouldn't be symbols
        'or', 'and', 'the', 'a', 'an', 'is', 'it', 'to', 'of', 'in', 'for', 'on', 'be',
        'as', 'at', 'by', 'if', 'no', 'so', 'up', 'do', 'we', 'he', 'me', 'my',
        'all', 'any', 'but', 'can', 'had', 'has', 'her', 'him', 'his', 'how', 'its',
        'may', 'new', 'not', 'now', 'old', 'one', 'our', 'out', 'own', 'say', 'see',
        'she', 'too', 'two', 'use', 'was', 'way', 'who', 'why', 'yet', 'you',
        'also', 'been', 'both', 'each', 'from', 'have', 'into', 'just', 'like',
        'make', 'many', 'more', 'most', 'much', 'must', 'only', 'over', 'same',
        'some', 'such', 'than', 'that', 'them', 'then', 'they', 'this', 'very',
        'what', 'when', 'will', 'with', 'your', 'here', 'there', 'which', 'where',
        'these', 'those', 'would', 'could', 'should', 'about', 'after', 'being',
        // Words commonly found in comments
        'todo', 'note', 'fixme', 'hack', 'xxx', 'see', 'per', 'via', 'etc'
    ]);
    
    const lowerName = name.toLowerCase();
    
    // Exact match to garbage word
    if (garbageWords.has(lowerName)) return true;
    
    // Single letter (except common valid single-letter names)
    if (name.length === 1 && !/^[ijknmxyzabc]$/i.test(name)) return true;
    
    // Pure numbers
    if (/^\d+$/.test(name)) return true;
    
    return false;
}

/**
 * Fallback keyword extraction when extractSearchKeywords fails
 */
function extractKeywordsFallback(query) {
    // Remove common stop words and extract meaningful terms
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
        'through', 'during', 'before', 'after', 'above', 'below', 'between',
        'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how',
        'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
        'such', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very',
        'just', 'also', 'now', 'here', 'there', 'what', 'which', 'who', 'whom',
        'this', 'that', 'these', 'those', 'am', 'its', 'it', 'i', 'me', 'my',
        'explain', 'describe', 'show', 'tell', 'find', 'get', 'implement', 'implemented',
        'work', 'works', 'working', 'does', 'done', 'perform', 'performed'
    ]);
    
    const words = query.toLowerCase()
        .replace(/[^\w\s_-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    
    // Also extract potential identifiers (camelCase, snake_case)
    const identifiers = query.match(/[a-zA-Z_][a-zA-Z0-9_]*(?:_[a-zA-Z0-9_]+)+|[a-zA-Z][a-z]*(?:[A-Z][a-z]*)*/g) || [];
    
    return [...new Set([...words, ...identifiers.map(i => i.toLowerCase())])];
}

/**
 * Direct symbol search as last resort
 */
async function tryDirectSymbolSearch(query, keywords) {
    const results = {
        symbols: [],
        codeBlocks: [],
        files: [],
        summaries: [],
        totalResults: 0
    };
    
    try {
        const queryLower = query.toLowerCase();
        
        // Use CodebaseIndex symbols if available, otherwise legacy codeIndex
        const symbolSource = codebaseIndex ? codebaseIndex.symbols : codeIndex.symbols;
        
        for (const [key, symbol] of symbolSource) {
            if (key.includes('@')) continue; // Skip path-qualified entries
            
            const nameLower = symbol.name.toLowerCase();
            const fileLower = (symbol.file || '').toLowerCase();
            
            // Check if symbol name or file matches any keyword
            let matches = false;
            for (const kw of keywords) {
                if (nameLower.includes(kw) || fileLower.includes(kw)) {
                    matches = true;
                    break;
                }
            }
            
            // Also check for partial matches in query
            if (!matches && (queryLower.includes(nameLower) || nameLower.length > 4 && queryLower.includes(nameLower.substring(0, 4)))) {
                matches = true;
            }
            
            if (matches) {
                results.symbols.push(symbol);
                
                // Get code block
                try {
                    const block = searchModule.getCodeBlock(symbol, { contextAfter: 40 });
                    if (block && block.code) {
                        results.codeBlocks.push({
                            file: symbol.file,
                            line: symbol.line,
                            symbol: symbol.name,
                            type: symbol.type,
                            code: block.code
                        });
                    }
                } catch (e) {
                    // Ignore
                }
            }
            
            if (results.symbols.length >= 50) break;
        }
        
        results.totalResults = results.symbols.length + results.codeBlocks.length;
        log(`Direct symbol search found: ${results.totalResults} results`);
        
    } catch (error) {
        log('Direct symbol search error:', error.message);
    }
    
    return results;
}

// ============================================================
// Deactivation
// ============================================================

async function deactivate() {
    // Save state before cleanup
    if (persistenceManager) {
        try {
            log('Saving state before deactivation...');
            await persistenceManager.saveAll();
            persistenceManager.stopAutoSave();
            persistenceManager.dispose();
        } catch (error) {
            log('Error saving state on deactivate:', error.message);
        }
    }
    
    // Clean up legacy codeIndex
    contextFiles.clear();
    codeIndex.files.clear();
    codeIndex.symbols.clear();
    codeIndex.variables.clear();
    codeIndex.callGraph.clear();
    codeIndex.reverseCallGraph.clear();
    codeIndex.dependencies.clear();
    codeIndex.summaries.clear();
    codeIndex.fileSummaries.clear();
    codeIndex.overallSummary = null;
    
    // Clean up CodebaseIndex
    if (codebaseIndex) {
        codebaseIndex.clear();
    }
    
    // *** NEW: Clear scope state ***
    scopedSearch.scopeState.deactivate();
    
    chatHistory = [];
    
    log('AstraCode deactivated');
}

module.exports = { activate, deactivate };
