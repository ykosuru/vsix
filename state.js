/**
 * AstraCode State Management
 * Centralized state management for the extension
 */

const vscode = require('vscode');

// ============================================================
// INDEXING STATE - Block queries until ready
// ============================================================

/**
 * Global indexing state tracker
 * Queries are blocked until all indexes are built
 */
class IndexingStateManager {
    constructor() {
        // Current state
        this.isIndexing = false;
        this.isSummarizing = false;
        this.isReady = false;
        
        // Phase tracking
        this.currentPhase = 'idle';  // 'idle' | 'parsing' | 'symbols' | 'trigrams' | 'search' | 'summaries' | 'inverted' | 'ready'
        this.progress = 0;           // 0-100
        
        // Stats
        this.filesIndexed = 0;
        this.symbolsFound = 0;
        this.summariesGenerated = 0;
        this.invertedTerms = 0;
        
        // Timestamps
        this.startTime = null;
        this.endTime = null;
        
        // UI callback
        this._webviewView = null;
        this._log = console.log;
    }
    
    setWebviewView(webviewView) {
        this._webviewView = webviewView;
    }
    
    setLogger(logFn) {
        this._log = logFn;
    }
    
    start() {
        this.isIndexing = true;
        this.isReady = false;
        this.startTime = Date.now();
        this.currentPhase = 'parsing';
        this.progress = 0;
        this.updateUI();
    }
    
    setPhase(phase, progress = null) {
        this.currentPhase = phase;
        if (progress !== null) this.progress = progress;
        this.updateUI();
    }
    
    complete() {
        this.isIndexing = false;
        this.isSummarizing = false;
        this.isReady = true;
        this.currentPhase = 'ready';
        this.progress = 100;
        this.endTime = Date.now();
        this.updateUI();
        this._log(`Indexing complete in ${this.endTime - this.startTime}ms`);
    }
    
    startSummaries() {
        this.isSummarizing = true;
        this.currentPhase = 'summaries';
        this.updateUI();
    }
    
    completeSummaries() {
        this.isSummarizing = false;
        this.currentPhase = 'inverted';
        this.updateUI();
    }
    
    updateUI() {
        if (!this._webviewView) return;
        
        const phaseNames = {
            'idle': 'Idle',
            'parsing': 'ðŸ“‚ Parsing files...',
            'symbols': 'ðŸ” Extracting symbols...',
            'trigrams': 'ðŸ“Š Building trigram index...',
            'search': 'ðŸ”Ž Building search indexes...',
            'summaries': 'ðŸ¤– Generating summaries...',
            'inverted': 'ðŸ“š Building inverted index...',
            'ready': 'âœ… Ready'
        };
        
        const message = {
            type: 'indexingStatus',
            isIndexing: this.isIndexing,
            isSummarizing: this.isSummarizing,
            isReady: this.isReady,
            phase: this.currentPhase,
            phaseName: phaseNames[this.currentPhase] || this.currentPhase,
            progress: this.progress,
            stats: {
                files: this.filesIndexed,
                symbols: this.symbolsFound,
                summaries: this.summariesGenerated,
                terms: this.invertedTerms
            }
        };
        
        this._webviewView.webview.postMessage(message);
        
        // Also update status bar
        if (this.isIndexing || this.isSummarizing) {
            this._webviewView.webview.postMessage({
                type: 'appendResponse',
                text: '' // Just trigger UI update
            });
        }
    }
    
    // Check if queries should be blocked
    shouldBlockQueries() {
        return this.isIndexing;
    }
    
    getBlockingMessage() {
        if (this.isIndexing) {
            return `â³ **Indexing in progress...**\n\n${this.getStatusLine()}\n\nPlease wait for indexing to complete before asking questions.`;
        }
        if (this.isSummarizing) {
            return `â³ **Generating summaries...**\n\n${this.getStatusLine()}\n\nYou can ask questions now, but results will improve after summaries are complete.`;
        }
        return null;
    }
    
    getStatusLine() {
        const parts = [];
        if (this.filesIndexed > 0) parts.push(`${this.filesIndexed} files`);
        if (this.symbolsFound > 0) parts.push(`${this.symbolsFound} symbols`);
        if (this.summariesGenerated > 0) parts.push(`${this.summariesGenerated} summaries`);
        if (this.invertedTerms > 0) parts.push(`${this.invertedTerms} search terms`);
        return parts.length > 0 ? `ðŸ“Š ${parts.join(' | ')}` : 'Starting...';
    }
    
    reset() {
        this.isIndexing = false;
        this.isSummarizing = false;
        this.isReady = false;
        this.currentPhase = 'idle';
        this.progress = 0;
        this.filesIndexed = 0;
        this.symbolsFound = 0;
        this.summariesGenerated = 0;
        this.invertedTerms = 0;
        this.startTime = null;
        this.endTime = null;
    }
}

// ============================================================
// Application State
// ============================================================

class AppState {
    constructor() {
        /** @type {Map<string, {uri: vscode.Uri, content: string, language: string}>} */
        this.contextFiles = new Map();
        
        /** @type {'auto' | 'local' | 'api'} */
        this.currentMode = 'auto';
        
        /** @type {Array<{role: 'user' | 'assistant', content: string, timestamp: Date}>} */
        this.chatHistory = [];
        
        /** @type {vscode.WebviewView | undefined} */
        this.chatWebviewView = undefined;
        
        /** @type {vscode.OutputChannel} */
        this.outputChannel = undefined;
        
        /** @type {vscode.StatusBarItem | undefined} */
        this.summaryStatusBarItem = undefined;
        
        /** @type {{name: string, vendor: string, family: string} | null} */
        this.lastUsedModel = null;
        
        /** @type {Set<string>} - Cache of model IDs/names that have failed */
        this.failedModelsCache = new Set();
        
        /** @type {string|null} - Track settings to detect changes */
        this.lastCopilotModelSetting = null;
        
        /** @type {{query: string, plan: Object} | null} */
        this.pendingPlan = null;
        
        // Indexing state
        this.indexingState = new IndexingStateManager();
    }
    
    clearContext() {
        this.contextFiles.clear();
        this.chatHistory = [];
    }
    
    addChatMessage(role, content) {
        this.chatHistory.push({
            role,
            content,
            timestamp: new Date()
        });
    }
}

// ============================================================
// Code Index Structure
// ============================================================

function createCodeIndex() {
    return {
        files: new Map(),            // file path -> {path, language, lineCount}
        symbols: new Map(),          // symbol name -> {name, type, line, file}
        variables: new Map(),        // variable name@file -> {name, dataType, declarationLine, accesses}
        callGraph: new Map(),        // function -> functions it calls
        reverseCallGraph: new Map(), // function -> functions that call it
        dependencies: new Map(),     // file -> files it depends on
        summaries: new Map(),        // function/proc name@file -> LLM-generated summary
        fileSummaries: new Map(),    // file path -> LLM-generated file summary
        overallSummary: null,        // High-level summary of entire codebase
        discoveredDomain: null,      // Domain info discovered from attached code
        lastUpdated: null
    };
}

// ============================================================
// Vector Index Structure
// ============================================================

function createVectorIndex() {
    return {
        chunks: [],                  // text chunks with metadata
        embeddings: null,            // flat Float32Array of all embeddings
        dimensions: 384,             // embedding dimensions
        model: 'tfidf',              // 'tfidf' or 'simple-hash'
        lastUpdated: null,
        isBuilding: false
    };
}

// ============================================================
// Trigram Index Structure
// ============================================================

function createTrigramIndex() {
    return {
        index: new Map(),            // trigram â†’ [{file, positions}]
        fileContent: new Map(),      // file â†’ content (for verification)
        stats: { trigrams: 0, files: 0, totalPositions: 0 },
        lastUpdated: null
    };
}

// ============================================================
// TF-IDF Vocabulary Structure
// ============================================================

function createTfidfVocabulary() {
    return {
        terms: new Map(),            // term â†’ {index, df}
        idf: null,                   // Float32Array of IDF values
        numDocs: 0,
        built: false
    };
}

// Singleton instance
const appState = new AppState();

module.exports = {
    IndexingStateManager,
    AppState,
    appState,
    createCodeIndex,
    createVectorIndex,
    createTrigramIndex,
    createTfidfVocabulary
};
