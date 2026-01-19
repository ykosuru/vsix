/**
 * AstraCode v5.1.3 - Agentic Code Assistant
 * 
 * FIX v4.9.81: Content Loading for Large Codebase Analysis
 * - handleDetailedQuery now loads actual source code content before analysis
 * - Previously, search results had content: null, causing LLM to only see metadata
 * - Now extracts 40 lines of context around each search result
 * - analyzeChunk prompt improved to emphasize analyzing actual code
 * 
 * CLEAN 3-LAYER SEARCH ARCHITECTURE (v4.9.80)
 * ============================================
 * 
 * ┌─────────────────────────────────────────────────────────┐
 * │                     SEARCH QUERY                         │
 * └─────────────────────────────────────────────────────────┘
 *                            │
 *        ┌───────────────────┼───────────────────┐
 *        ▼                   ▼                   ▼
 * ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
 * │   SYMBOL    │     │   TRIGRAM   │     │   VECTOR    │
 * │   INDEX     │     │   INDEX     │     │   INDEX     │
 * ├─────────────┤     ├─────────────┤     ├─────────────┤
 * │ Functions   │     │ Exact text  │     │ Semantic    │
 * │ Classes     │     │ Substrings  │     │ TF-IDF      │
 * │ Variables   │     │ Identifiers │     │ Concepts    │
 * │ Call graph  │     │ (Zoekt)     │     │             │
 * │ Fuzzy match │     │ O(1) lookup │     │ Similarity  │
 * └─────────────┘     └─────────────┘     └─────────────┘
 * 
 * Key Tools:
 * - search_code: Combines Layer 1 + Layer 2 (PREFERRED)
 * - search_trigram: Layer 2 only (exact text)
 * - search_semantic: Layer 3 only (concepts)
 * - hybridSearch(): All 3 layers with result fusion
 * 
 * Toggle Judge: AGENT_CONFIG.enableJudge = true/false
 */

const vscode = require('vscode');
const path = require('path');
const pathUtils = require('./pathUtils');
const searchModule = require('./search-module');

const { PersistenceManager } = require('./persistence');
const { PromptLibrary, GROUNDING_RULES, ALGORITHM_GUIDANCE } = require('./prompts');
const { 
    CodeIndex, 
    detectLanguage: detectLangModule, 
    isBinaryFile: isBinaryModule,
    parseFile: parseFileModule
} = require('./index-module');
const { 
    SessionMemory, 
    parseSessionCommand, 
    executeSessionCommand,
    SESSION_MEMORY_HELP 
} = require('./session-memory');
const {
    QueryClassifier,
    QueryTypes,
    SearchStrategies
} = require('./query-classifier');

const {
    CobolQueryClassifier,
    extractCobolParagraphs,
    extractCobolDataItems,
    extractCobolSql,
    extractCobolCopybooks,
    extractCobolTables,
    extractSqlTables,
    handleTableQuery,
} = require('./cobol-query-classifier');


// Global persistence manager instance
let persistenceManager = null;

// Global code index instance (new modular approach)
let codeIndexManager = null;

// Global session memory instance
let sessionMemory = null;

// Global query classifier instance (learns domain knowledge from codebase)
let queryClassifier = null;

let cobolClassifier = null;

// ============================================================
// INDEXING STATE - Block queries until ready
// ============================================================

/**
 * Global indexing state tracker
 * Queries are blocked until all indexes are built
 */
const IndexingState = {
    // Current state
    isIndexing: false,
    isSummarizing: false,
    isReady: false,
    
    // Phase tracking
    currentPhase: 'idle',  // 'idle' | 'parsing' | 'symbols' | 'trigrams' | 'search' | 'summaries' | 'inverted' | 'ready'
    progress: 0,           // 0-100
    
    // Stats
    filesIndexed: 0,
    symbolsFound: 0,
    summariesGenerated: 0,
    invertedTerms: 0,
    
    // Timestamps
    startTime: null,
    endTime: null,
    
    // Methods
    start() {
        this.isIndexing = true;
        this.isReady = false;
        this.startTime = Date.now();
        this.currentPhase = 'parsing';
        this.progress = 0;
        this.updateUI();
    },
    
    setPhase(phase, progress = null) {
        this.currentPhase = phase;
        if (progress !== null) this.progress = progress;
        this.updateUI();
    },
    
    complete() {
        this.isIndexing = false;
        this.isSummarizing = false;
        this.isReady = true;
        this.currentPhase = 'ready';
        this.progress = 100;
        this.endTime = Date.now();
        this.updateUI();
        log(`Indexing complete in ${this.endTime - this.startTime}ms`);
    },
    
    startSummaries() {
        this.isSummarizing = true;
        this.currentPhase = 'summaries';
        this.updateUI();
    },
    
    completeSummaries() {
        this.isSummarizing = false;
        this.currentPhase = 'inverted';
        this.updateUI();
    },
    
    updateUI() {
        if (!chatWebviewView) return;
        
        const phaseNames = {
            'idle': 'Idle',
            'parsing': '📂 Parsing files...',
            'symbols': '🔍 Extracting symbols...',
            'trigrams': '📊 Building trigram index...',
            'search': '🔎 Building search indexes...',
            'summaries': '🤖 Generating summaries...',
            'inverted': '📚 Building inverted index...',
            'ready': '✅ Ready'
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
        
        chatWebviewView.webview.postMessage(message);
        
        // Also update status bar
        if (this.isIndexing || this.isSummarizing) {
            const statusText = `$(sync~spin) ${phaseNames[this.currentPhase]} (${this.progress}%)`;
            chatWebviewView.webview.postMessage({
                type: 'appendResponse',
                text: '' // Just trigger UI update
            });
        }
    },
    
    // Check if queries should be blocked
    shouldBlockQueries() {
        // Block if indexing basic structure OR if no summaries yet for large codebases
        return this.isIndexing;
    },
    
    getBlockingMessage() {
        if (this.isIndexing) {
            return `⏳ **Indexing in progress...**\n\n${this.getStatusLine()}\n\nPlease wait for indexing to complete before asking questions.`;
        }
        if (this.isSummarizing) {
            return `⏳ **Generating summaries...**\n\n${this.getStatusLine()}\n\nYou can ask questions now, but results will improve after summaries are complete.`;
        }
        return null;
    },
    
    getStatusLine() {
        const parts = [];
        if (this.filesIndexed > 0) parts.push(`${this.filesIndexed} files`);
        if (this.symbolsFound > 0) parts.push(`${this.symbolsFound} symbols`);
        if (this.summariesGenerated > 0) parts.push(`${this.summariesGenerated} summaries`);
        if (this.invertedTerms > 0) parts.push(`${this.invertedTerms} search terms`);
        return parts.length > 0 ? `📊 ${parts.join(' | ')}` : 'Starting...';
    }
};

// ============================================================
// State Management
// ============================================================

/** @type {Map<string, {uri: vscode.Uri, content: string, language: string}>} */
const contextFiles = new Map();

/** @type {'auto' | 'local' | 'api'} */
let currentMode = 'auto';

/** @type {Array<{role: 'user' | 'assistant', content: string, timestamp: Date}>} */
let chatHistory = [];

/** @type {vscode.WebviewView | undefined} */
let chatWebviewView;

/** @type {vscode.OutputChannel} */
let outputChannel;

/** @type {vscode.StatusBarItem | undefined} */
let summaryStatusBarItem;

/** @type {{name: string, vendor: string, family: string} | null} */
let lastUsedModel = null;

/** @type {Set<string>} - Cache of model IDs/names that have failed (cleared on reload or settings change) */
const failedModelsCache = new Set();

/** @type {string|null} - Track settings to detect changes */
let lastCopilotModelSetting = null;

/** @type {{query: string, plan: Object} | null} */
let pendingPlan = null;

// ============================================================
// CENTRALIZED LLM CONFIGURATION
// ============================================================

/**
 * LLM Configuration Manager
 * Single source of truth for all model selection and provider settings
 * All settings are read from VS Code configuration (astra.llm.*)
 */
const LLMConfig = {
    // Task types for model selection
    TASKS: {
        CODING: 'coding',           // Code generation, translation
        ANALYSIS: 'analysis',       // Code analysis, Q&A
        SUMMARY: 'summary',         // Summaries, documentation
        CLASSIFICATION: 'classification', // Quick classification tasks
        DEFAULT: 'default'          // General fallback
    },

    /**
     * Get the configured model for a specific task
     * @param {string} task - One of TASKS values
     * @returns {string} Model identifier
     */
    getModelForTask(task) {
        const config = vscode.workspace.getConfiguration('astra');
        
        switch (task) {
            case this.TASKS.CODING:
                return config.get('llm.codingModel') || this.getDefaultModel();
            case this.TASKS.ANALYSIS:
                return config.get('llm.analysisModel') || this.getDefaultModel();
            case this.TASKS.SUMMARY:
                return config.get('llm.summaryModel') || this.getDefaultModel();
            case this.TASKS.CLASSIFICATION:
                return config.get('llm.classificationModel') || this.getDefaultModel();
            default:
                return this.getDefaultModel();
        }
    },

    /**
     * Get the default model (fallback for all tasks)
     * @returns {string} Default model identifier
     */
    getDefaultModel() {
        const config = vscode.workspace.getConfiguration('astra');
        return config.get('llm.defaultModel') || 'gpt-5o-mini';
    },

    /**
     * Get provider priority order
     * @returns {string[]} Array of provider names in priority order
     */
    getProviderPriority() {
        const config = vscode.workspace.getConfiguration('astra');
        return config.get('llm.providerPriority') || ['copilot', 'openai', 'anthropic'];
    },

    /**
     * Get API key for a provider
     * @param {string} provider - 'openai' or 'anthropic'
     * @returns {string|null} API key or null
     */
    getApiKey(provider) {
        const config = vscode.workspace.getConfiguration('astra');
        switch (provider) {
            case 'openai':
                return config.get('llm.openaiApiKey') || null;
            case 'anthropic':
                return config.get('llm.anthropicApiKey') || null;
            default:
                return null;
        }
    },

    /**
     * Get display name for a model
     * @param {string} modelId - Model identifier
     * @returns {string} Human-friendly display name
     */
    getDisplayName(modelId) {
        if (!modelId) return 'Unknown';
        
        const config = vscode.workspace.getConfiguration('astra');
        const customNames = config.get('llm.modelDisplayNames') || {};
        
        // Check custom names first
        if (customNames[modelId]) {
            return customNames[modelId];
        }
        
        // Built-in display names
        const builtInNames = {
            'gpt-5o-mini': 'GPT-5o Mini',
            'gpt-5o': 'GPT-5o',
            'gpt-4o-mini': 'GPT-4o Mini',
            'gpt-4o': 'GPT-4o',
            'gpt-4-turbo': 'GPT-4 Turbo',
            'gpt-4': 'GPT-4',
            'gpt-3.5-turbo': 'GPT-3.5',
            'claude-sonnet-4-5-20250514': 'Claude Sonnet 4.5',
            'claude-sonnet-4': 'Claude Sonnet 4',
            'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
            'claude-3.5-sonnet': 'Claude 3.5 Sonnet',
            'claude-3-opus-20240229': 'Claude 3 Opus',
            'claude-3-haiku-20240307': 'Claude 3 Haiku',
            'o1': 'o1',
            'o1-mini': 'o1 Mini'
        };
        
        if (builtInNames[modelId]) {
            return builtInNames[modelId];
        }
        
        // Try to extract a friendly name from the model ID
        const modelLower = modelId.toLowerCase();
        if (modelLower.includes('gpt-5o-mini')) return 'GPT-5o Mini';
        if (modelLower.includes('gpt-5o')) return 'GPT-5o';
        if (modelLower.includes('gpt-4o-mini')) return 'GPT-4o Mini';
        if (modelLower.includes('gpt-4o')) return 'GPT-4o';
        if (modelLower.includes('gpt-4')) return 'GPT-4';
        if (modelLower.includes('claude-sonnet-4')) return 'Claude Sonnet 4';
        if (modelLower.includes('claude-3.5') || modelLower.includes('claude-3-5')) return 'Claude 3.5 Sonnet';
        if (modelLower.includes('claude')) return 'Claude';
        if (modelLower.includes('o1-mini')) return 'o1 Mini';
        if (modelLower.includes('o1')) return 'o1';
        
        return modelId;
    },

    /**
     * Get model search patterns for Copilot model selection
     * Returns functions to match models in priority order
     * @param {string} preferredModel - The preferred model ID
     * @returns {Function[]} Array of matcher functions
     */
    getModelSearchOrder(preferredModel) {
        const preferred = (preferredModel || this.getDefaultModel()).toLowerCase();
        
        return [
            // First: exact match for preferred model
            m => (m.name?.toLowerCase().includes(preferred) || 
                  m.id?.toLowerCase().includes(preferred) ||
                  m.family?.toLowerCase().includes(preferred)),
            // GPT-5o-mini
            m => (m.family?.toLowerCase().includes('gpt-5o-mini') || 
                  m.name?.toLowerCase().includes('gpt-5o-mini') ||
                  m.id?.toLowerCase().includes('gpt-5o-mini')),
            // GPT-5o
            m => (m.family?.toLowerCase().includes('gpt-5o') ||
                  m.name?.toLowerCase().includes('gpt-5o') ||
                  m.id?.toLowerCase().includes('gpt-5o')),
            // GPT-4o-mini
            m => (m.family?.toLowerCase().includes('gpt-4o-mini') ||
                  m.name?.toLowerCase().includes('gpt-4o-mini')),
            // GPT-4o
            m => (m.family?.toLowerCase().includes('gpt-4o') ||
                  m.name?.toLowerCase().includes('gpt-4o')),
            // GPT-4
            m => (m.family?.toLowerCase().includes('gpt-4') ||
                  m.name?.toLowerCase().includes('gpt-4')),
            // Any mini model
            m => (m.name?.toLowerCase().includes('mini') ||
                  m.id?.toLowerCase().includes('mini')),
            // Claude (fallback)
            m => (m.family?.toLowerCase().includes('claude') ||
                  m.name?.toLowerCase().includes('claude')),
        ];
    },

    /**
     * Log current configuration (for debugging)
     */
    logConfig() {
        log('LLM Config:', {
            defaultModel: this.getDefaultModel(),
            codingModel: this.getModelForTask(this.TASKS.CODING),
            analysisModel: this.getModelForTask(this.TASKS.ANALYSIS),
            summaryModel: this.getModelForTask(this.TASKS.SUMMARY),
            classificationModel: this.getModelForTask(this.TASKS.CLASSIFICATION),
            providerPriority: this.getProviderPriority(),
            hasOpenAIKey: !!this.getApiKey('openai'),
            hasAnthropicKey: !!this.getApiKey('anthropic')
        });
    }
};

// ============================================================
// END CENTRALIZED LLM CONFIGURATION
// ============================================================

/** 
 * Task cancellation support
 * @type {{
 *   isCancelled: boolean,
 *   currentTask: string | null,
 *   startTime: Date | null,
 *   cancel: function(): void,
 *   reset: function(): void,
 *   checkCancelled: function(): boolean
 * }}
 */
const taskController = {
    isCancelled: false,
    currentTask: null,
    startTime: null,
    
    cancel() {
        if (this.currentTask) {
            this.isCancelled = true;
            log(`Task cancelled: ${this.currentTask}`);
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: '\n\n⚠️ **Task cancelled by user**\n' 
            });
        }
    },
    
    reset() {
        this.isCancelled = false;
        this.currentTask = null;
        this.startTime = null;
    },
    
    start(taskName) {
        this.reset();
        this.currentTask = taskName;
        this.startTime = new Date();
        log(`Task started: ${taskName}`);
    },
    
    checkCancelled() {
        if (this.isCancelled) {
            throw new Error('Task cancelled by user');
        }
        return this.isCancelled;
    }
};

/**
 * Check if a file is a code file (not a build/config/doc file)
 * Used to filter search results and documentation generation
 */
const NON_CODE_FILES = new Set([
    'makefile', 'gnumakefile', 'readme', 'readme.md', 'readme.txt',
    'license', 'license.md', 'license.txt', 'changelog', 'changelog.md',
    'contributing', 'contributing.md', 'authors', 'todo', 'todo.md',
    '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc',
    'package-lock.json', 'yarn.lock', 'poetry.lock', 'pipfile.lock'
]);
const NON_CODE_EXTENSIONS = new Set([
    '.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.ini',
    '.cfg', '.conf', '.xml', '.lock', '.sum'
]);
const BUILD_FILES = new Set([
    'meson.build', 'cmakelists.txt', 'configure.ac', 'configure.in',
    'setup.py', 'setup.cfg', 'pyproject.toml', 'cargo.toml',
    'build.gradle', 'pom.xml', 'package.json', 'tsconfig.json'
]);

function isCodeFile(filePath) {
    const fileName = pathUtils.getFileName(filePath);
    const fileNameLower = fileName.toLowerCase();
    const ext = pathUtils.getExtension(filePath).toLowerCase();
    
    // Explicitly non-code files
    if (NON_CODE_FILES.has(fileNameLower)) return false;
    
    // Build/config files - include in indexing but exclude from search results
    if (BUILD_FILES.has(fileNameLower)) return false;
    
    // Non-code extensions
    if (NON_CODE_EXTENSIONS.has(ext)) return false;
    
    return true;
}

/**
 * Default System Prompt for AstraCode
 * Now uses the centralized PromptLibrary
 */
const DEFAULT_SYSTEM_PROMPT = PromptLibrary.system.default();

/**
 * Get the current system prompt (user-edited or default)
 */
function getSystemPrompt() {
    const config = vscode.workspace.getConfiguration('astra');
    const customPrompt = config.get('systemPrompt');
    return customPrompt || DEFAULT_SYSTEM_PROMPT;
}

/**
 * Save a custom system prompt
 */
async function setSystemPrompt(prompt) {
    const config = vscode.workspace.getConfiguration('astra');
    await config.update('systemPrompt', prompt, vscode.ConfigurationTarget.Global);
}

/**
 * Reset system prompt to default
 */
async function resetSystemPrompt() {
    const config = vscode.workspace.getConfiguration('astra');
    await config.update('systemPrompt', undefined, vscode.ConfigurationTarget.Global);
}

/**
 * Code Index - stores parsed information about the codebase
 * @type {{
 *   files: Map<string, {path: string, language: string, symbols: Array, summary?: string}>,
 *   symbols: Map<string, {name: string, type: string, file: string, line: number, signature?: string, summary?: string}>,
 *   callGraph: Map<string, Set<string>>,
 *   reverseCallGraph: Map<string, Set<string>>,
 *   dependencies: Map<string, Set<string>>,
 *   summaries: Map<string, {name: string, type: string, file: string, summary: string, line: number}>,
 *   fileSummaries: Map<string, string>,
 *   overallSummary: string | null,
 *   lastUpdated: Date | null
 * }}
 */
const codeIndex = {
    files: new Map(),           // file path -> file info with symbols
    symbols: new Map(),         // symbol name -> definition info
    variables: new Map(),       // variable name@file -> {name, dataType, file, declarationLine, initializationLine, accesses[]}
    callGraph: new Map(),       // function -> functions it calls
    reverseCallGraph: new Map(), // function -> functions that call it
    dependencies: new Map(),    // file -> files it depends on
    summaries: new Map(),       // function/proc name@file -> LLM-generated summary
    fileSummaries: new Map(),   // file path -> LLM-generated file summary
    overallSummary: null,       // High-level summary of entire codebase
    discoveredDomain: null,     // Domain info discovered from attached code
    lastUpdated: null
};

/**
 * Initialize search module with shared state
 */
function initializeSearchModule() {
    searchModule.initialize(
        codeIndex,
        trigramIndex,
        vectorIndex,
        contextFiles,
        pathUtils,
        log,
        showProgress
    );
    const config = vscode.workspace.getConfiguration('astra');
    searchModule.searchMode = config.get('searchMode', 'detailed');
    log('Search module initialized, mode:', searchModule.searchMode);
}

/**
 * Summary Index Configuration
 * Note: Auto-summary is controlled via astra.indexing.enableAutoSummary setting
 */
const SUMMARY_CONFIG = {
    ENABLE_AUTO_SUMMARY: true,       // Default, overridden by settings
    SUMMARY_BATCH_SIZE: 10,          // Functions per LLM batch call
    MAX_FUNCTION_SIZE: 5000,         // Max chars to send for summarization
    MIN_FUNCTION_SIZE: 50,           // Skip tiny functions
    CONTEXT_WINDOW_LIMIT: 18000,     // Max chars for context (fits in Copilot 25K limit with room for prompt)
    CHUNK_SIZE_FOR_QUERY: 10000,     // Chunk size for detailed queries (reduced to prevent prompt overflow)
    CHUNK_OVERLAP: 500               // Overlap between chunks
};

/**
 * Get current summary config with settings overrides
 */
function getSummaryConfig() {
    const config = vscode.workspace.getConfiguration('astra');
    return {
        ...SUMMARY_CONFIG,
        ENABLE_AUTO_SUMMARY: config.get('indexing.enableAutoSummary', true)
    };
}

/**
 * Vector Index - stores embeddings for semantic search
 * @type {{
 *   chunks: Array<{id: string, text: string, file: string, startLine: number, endLine: number, type: string, embedding: Float32Array|null}>,
 *   embeddings: Float32Array | null,
 *   dimensions: number,
 *   model: string,
 *   lastUpdated: Date | null,
 *   isBuilding: boolean
 * }}
 */
const vectorIndex = {
    chunks: [],                  // text chunks with metadata
    embeddings: null,            // flat Float32Array of all embeddings (chunks.length * dimensions)
    dimensions: 384,             // embedding dimensions (all-MiniLM-L6-v2 = 384)
    model: 'tfidf',              // 'tfidf' (better quality) or 'simple-hash' (faster)
    lastUpdated: null,
    isBuilding: false
};

// Vector index configuration
const VECTOR_CONFIG = {
    CHUNK_SIZE: 500,             // Target chars per chunk
    CHUNK_OVERLAP: 50,           // Overlap between chunks
    MIN_CHUNK_SIZE: 50,          // Minimum chunk size to embed
    MAX_CHUNKS_PER_FILE: 100,    // Limit chunks per file
    TOP_K_RESULTS: 10,           // Default number of results
    EMBEDDING_BATCH_SIZE: 20,    // Chunks to embed per batch
    SIMILARITY_THRESHOLD: 0.3    // Minimum similarity for results
};

/**
 * Trigram Index - Zoekt-style index for fast exact/partial text search
 * Uses 3-character sequences for substring matching
 * @type {{
 *   index: Map<string, Array<{file: string, positions: number[]}>>,
 *   fileContent: Map<string, string>,
 *   stats: {trigrams: number, files: number, totalPositions: number},
 *   lastUpdated: Date | null
 * }}
 */
const trigramIndex = {
    index: new Map(),            // trigram → [{file, positions}]
    fileContent: new Map(),      // file → content (for verification)
    stats: { trigrams: 0, files: 0, totalPositions: 0 },
    lastUpdated: null
};

// Trigram configuration
const TRIGRAM_CONFIG = {
    MIN_QUERY_LENGTH: 3,         // Minimum query length for trigram search
    MAX_RESULTS: 100,            // Maximum results to return
    MAX_FILE_SIZE: 500000,       // Skip files larger than this
    CASE_SENSITIVE: false,       // Case-insensitive by default
    MAX_POSITIONS_PER_FILE: 1000 // Limit positions stored per file per trigram
};

/**
 * TF-IDF Vocabulary for vector embeddings
 */
const tfidfVocabulary = {
    terms: new Map(),            // term → {index, df}
    idf: null,                   // Float32Array of IDF values
    numDocs: 0,
    built: false
};

// ============================================================
// Logging
// ============================================================

function log(...args) {
    const timestamp = new Date().toISOString().substring(11, 23);
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    outputChannel?.appendLine(`[${timestamp}] ${message}`);
    console.log(`[AstraCode] ${message}`);
}

/**
 * Debug log that shows in chat panel when debug mode is enabled
 * Use this for user-visible debug information
 */
function debugLog(category, message, data = null) {
    const config = vscode.workspace.getConfiguration('astra');
    const debugMode = config.get('debugMode', false);
    
    // Always log to output channel
    log(`[${category}]`, message, data || '');
    
    // If debug mode is on, also show in chat
    if (debugMode && chatWebviewView) {
        let debugText = `\n🔧 **[${category}]** ${message}`;
        if (data !== null) {
            if (typeof data === 'object') {
                debugText += `\n\`\`\`json\n${JSON.stringify(data, null, 2).substring(0, 500)}\n\`\`\``;
            } else {
                debugText += `: \`${data}\``;
            }
        }
        debugText += '\n';
        
        chatWebviewView.webview.postMessage({ 
            type: 'appendResponse', 
            text: debugText 
        });
    }
}

/**
 * Show progress message in chat UI (user-visible)
 * Used to show what the agent is doing during search/planning
 */
function showProgress(message, type = 'info') {
    const icons = {
        'search': '🔍',
        'index': '📊',
        'grep': '📝',
        'found': '✅',
        'step': '▶️',
        'info': 'ℹ️',
        'warn': '⚠️'
    };
    const icon = icons[type] || icons.info;
    const formatted = `\n${icon} *${message}*\n`;
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: formatted 
    });
    log(`PROGRESS: ${message}`);
}

/**
 * Update summary progress in both webview and status bar
 * @param {number} progress - 0-100, or -1 to hide
 * @param {string} message - Status message
 * @param {number} [count] - Final count (on completion)
 */
function updateSummaryStatus(progress, message, count) {
    // Update webview progress indicator
    chatWebviewView?.webview.postMessage({ 
        type: 'summaryProgress',
        progress: progress,
        message: message,
        count: count
    });
    
    // Update VS Code status bar item
    if (summaryStatusBarItem) {
        if (progress >= 0 && progress < 100) {
            summaryStatusBarItem.text = `$(sync~spin) ${message}`;
            summaryStatusBarItem.tooltip = `AstraCode: Generating function summaries (${progress}%)`;
            summaryStatusBarItem.show();
        } else if (progress >= 100) {
            summaryStatusBarItem.text = `$(check) ${count || 0} summaries`;
            summaryStatusBarItem.tooltip = `AstraCode: ${count || 0} function summaries generated`;
            // Hide after 5 seconds
            setTimeout(() => {
                if (summaryStatusBarItem) {
                    summaryStatusBarItem.hide();
                }
            }, 5000);
        } else {
            summaryStatusBarItem.hide();
        }
    }
    
    log(`SUMMARY: ${message} (${progress}%)`);
}

/**
 * Show index statistics to user
 */
function showIndexStats() {
    if (codeIndex.symbols.size === 0 && trigramIndex.index.size === 0 && vectorIndex.chunks.length === 0) {
        showProgress('No indexes available - files not yet indexed', 'warn');
        return;
    }
    
    // Count by type
    const typeCounts = {};
    for (const [_, sym] of codeIndex.symbols) {
        typeCounts[sym.type] = (typeCounts[sym.type] || 0) + 1;
    }
    
    const stats = [];
    
    // Symbol index stats
    if (codeIndex.files.size > 0) {
        stats.push(`${codeIndex.files.size} files`);
        stats.push(`${codeIndex.symbols.size} symbols`);
    }
    
    // Trigram index stats
    if (trigramIndex.index.size > 0) {
        stats.push(`${trigramIndex.stats.trigrams} trigrams`);
    }
    
    // Vector index stats
    if (vectorIndex.chunks.length > 0) {
        stats.push(`${vectorIndex.chunks.length} chunks`);
        if (tfidfVocabulary.built) {
            stats.push(`${tfidfVocabulary.terms.size} TF-IDF terms`);
        }
    }
    
    // Summary stats
    if (codeIndex.summaries.size > 0) {
        stats.push(`${codeIndex.summaries.size} summaries`);
    }
    
    // Add type breakdown
    const typeStr = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([type, count]) => `${count} ${type}s`)
        .join(', ');
    
    showProgress(`Index: ${stats.join(' | ')}`, 'index');
    if (typeStr) {
        showProgress(`Types: ${typeStr}`, 'info');
    }
}

// ============================================================
// Code Indexing
// ============================================================

/**
 * Build index for all context files
 */
// Indexing configuration
const INDEX_CONFIG = {
    BATCH_SIZE: 50,           // Files per batch
    BATCH_DELAY: 10,          // ms delay between batches (yield to UI)
    MAX_FILES_FOR_FULL_INDEX: 1000,  // Above this, use lightweight indexing
    MAX_SYMBOLS_PER_FILE: 500,       // Limit symbols per file in lightweight mode
    MAX_VARS_PER_FILE: 100,          // Limit variables per file in lightweight mode
    SEARCH_RESULT_LIMIT: 100         // Max search results
};

/**
 * Build code index asynchronously with progress updates
 * Handles large repositories by batching and yielding to UI
 */
async function buildCodeIndex(options = {}) {
    const { showProgress = true, lightweight = false, forceRebuild = false } = options;
    const totalFiles = contextFiles.size;
    
    log('Building code index for', totalFiles, 'files...');
    
    // ================================================================
    // TRY TO RESTORE FROM CACHE (skip expensive rebuilding)
    // ================================================================
    if (!forceRebuild && persistenceManager) {
        try {
            const cached = await persistenceManager.restoreCodeIndex();
            if (cached && cached.symbols.size > 0) {
                log(`Restoring cached index: ${cached.symbols.size} symbols, ${cached.summaries.size} summaries`);
                
                // Show progress
                if (showProgress && chatWebviewView) {
                    chatWebviewView.webview.postMessage({
                        type: 'indexProgress',
                        progress: 50,
                        message: `⚡ Restoring cached index: ${cached.symbols.size} symbols...`
                    });
                    chatWebviewView.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `\n⚡ **Restoring cached index...**\n- ${cached.symbols.size} symbols\n- ${cached.summaries.size} summaries\n`
                    });
                }
                
                // Restore to codeIndex
                codeIndex.symbols = cached.symbols;
                codeIndex.callGraph = cached.callGraph;
                codeIndex.reverseCallGraph = cached.reverseCallGraph;
                codeIndex.summaries = cached.summaries;
                codeIndex.fileSummaries = cached.fileSummaries;
                codeIndex.lastUpdated = new Date(cached.metadata.savedAt);
                
                // Still need to rebuild file index and trigrams (fast operations)
                for (const [path, file] of contextFiles) {
                    codeIndex.files.set(path, { path, language: file.language, lineCount: file.content.split('\n').length });
                }
                
                // Build trigram index
                if (showProgress && chatWebviewView) {
                    chatWebviewView.webview.postMessage({
                        type: 'indexProgress',
                        progress: 70,
                        message: `📊 Building trigram index...`
                    });
                }
                await buildTrigramIndexLightweight({ showProgressUI: false, maxFilesToIndex: 500, maxFileSize: 50000 });
                
                // Build search indexes (including inverted index with summaries)
                if (showProgress && chatWebviewView) {
                    chatWebviewView.webview.postMessage({
                        type: 'indexProgress',
                        progress: 85,
                        message: `🔎 Building search indexes with ${cached.summaries.size} summaries...`
                    });
                }
                const searchStats = searchModule.buildSearchIndexes();
                
                // Update IndexingState
                IndexingState.filesIndexed = totalFiles;
                IndexingState.symbolsFound = cached.symbols.size;
                IndexingState.summariesGenerated = cached.summaries.size;
                IndexingState.invertedTerms = searchStats.invertedTerms || 0;
                IndexingState.complete();
                
                // Show completion
                if (showProgress && chatWebviewView) {
                    chatWebviewView.webview.postMessage({
                        type: 'indexProgress',
                        progress: 100,
                        message: `✅ Restored: ${cached.symbols.size} symbols | ${cached.summaries.size} summaries | ${searchStats.invertedTerms} terms`
                    });
                    chatWebviewView.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `✅ **Index restored from cache in < 1s!**\n- ${searchStats.invertedTerms} search terms\n\n**Ready for queries!**\n\n`
                    });
                    chatWebviewView.webview.postMessage({ type: 'finalizeResponse' });
                }
                
                updateChatStatusUI();
                
                return {
                    files: totalFiles,
                    symbols: cached.symbols.size,
                    functions: cached.callGraph.size,
                    summaries: cached.summaries.size,
                    restored: true
                };
            }
        } catch (err) {
            log('Cache restore failed, will rebuild:', err.message);
        }
    }
    
    // ================================================================
    // START INDEXING STATE (no cache or cache invalid)
    // ================================================================
    IndexingState.start();
    IndexingState.filesIndexed = 0;
    IndexingState.symbolsFound = 0;
    
    // Determine indexing mode
    const useLightweight = lightweight || totalFiles > INDEX_CONFIG.MAX_FILES_FOR_FULL_INDEX;
    if (useLightweight) {
        log('Using lightweight indexing mode for large repository');
    }
    
    // Clear existing index
    codeIndex.files.clear();
    codeIndex.symbols.clear();
    codeIndex.variables.clear();
    codeIndex.callGraph.clear();
    codeIndex.reverseCallGraph.clear();
    codeIndex.dependencies.clear();
    
    // Callable symbol types by language
    const callableTypes = new Set([
        'function', 'procedure', 'method', 'subproc',  // General
        'section', 'paragraph', 'program',             // COBOL
        'define', 'macro', 'external', 'forward',      // TAL
        'view', 'trigger'                              // SQL
    ]);
    
    // Variable symbol types
    const variableTypes = new Set([
        'variable', 'parameter', 'field', 'property',
        'record', 'constant', 'literal',
        'global', 'local', 'member'
    ]);
    
    // Convert to array for batching
    const fileEntries = Array.from(contextFiles.entries());
    const batches = [];
    for (let i = 0; i < fileEntries.length; i += INDEX_CONFIG.BATCH_SIZE) {
        batches.push(fileEntries.slice(i, i + INDEX_CONFIG.BATCH_SIZE));
    }
    
    let processedFiles = 0;
    let totalSymbols = 0;
    
    // Send initial progress
    if (showProgress && chatWebviewView) {
        chatWebviewView.webview.postMessage({
            type: 'indexProgress',
            progress: 0,
            message: `Indexing: 0/${totalFiles} files (0%)`
        });
        // Small yield to let UI update
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Process batches
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        
        // Process batch
        for (const [path, file] of batch) {
            try {
                const fileInfo = parseFile(path, file.content, file.language);
                codeIndex.files.set(path, fileInfo);
                
                // Limit symbols per file for large repos
                const symbols = useLightweight 
                    ? fileInfo.symbols.slice(0, INDEX_CONFIG.MAX_SYMBOLS_PER_FILE)
                    : fileInfo.symbols;
                
                // Add symbols to global symbol table
                let varsInFile = 0;
                let varTypesFound = {};
                
                for (const symbol of symbols) {
                    const key = `${symbol.name}@${path}`;
                    codeIndex.symbols.set(key, { ...symbol, file: path });
                    
                    if (!codeIndex.symbols.has(symbol.name)) {
                        codeIndex.symbols.set(symbol.name, { ...symbol, file: path });
                    }
                    
                    // Track variables (with limit in lightweight mode)
                    const hasVarType = variableTypes.has(symbol.type);
                    const hasDataType = symbol.dataType && symbol.dataType.length > 0;
                    const isVariable = hasVarType || hasDataType;
                    const underVarLimit = !useLightweight || varsInFile < INDEX_CONFIG.MAX_VARS_PER_FILE;
                    
                    // Track what types we're finding
                    if (isVariable) {
                        varTypesFound[symbol.type] = (varTypesFound[symbol.type] || 0) + 1;
                    }
                    
                    if (isVariable && underVarLimit) {
                        const varKey = `${symbol.name}@${path}`;
                        codeIndex.variables.set(varKey, {
                            name: symbol.name,
                            dataType: symbol.dataType || symbol.type || 'unknown',
                            file: path,
                            declarationLine: symbol.line,
                            initializationLine: symbol.initLine || symbol.line,
                            scope: symbol.scope || 'global',
                            accesses: []
                        });
                        varsInFile++;
                    }
                    totalSymbols++;
                }
                
                // Log variable types found in this file (for first few files)
                if (processedFiles < 3 && varsInFile > 0) {
                    log('File:', path, '- vars found:', varsInFile, 'types:', varTypesFound);
                }
                
                // Log first file's symbol types for debugging
                if (processedFiles === 0) {
                    const sampleSymbols = symbols.slice(0, 10).map(s => ({
                        name: s.name, 
                        type: s.type, 
                        dataType: s.dataType,
                        hasVarType: variableTypes.has(s.type),
                        hasDataType: !!(s.dataType && s.dataType.length > 0)
                    }));
                    log('First file symbols (first 10):', sampleSymbols);
                    log('variableTypes Set contains:', Array.from(variableTypes));
                }
                
                // Build call graph (skip in lightweight mode for large files)
                if (!useLightweight || file.content.length < 50000) {
                    log('Building call graph for', path, '- symbols:', symbols.length, 'language:', file.language);
                    for (const symbol of symbols) {
                        log('  Symbol:', symbol.name, 'type:', symbol.type, 'isCallable:', callableTypes.has(symbol.type));
                        if (callableTypes.has(symbol.type)) {
                            const calls = findFunctionCalls(file.content, symbol, file.language);
                            log('  Calls found:', calls.length, calls.slice(0, 5));
                            codeIndex.callGraph.set(symbol.name, new Set(calls));
                            
                            for (const called of calls) {
                                if (!codeIndex.reverseCallGraph.has(called)) {
                                    codeIndex.reverseCallGraph.set(called, new Set());
                                }
                                codeIndex.reverseCallGraph.get(called).add(symbol.name);
                            }
                        }
                    }
                }
                
                // Track dependencies
                const deps = findDependencies(file.content, file.language);
                codeIndex.dependencies.set(path, new Set(deps));
                
            } catch (error) {
                log('Error indexing file:', path, error.message);
            }
            
            processedFiles++;
            
            // Update IndexingState
            IndexingState.filesIndexed = processedFiles;
            IndexingState.symbolsFound = totalSymbols;
            IndexingState.setPhase('symbols', Math.round((processedFiles / totalFiles) * 70)); // 0-70% for file parsing
            
            // Update progress after each file (for small repos) or every 10 files (for large)
            const updateFrequency = totalFiles <= 50 ? 1 : 10;
            if (showProgress && chatWebviewView && (processedFiles % updateFrequency === 0 || processedFiles === totalFiles)) {
                const percent = Math.round((processedFiles / totalFiles) * 100);
                chatWebviewView.webview.postMessage({
                    type: 'indexProgress',
                    progress: percent,
                    message: `📂 Parsing: ${processedFiles}/${totalFiles} files | ${totalSymbols} symbols`
                });
                // Yield to UI
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
        
        // Yield to UI between batches
        if (batchIndex < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, INDEX_CONFIG.BATCH_DELAY));
        }
    }
    
    // Second pass: Track variable accesses (skip for large repos)
    if (!useLightweight) {
        for (const [path, file] of contextFiles) {
            trackVariableAccesses(path, file.content, file.language);
        }
    }
    
    codeIndex.lastUpdated = new Date();
    
    // Count symbol types for debugging
    const typeCounts = {};
    const varTypeSymbols = [];
    for (const [key, symbol] of codeIndex.symbols) {
        const t = symbol.type || 'unknown';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
        
        // Track which symbols should be variables
        if (variableTypes.has(symbol.type) || (symbol.dataType && symbol.dataType.length > 0)) {
            if (varTypeSymbols.length < 5) {
                varTypeSymbols.push({ name: symbol.name, type: symbol.type, dataType: symbol.dataType });
            }
        }
    }
    
    const stats = {
        files: codeIndex.files.size,
        symbols: codeIndex.symbols.size,
        variables: codeIndex.variables.size,
        functions: Array.from(codeIndex.callGraph.keys()).length,
        edges: Array.from(codeIndex.callGraph.values()).reduce((sum, calls) => sum + calls.size, 0),
        mode: useLightweight ? 'lightweight' : 'full'
    };
    
    log('Code index built:', stats);
    log('Symbol types breakdown:', typeCounts);
    log('Sample variable-type symbols:', varTypeSymbols);
    log('codeIndex.variables.size:', codeIndex.variables.size);
    
    // Build trigram index for fast text search (lightweight version for initial load)
    IndexingState.setPhase('trigrams', 75);
    if (showProgress && chatWebviewView) {
        chatWebviewView.webview.postMessage({
            type: 'indexProgress',
            progress: 75,
            message: `📊 Building trigram index...`
        });
    }
    
    try {
        // Build trigram index - limit to smaller files for speed during initial indexing
        const trigramOptions = {
            showProgressUI: false,
            maxFilesToIndex: useLightweight ? 200 : 500,  // Limit for initial indexing
            maxFileSize: 50000  // Skip very large files
        };
        await buildTrigramIndexLightweight(trigramOptions);
        stats.trigrams = trigramIndex.index.size;
        log('Trigram index built:', trigramIndex.index.size, 'trigrams');
    } catch (err) {
        log('Trigram indexing error (non-fatal):', err.message);
    }
    
    // ================================================================
    // FIX 1: Build fast search indexes
    // If auto-summary is enabled, skip inverted index here
    // It will be built ONCE after summaries complete (prevents double build)
    // ================================================================
    const summaryConfigForSearch = getSummaryConfig();
    const skipInverted = summaryConfigForSearch.ENABLE_AUTO_SUMMARY;
    
    IndexingState.setPhase('search', 85);
    if (showProgress && chatWebviewView) {
        chatWebviewView.webview.postMessage({
            type: 'indexProgress',
            progress: 85,
            message: skipInverted 
                ? `🔎 Building search indexes (inverted index deferred)...`
                : `🔎 Building search indexes...`
        });
    }
    
    try {
        // Pass skipInvertedIndex option - inverted index built after summaries complete
        const searchStats = searchModule.buildSearchIndexes({ skipInvertedIndex: skipInverted });
        IndexingState.invertedTerms = searchStats.invertedTerms || 0;
        log('Search indexes built:', JSON.stringify(searchStats), skipInverted ? '(inverted index deferred)' : '');
    } catch (err) {
        log('Search index error (non-fatal):', err.message);
    }
    
    // ================================================================
    // LEARN QUERY CLASSIFIER DOMAIN KNOWLEDGE
    // Discovers module mappings, file patterns, and term clusters
    // ================================================================
    try {
        if (!queryClassifier) {
            queryClassifier = new QueryClassifier({ log });
        }
        const classifierStats = queryClassifier.learnFromCodebase(contextFiles, codeIndex);
        log('Query classifier learned:', JSON.stringify(classifierStats));
    } catch (err) {
        log('Query classifier learning error (non-fatal):', err.message);
    }
    
    try {
        // Check if we have COBOL files
        const hasCobolFiles = Array.from(contextFiles.keys()).some(path => 
            /\.(cbl|cob|cobol|cpy)$/i.test(path)
        );
        
        if (hasCobolFiles) {
            if (!cobolClassifier) {
                cobolClassifier = new CobolQueryClassifier({ log });
            }
            const cobolStats = cobolClassifier.learnFromCodebase(contextFiles, codeIndex);
            log('COBOL classifier learned:', JSON.stringify(cobolStats));
        } else {
            log('No COBOL files detected, skipping COBOL classifier');
        }
    } catch (err) {
        log('COBOL classifier learning error (non-fatal):', err.message);
    }
    // ================================================================
    // MARK BASIC INDEXING COMPLETE - Queries can proceed
    // ================================================================
    IndexingState.setPhase('ready', 100);
    IndexingState.isIndexing = false;
    IndexingState.isReady = true;
    
    // Final progress update
    const trigramMsg = stats.trigrams > 0 ? `, ${stats.trigrams} trigrams` : '';
    if (showProgress && chatWebviewView) {
        chatWebviewView.webview.postMessage({
            type: 'indexProgress',
            progress: 100,
            message: `✅ Index ready: ${stats.files} files, ${stats.symbols} symbols${trigramMsg}`
        });
    }
    
    // Discover domain from indexed code (always, regardless of summary setting)
    discoverDomain();
    
    // Generate summaries if enabled (async, don't block)
    // Summaries are essential for answering high-level queries efficiently
    const summaryConfig = getSummaryConfig();
    if (summaryConfig.ENABLE_AUTO_SUMMARY) {
        // Mark that summaries are generating (queries allowed but warned)
        IndexingState.startSummaries();
        
        // Start summary generation in background - generate ALL functions
        generateCodeSummaries().catch(err => {
            log('Background summary generation failed:', err.message);
            IndexingState.isSummarizing = false;
        });
    } else {
        // No summaries to generate, mark fully complete
        IndexingState.complete();
    }
    
    return stats;
}

/**
 * Synchronous version for small file sets (backward compatibility)
 */
function buildCodeIndexSync() {
    // For small file sets, just run the async version synchronously
    if (contextFiles.size <= INDEX_CONFIG.BATCH_SIZE) {
        return buildCodeIndexLegacy();
    }
    // For larger sets, this shouldn't be called - use async version
    log('WARNING: buildCodeIndexSync called with', contextFiles.size, 'files - use buildCodeIndex() instead');
    return buildCodeIndexLegacy();
}

function buildCodeIndexLegacy() {
    log('Building code index (legacy sync) for', contextFiles.size, 'files...');
    
    codeIndex.files.clear();
    codeIndex.symbols.clear();
    codeIndex.variables.clear();
    codeIndex.callGraph.clear();
    codeIndex.reverseCallGraph.clear();
    codeIndex.dependencies.clear();
    
    const callableTypes = new Set([
        'function', 'procedure', 'method', 'subproc',
        'section', 'paragraph', 'program',
        'define', 'macro', 'external', 'forward',
        'view', 'trigger'
    ]);
    
    const variableTypes = new Set([
        'variable', 'parameter', 'field', 'property',
        'record', 'constant', 'literal',
        'global', 'local', 'member'
    ]);
    
    for (const [path, file] of contextFiles) {
        const fileInfo = parseFile(path, file.content, file.language);
        codeIndex.files.set(path, fileInfo);
        
        for (const symbol of fileInfo.symbols) {
            const key = `${symbol.name}@${path}`;
            codeIndex.symbols.set(key, { ...symbol, file: path });
            
            if (!codeIndex.symbols.has(symbol.name)) {
                codeIndex.symbols.set(symbol.name, { ...symbol, file: path });
            }
            
            if (variableTypes.has(symbol.type) || (symbol.dataType && symbol.dataType.length > 0)) {
                const varKey = `${symbol.name}@${path}`;
                codeIndex.variables.set(varKey, {
                    name: symbol.name,
                    dataType: symbol.dataType || symbol.type || 'unknown',
                    file: path,
                    declarationLine: symbol.line,
                    initializationLine: symbol.initLine || symbol.line,
                    scope: symbol.scope || 'global',
                    accesses: []
                });
            }
        }
        
        for (const symbol of fileInfo.symbols) {
            if (callableTypes.has(symbol.type)) {
                const calls = findFunctionCalls(file.content, symbol, file.language);
                codeIndex.callGraph.set(symbol.name, new Set(calls));
                
                for (const called of calls) {
                    if (!codeIndex.reverseCallGraph.has(called)) {
                        codeIndex.reverseCallGraph.set(called, new Set());
                    }
                    codeIndex.reverseCallGraph.get(called).add(symbol.name);
                }
            }
        }
        
        const deps = findDependencies(file.content, file.language);
        codeIndex.dependencies.set(path, new Set(deps));
    }
    
    for (const [path, file] of contextFiles) {
        trackVariableAccesses(path, file.content, file.language);
    }
    
    codeIndex.lastUpdated = new Date();
    
    return {
        files: codeIndex.files.size,
        symbols: codeIndex.symbols.size,
        variables: codeIndex.variables.size,
        functions: Array.from(codeIndex.callGraph.keys()).length,
        edges: Array.from(codeIndex.callGraph.values()).reduce((sum, calls) => sum + calls.size, 0)
    };
}

/**
 * Generate a one-liner summary for a function/procedure
 * Extracts from: leading comment, docstring, or first meaningful line
 */
function generateFunctionSummary(content, lineNumber, language) {
    const lines = content.split('\n');
    const startLine = Math.max(0, lineNumber - 1);
    
    // Look for leading comment (up to 5 lines before function)
    for (let i = startLine - 1; i >= Math.max(0, startLine - 5); i--) {
        const line = lines[i].trim();
        
        // Skip empty lines
        if (!line) continue;
        
        // Check for various comment formats
        // C-style: /** ... */ or /* ... */ or // ...
        if (line.startsWith('//')) {
            const comment = line.replace(/^\/\/\s*/, '').trim();
            if (comment && comment.length > 5 && comment.length < 200) {
                return comment;
            }
        }
        if (line.startsWith('*') && !line.startsWith('*/')) {
            const comment = line.replace(/^\*\s*/, '').trim();
            if (comment && comment.length > 5 && comment.length < 200 && !comment.startsWith('@')) {
                return comment;
            }
        }
        // Python docstring
        if (line.startsWith('"""') || line.startsWith("'''")) {
            const comment = line.replace(/^['"]{3}\s*/, '').replace(/['"]{3}$/, '').trim();
            if (comment && comment.length > 5) {
                return comment;
            }
        }
        // TAL/COBOL comment
        if (line.startsWith('!') || line.startsWith('*>')) {
            const comment = line.replace(/^[!*>]+\s*/, '').trim();
            if (comment && comment.length > 5 && comment.length < 200) {
                return comment;
            }
        }
        
        // If we hit a non-comment line, stop looking
        if (!line.startsWith('*') && !line.startsWith('/') && !line.startsWith('#') && 
            !line.startsWith('!') && !line.startsWith('"') && !line.startsWith("'")) {
            break;
        }
    }
    
    // Look for inline comment on function line or first line of body
    for (let i = startLine; i < Math.min(lines.length, startLine + 3); i++) {
        const line = lines[i];
        
        // Check for inline comment
        const inlineComment = line.match(/\/\/\s*(.+)$/) || 
                              line.match(/!\s*(.+)$/) ||
                              line.match(/#\s*(.+)$/);
        if (inlineComment && inlineComment[1].length > 5 && inlineComment[1].length < 200) {
            return inlineComment[1].trim();
        }
    }
    
    // Fallback: Generate from function name
    return null;
}

// ============================================================
// LLM-Based Summary Generation (for intelligent query handling)
// ============================================================

/**
 * Generate summaries for all functions in the codebase
 * Called after indexing to enable high-level query answering
 * @param {number|null} maxFunctions - Optional limit on functions to summarize (prioritizes most important)
 */
async function generateCodeSummaries(maxFunctions = null) {
    // Get config from settings
    const summaryConfig = getSummaryConfig();
    
    if (!summaryConfig.ENABLE_AUTO_SUMMARY) {
        log('generateCodeSummaries: Auto-summary disabled in settings');
        return;
    }
    
    log('generateCodeSummaries: Starting summary generation...');
    
    // Clear existing summaries
    codeIndex.summaries.clear();
    codeIndex.fileSummaries.clear();
    codeIndex.overallSummary = null;
    
    // Get all callable symbols (functions, procedures, methods, etc.)
    // Only include functions that are in the callGraph (consistent with "funcs" count in status bar)
    const callableTypes = new Set([
        'function', 'procedure', 'method', 'subproc',
        'section', 'paragraph', 'program',
        'define', 'macro'
    ]);
    
    const functionsToSummarize = [];
    const typeBreakdown = {};
    let skippedNotInCallGraph = 0;
    
    for (const [key, symbol] of codeIndex.symbols) {
        // Skip duplicate entries (we have both "name" and "name@path" entries)
        if (!key.includes('@')) continue;
        
        if (callableTypes.has(symbol.type)) {
            typeBreakdown[symbol.type] = (typeBreakdown[symbol.type] || 0) + 1;
            
            // Only summarize functions that appear in the call graph
            // This matches the "7814 funcs" count shown in the status bar
            const isInCallGraph = codeIndex.callGraph.has(symbol.name) || 
                                  codeIndex.reverseCallGraph?.has(symbol.name);
            
            if (!isInCallGraph) {
                skippedNotInCallGraph++;
                continue;
            }
            
            functionsToSummarize.push({
                key,
                name: symbol.name,
                type: symbol.type,
                file: symbol.file,
                line: symbol.line,
                signature: symbol.signature,
                // Priority score: entry points (called often) + functions that call others
                priority: (codeIndex.reverseCallGraph?.get(symbol.name)?.size || 0) * 2 + 
                         (codeIndex.callGraph.get(symbol.name)?.size || 0)
            });
        }
    }
    
    // Log type breakdown to understand counts
    log(`generateCodeSummaries: Type breakdown (all): ${JSON.stringify(typeBreakdown)}`);
    log(`generateCodeSummaries: Skipped ${skippedNotInCallGraph} not in call graph`);
    
    log(`generateCodeSummaries: Found ${functionsToSummarize.length} functions to summarize`);
    log(`generateCodeSummaries: contextFiles has ${contextFiles.size} files`);
    
    // Debug: check how many functions have their files in context
    let filesInContext = 0;
    let filesNotInContext = 0;
    const samplePaths = { context: [], func: [] };
    
    for (const func of functionsToSummarize) {
        if (contextFiles.has(func.file)) {
            filesInContext++;
        } else {
            filesNotInContext++;
            if (samplePaths.func.length < 3) {
                samplePaths.func.push(func.file);
            }
        }
    }
    
    // Get sample context file paths
    for (const [path] of contextFiles) {
        if (samplePaths.context.length < 3) {
            samplePaths.context.push(path);
        }
    }
    
    log(`generateCodeSummaries: ${filesInContext} funcs have files in context, ${filesNotInContext} do not`);
    if (filesNotInContext > 0) {
        log(`generateCodeSummaries: Sample context paths: ${samplePaths.context.join(', ')}`);
        log(`generateCodeSummaries: Sample func paths: ${samplePaths.func.join(', ')}`);
    }
    
    // Sort by priority (most important first) and apply limit
    functionsToSummarize.sort((a, b) => b.priority - a.priority);
    
    const toProcess = maxFunctions 
        ? functionsToSummarize.slice(0, maxFunctions)
        : functionsToSummarize;
    
    if (toProcess.length === 0) {
        log('generateCodeSummaries: No functions to summarize');
        return;
    }
    
    const limitMsg = maxFunctions ? ` (top ${maxFunctions} by importance)` : '';
    log(`generateCodeSummaries: Processing ${toProcess.length} functions${limitMsg}`);
    
    // Show progress in status bar AND VS Code status bar
    updateSummaryStatus(0, `📚 Summarizing ${toProcess.length} functions${limitMsg}...`);
    
    // Check if LLM is available first
    let llmAvailable = true;
    try {
        if (!vscode.lm || !vscode.lm.selectChatModels) {
            llmAvailable = false;
        } else {
            const models = await vscode.lm.selectChatModels({});
            llmAvailable = models.length > 0;
        }
    } catch (e) {
        llmAvailable = false;
    }
    
    // If LLM not available, generate name-based summaries immediately
    if (!llmAvailable) {
        log('generateCodeSummaries: LLM not available, generating name-based summaries for all functions');
        updateSummaryStatus(10, `📝 LLM unavailable - generating ${toProcess.length} name-based summaries...`);
        
        let generated = 0;
        for (const func of toProcess) {
            const summary = generateSummaryFromName(func.name);
            codeIndex.summaries.set(func.key, {
                name: func.name,
                type: func.type,
                file: func.file,
                line: func.line,
                summary: summary
            });
            generated++;
            
            // Update progress every 100 functions
            if (generated % 100 === 0 || generated === toProcess.length) {
                const percent = Math.round((generated / toProcess.length) * 80);
                IndexingState.summariesGenerated = codeIndex.summaries.size;
                IndexingState.setPhase('summaries', percent);
                updateSummaryStatus(percent, `📝 Generated ${generated}/${toProcess.length} summaries`);
            }
        }
        
        log(`generateCodeSummaries: Generated ${generated} name-based summaries`);
        
        // Skip to file summaries
        updateSummaryStatus(85, '📁 Building file summaries...');
        await generateFileSummaries();
        updateSummaryStatus(90, '🔍 Creating codebase overview...');
        await generateOverallSummary();
        
        // Rebuild inverted index and complete
        IndexingState.setPhase('inverted', 95);
        IndexingState.summariesGenerated = codeIndex.summaries.size;
        
        if (typeof searchModule.buildSearchIndexes === 'function') {
            try {
                log('generateCodeSummaries: Rebuilding inverted index with name-based summaries...');
                const searchStats = searchModule.buildSearchIndexes();
                IndexingState.invertedTerms = searchStats.invertedTerms || 0;
                log('generateCodeSummaries: Inverted index rebuilt:', JSON.stringify(searchStats));
            } catch (err) {
                log('generateCodeSummaries: Inverted index rebuild error:', err.message);
            }
        }
        
        IndexingState.complete();
        updateSummaryStatus(100, `✓ ${codeIndex.summaries.size} summaries (name-based)`, codeIndex.summaries.size);
        
        if (chatWebviewView) {
            chatWebviewView.webview.postMessage({
                type: 'indexProgress',
                progress: 100,
                message: `✅ Ready: ${codeIndex.symbols.size} symbols | ${codeIndex.summaries.size} summaries (name-based) | ${IndexingState.invertedTerms} terms`
            });
        }
        
        return;
    }
    
    // LLM is available - proceed with batch processing
    log('generateCodeSummaries: LLM available, proceeding with LLM-based summaries');
    
    // Process in batches
    const batchSize = SUMMARY_CONFIG.SUMMARY_BATCH_SIZE;
    let summarized = 0;
    let actualSummaries = 0;
    let skippedFunctions = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
    
    // Show initial progress in chat
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `\n📝 **Generating summaries for ${toProcess.length} functions...**\n\n`
    });
    
    // ================================================================
    // FIX 2: Batch processing loop with proper error handling
    // ================================================================
    for (let i = 0; i < toProcess.length; i += batchSize) {
        if (taskController.isCancelled) {
            log('Summary generation cancelled');
            updateSummaryStatus(-1, 'Cancelled');
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n⚠️ Summary generation cancelled.\n`
            });
            break;
        }
        
        const batch = toProcess.slice(i, i + batchSize);
        const beforeCount = codeIndex.summaries.size;
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(toProcess.length / batchSize);
        
        try {
            await summarizeFunctionBatch(batch);
            summarized += batch.length;
            const addedThisBatch = codeIndex.summaries.size - beforeCount;
            actualSummaries += addedThisBatch;
            consecutiveFailures = 0; // Reset on success
            
            if (addedThisBatch < batch.length) {
                skippedFunctions += (batch.length - addedThisBatch);
            }
            
            // Progress update every few batches - show in chat window
            const updateFrequency = toProcess.length > 500 ? 50 : 20;
            if (summarized % updateFrequency === 0 || summarized === toProcess.length) {
                const percent = Math.round((summarized / toProcess.length) * 100);
                IndexingState.summariesGenerated = codeIndex.summaries.size;
                IndexingState.setPhase('summaries', percent);
                updateSummaryStatus(percent, `📝 ${codeIndex.summaries.size}/${toProcess.length} (${percent}%)`);
                
                // Log progress to chat window every 100 functions
                if (summarized % 100 === 0 || summarized === toProcess.length) {
                    const sampleFuncs = batch.slice(0, 3).map(f => f.name).join(', ');
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `✓ Batch ${batchNum}/${totalBatches}: ${codeIndex.summaries.size} summaries (${percent}%) - ${sampleFuncs}...\n`
                    });
                }
            }
        } catch (error) {
            log('generateCodeSummaries: Batch error:', error.message);
            skippedFunctions += batch.length;
            consecutiveFailures++;
            
            // Log error to chat
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `⚠️ Batch ${batchNum} error: ${error.message.substring(0, 50)}...\n`
            });
            
            // FIX: If too many consecutive failures, STOP and use name-based summaries
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                log('generateCodeSummaries: Too many failures (' + consecutiveFailures + '), stopping LLM attempts');
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n⚠️ Too many errors (${consecutiveFailures}). Using name-based summaries for remaining ${toProcess.length - summarized} functions...\n`
                });
                
                // FIX: Generate name-based summaries for ALL remaining functions
                // Starting from current batch index (j=i), not next batch (j=i+batchSize)
                // This ensures the current failed batch also gets summaries
                for (let j = i; j < toProcess.length; j++) {
                    const func = toProcess[j];
                    // Only add if not already summarized
                    if (!codeIndex.summaries.has(func.key)) {
                        const summary = generateSummaryFromName(func.name);
                        codeIndex.summaries.set(func.key, {
                            name: func.name,
                            type: func.type,
                            file: func.file,
                            line: func.line,
                            summary: summary
                        });
                    }
                }
                summarized = toProcess.length;
                IndexingState.summariesGenerated = codeIndex.summaries.size;
                break;  // EXIT THE LOOP
            }
            
            // FIX: Add delay before retry to avoid hammering a failing service
            log('generateCodeSummaries: Waiting 2s before retry...');
            await new Promise(r => setTimeout(r, 2000));
        }
        
        // Small delay between batches to avoid rate limits
        await new Promise(r => setTimeout(r, 100));
    }
    
    // Log completion to chat
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `\n✅ **Summary generation complete: ${codeIndex.summaries.size} summaries**\n`
    });
    
    // Update status for file summaries phase
    updateSummaryStatus(90, '📁 Building file summaries...');
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `📁 Building file summaries...\n`
    });
    
    // Generate file-level summaries
    await generateFileSummaries();
    
    // Update status for overall summary phase
    updateSummaryStatus(95, '🔍 Creating codebase overview...');
    
    // Generate overall codebase summary
    await generateOverallSummary();
    
    log(`generateCodeSummaries: Complete. ${codeIndex.summaries.size} function summaries, ${codeIndex.fileSummaries.size} file summaries (${skippedFunctions} skipped)`);
    
    // ================================================================
    // REBUILD INVERTED INDEX with summaries now available
    // ================================================================
    IndexingState.setPhase('inverted', 95);
    IndexingState.summariesGenerated = codeIndex.summaries.size;
    
    if (typeof searchModule.buildSearchIndexes === 'function') {
        try {
            log('generateCodeSummaries: Rebuilding inverted index with summaries...');
            
            if (chatWebviewView) {
                chatWebviewView.webview.postMessage({
                    type: 'indexProgress',
                    progress: 95,
                    message: `📚 Building inverted index with ${codeIndex.summaries.size} summaries...`
                });
                chatWebviewView.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n📚 **Rebuilding inverted index with ${codeIndex.summaries.size} summaries...**\n`
                });
            }
            
            const searchStats = searchModule.buildSearchIndexes();
            IndexingState.invertedTerms = searchStats.invertedTerms || 0;
            log('generateCodeSummaries: Inverted index rebuilt:', JSON.stringify(searchStats));
            
            // Log success to chat
            if (chatWebviewView) {
                chatWebviewView.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `✅ Inverted index rebuilt: ${IndexingState.invertedTerms} search terms\n`
                });
            }
        } catch (err) {
            log('generateCodeSummaries: Inverted index rebuild error:', err.message);
            if (chatWebviewView) {
                chatWebviewView.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `⚠️ Inverted index error: ${err.message}\n`
                });
            }
        }
    }
    
    // ================================================================
    // RE-LEARN QUERY CLASSIFIER with summaries now available
    // Summaries provide richer term clusters for domain knowledge
    // ================================================================
    try {
        if (queryClassifier) {
            log('generateCodeSummaries: Re-learning query classifier with summaries...');
            const classifierStats = queryClassifier.learnFromCodebase(contextFiles, codeIndex);
            log('generateCodeSummaries: Query classifier re-learned:', JSON.stringify(classifierStats));
        }
    } catch (err) {
        log('generateCodeSummaries: Query classifier re-learning error:', err.message);
    }

    try {
        if (cobolClassifier) {
            log('generateCodeSummaries: Re-learning COBOL classifier with summaries...');
            const cobolStats = cobolClassifier.learnFromCodebase(contextFiles, codeIndex);
            log('generateCodeSummaries: COBOL classifier re-learned:', JSON.stringify(cobolStats));
        }
    } catch (err) {
        log('generateCodeSummaries: COBOL classifier re-learning error:', err.message);
    }
    
    // ================================================================
    // MARK FULLY COMPLETE
    // ================================================================
    IndexingState.complete();
    
    // Show completion in both status bar and webview
    updateSummaryStatus(100, '✓ Summaries complete', codeIndex.summaries.size);
    
    if (chatWebviewView) {
        chatWebviewView.webview.postMessage({
            type: 'indexProgress',
            progress: 100,
            message: `✅ Ready: ${codeIndex.symbols.size} symbols | ${codeIndex.summaries.size} summaries | ${IndexingState.invertedTerms} search terms`
        });
        
        // Final success message in chat
        chatWebviewView.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n🎉 **Indexing complete!**\n- ${codeIndex.symbols.size} symbols\n- ${codeIndex.summaries.size} summaries\n- ${IndexingState.invertedTerms} search terms\n\n**Ready for queries!**\n\n`
        });
        chatWebviewView.webview.postMessage({ type: 'finalizeResponse' });
    }
    
    // ================================================================
    // PERSIST CODE INDEX (saves summaries for next session)
    // ================================================================
    if (persistenceManager) {
        try {
            log('Persisting code index to storage...');
            await persistenceManager.saveCodeIndex(codeIndex);
            log('Code index persisted successfully');
            
            if (chatWebviewView) {
                chatWebviewView.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `💾 Index saved - will load instantly next time\n\n`
                });
            }
        } catch (err) {
            log('Failed to persist code index:', err.message);
        }
    }
    
    // Log if many were skipped
    if (skippedFunctions > toProcess.length * 0.2) {
        log(`WARNING: ${skippedFunctions}/${toProcess.length} functions could not be summarized (code extraction or LLM parsing issues)`);
    }
    
    // Update main status line to show summary count
    if (typeof updateChatStatusUI === 'function') {
        updateChatStatusUI();
    }
}

/**
 * Summarize a batch of functions using LLM
 */
async function summarizeFunctionBatch(functions) {
    // Build batch prompt with function code
    let batchContent = '';
    const functionCodes = [];
    let skippedNoFile = 0;
    let skippedTooSmall = 0;
    
    for (const func of functions) {
        const file = contextFiles.get(func.file);
        if (!file) {
            skippedNoFile++;
            continue;
        }
        
        // Extract function code
        const funcCode = extractFunctionCode(file.content, func.line, file.language);
        if (!funcCode || funcCode.length < SUMMARY_CONFIG.MIN_FUNCTION_SIZE) {
            skippedTooSmall++;
            continue;
        }
        
        const truncatedCode = funcCode.substring(0, SUMMARY_CONFIG.MAX_FUNCTION_SIZE);
        functionCodes.push({ func, code: truncatedCode });
        
        batchContent += `\n### ${func.name} (${func.type} in ${pathUtils.getFileName(func.file)}:${func.line})
\`\`\`
${truncatedCode}
\`\`\`
`;
    }
    
    if (skippedNoFile > 0 || skippedTooSmall > 0) {
        log(`summarizeFunctionBatch: Skipped ${skippedNoFile} (no file) + ${skippedTooSmall} (too small) of ${functions.length}`);
    }
    
    // Save fallback summaries for functions we couldn't extract code for
    const skippedFuncs = functions.filter(f => !functionCodes.find(fc => fc.func.key === f.key));
    if (skippedFuncs.length > 0) {
        log(`summarizeFunctionBatch: Saving ${skippedFuncs.length} fallback summaries for skipped functions`);
    }
    for (const func of skippedFuncs) {
        const summary = generateSummaryFromName(func.name);
        codeIndex.summaries.set(func.key, {
            name: func.name,
            type: func.type,
            file: func.file,
            line: func.line,
            summary: summary
        });
    }
    
    // If no code could be extracted, we're done (fallbacks already saved above)
    if (functionCodes.length === 0) return;
    
    const prompt = `Summarize each function in 1-2 sentences. Focus on: what it does, key inputs/outputs, and business purpose.

${batchContent}

Respond in this exact format for each function:
FUNCTION: <name>
SUMMARY: <1-2 sentence summary>
---`;

    try {
        // Use summary-specific LLM call (allows longer responses than classification)
        const response = await callLanguageModelForSummary(prompt, 3000);
        
        // ALWAYS save summaries - LLM or fallback
        let matched = 0;
        
        if (!response || response.trim().length < 20) {
            log(`summarizeFunctionBatch: No/empty LLM response, using name-based summaries`);
            // Fallback: generate from names
            for (const funcItem of functionCodes) {
                const summary = generateSummaryFromName(funcItem.func.name);
                codeIndex.summaries.set(funcItem.func.key, {
                    name: funcItem.func.name,
                    type: funcItem.func.type,
                    file: funcItem.func.file,
                    line: funcItem.func.line,
                    summary: summary
                });
                matched++;
            }
            log(`summarizeFunctionBatch: Generated ${matched} name-based summaries`);
            return;
        }
        
        // Debug: log first response to see format
        if (codeIndex.summaries.size === 0) {
            log(`summarizeFunctionBatch: First LLM response sample (${response.length} chars):`);
            log(response.substring(0, 800));
        }
        
        // ULTRA-ROBUST PARSING: Try multiple strategies
        
        // Strategy 1: Look for each function name in the response and extract nearby summary
        for (const funcItem of functionCodes) {
            if (funcItem.used) continue;
            
            const funcName = funcItem.func.name;
            const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Try multiple patterns to find this function's summary
            const patterns = [
                // Pattern: FUNCTION: name\nSUMMARY: ...
                new RegExp(`FUNCTION:\\s*${escapedName}[^\\n]*\\n+SUMMARY:\\s*([^\\n]+(?:\\n(?!FUNCTION:|---|###)[^\\n]+)*)`, 'i'),
                // Pattern: ### name\n... (markdown style)
                new RegExp(`###\\s*${escapedName}[^\\n]*\\n+([^#]+?)(?=###|$)`, 'i'),
                // Pattern: **name**: summary or name: summary
                new RegExp(`(?:\\*\\*)?${escapedName}(?:\\*\\*)?[:\\s]+([^\\n]+)`, 'i'),
                // Pattern: name - summary
                new RegExp(`${escapedName}\\s*[-–:]\\s*([^\\n]+)`, 'i'),
                // Pattern: 1. name: summary (numbered list)
                new RegExp(`\\d+\\.\\s*${escapedName}[:\\s]+([^\\n]+)`, 'i'),
            ];
            
            for (const pattern of patterns) {
                const match = response.match(pattern);
                if (match && match[1]) {
                    const summary = match[1].trim()
                        .replace(/^[-–:]\s*/, '')  // Remove leading dash/colon
                        .replace(/\n+/g, ' ')      // Collapse newlines
                        .substring(0, 500);
                    
                    if (summary.length > 10) {  // Sanity check
                        codeIndex.summaries.set(funcItem.func.key, {
                            name: funcItem.func.name,
                            type: funcItem.func.type,
                            file: funcItem.func.file,
                            line: funcItem.func.line,
                            summary: summary
                        });
                        funcItem.used = true;
                        matched++;
                        break;
                    }
                }
            }
        }
        
        // Strategy 2: If Strategy 1 got low matches, try order-based assignment
        // Split response by various delimiters and assign in order
        if (matched < functionCodes.length * 0.5) {
            log(`summarizeFunctionBatch: Low match rate (${matched}/${functionCodes.length}), trying order-based`);
            
            // Split by ---, ###, numbered items, or FUNCTION:
            const blocks = response.split(/(?:---|###|\d+\.\s+|FUNCTION:)/i).filter(b => b.trim().length > 20);
            
            let orderIdx = 0;
            for (const funcItem of functionCodes) {
                if (funcItem.used || orderIdx >= blocks.length) continue;
                
                const block = blocks[orderIdx];
                // Extract any sentence-like content as summary
                const summaryMatch = block.match(/(?:SUMMARY:\s*)?([A-Z][^.!?]*[.!?])/i) ||
                                    block.match(/([^:\n]{20,})/);
                
                if (summaryMatch) {
                    const summary = summaryMatch[1].trim().substring(0, 500);
                    if (summary.length > 15) {
                        codeIndex.summaries.set(funcItem.func.key, {
                            name: funcItem.func.name,
                            type: funcItem.func.type,
                            file: funcItem.func.file,
                            line: funcItem.func.line,
                            summary: summary
                        });
                        funcItem.used = true;
                        matched++;
                    }
                }
                orderIdx++;
            }
        }
        
        // Strategy 3: GUARANTEED fallback - generate from function name for ALL unmatched
        for (const funcItem of functionCodes) {
            if (funcItem.used) continue;
            
            // Generate a basic summary from the function name
            const summary = generateSummaryFromName(funcItem.func.name);
            codeIndex.summaries.set(funcItem.func.key, {
                name: funcItem.func.name,
                type: funcItem.func.type,
                file: funcItem.func.file,
                line: funcItem.func.line,
                summary: summary
            });
            matched++;
        }
        
        log(`summarizeFunctionBatch: Final matched ${matched}/${functionCodes.length}`);
        log(`summarizeFunctionBatch: Total summaries now: ${codeIndex.summaries.size}`);
        
    } catch (error) {
        log('summarizeFunctionBatch: Error:', error.message);
        // On error, still generate basic summaries from names
        for (const funcItem of functionCodes) {
            if (!funcItem.used) {
                const summary = generateSummaryFromName(funcItem.func.name);
                codeIndex.summaries.set(funcItem.func.key, {
                    name: funcItem.func.name,
                    type: funcItem.func.type,
                    file: funcItem.func.file,
                    line: funcItem.func.line,
                    summary: summary
                });
            }
        }
    }
}

/**
 * Generate a reasonable summary from function name using naming conventions
 */
function generateSummaryFromName(name) {
    // Split camelCase, snake_case, PascalCase
    const words = name
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
        .replace(/_/g, ' ')                     // snake_case
        .replace(/-/g, ' ')                     // kebab-case
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 0);
    
    if (words.length === 0) return `Function ${name}`;
    
    // Common verb patterns
    const verbMap = {
        'get': 'Gets', 'set': 'Sets', 'is': 'Checks if', 'has': 'Checks if has',
        'can': 'Checks if can', 'init': 'Initializes', 'create': 'Creates',
        'make': 'Creates', 'build': 'Builds', 'parse': 'Parses',
        'read': 'Reads', 'write': 'Writes', 'load': 'Loads', 'save': 'Saves',
        'find': 'Finds', 'search': 'Searches for', 'check': 'Checks',
        'validate': 'Validates', 'process': 'Processes', 'handle': 'Handles',
        'update': 'Updates', 'delete': 'Deletes', 'remove': 'Removes',
        'add': 'Adds', 'insert': 'Inserts', 'append': 'Appends',
        'convert': 'Converts', 'transform': 'Transforms', 'format': 'Formats',
        'calculate': 'Calculates', 'compute': 'Computes', 'count': 'Counts',
        'send': 'Sends', 'receive': 'Receives', 'fetch': 'Fetches',
        'open': 'Opens', 'close': 'Closes', 'start': 'Starts', 'stop': 'Stops',
        'enable': 'Enables', 'disable': 'Disables', 'reset': 'Resets',
        'clear': 'Clears', 'print': 'Prints', 'log': 'Logs', 'display': 'Displays',
        'on': 'Handles', 'do': 'Performs', 'run': 'Runs', 'exec': 'Executes',
        'perform': 'Performs', 'apply': 'Applies', 'render': 'Renders'
    };
    
    const firstWord = words[0];
    const restWords = words.slice(1).join(' ');
    
    if (verbMap[firstWord]) {
        return `${verbMap[firstWord]} ${restWords}`.trim() + '.';
    }
    
    // If no verb, describe as a noun
    return `Handles ${words.join(' ')}.`;
}

/**
 * Extract function code starting from a line number
 */
function extractFunctionCode(content, startLine, language) {
    const lines = content.split('\n');
    if (startLine < 1 || startLine > lines.length) return null;
    
    const startIdx = startLine - 1;
    let endIdx = startIdx;
    let braceCount = 0;
    let foundOpen = false;
    
    // Language-specific extraction
    const langLower = (language || '').toLowerCase();
    
    if (langLower === 'python') {
        // Python: use indentation
        const baseIndent = lines[startIdx].match(/^(\s*)/)[1].length;
        for (let i = startIdx + 1; i < lines.length && i < startIdx + 200; i++) {
            const line = lines[i];
            if (line.trim() === '') continue;
            const indent = line.match(/^(\s*)/)[1].length;
            if (indent <= baseIndent && line.trim() !== '') {
                endIdx = i - 1;
                break;
            }
            endIdx = i;
        }
    } else if (langLower === 'cobol') {
        // COBOL: find next paragraph/section
        for (let i = startIdx + 1; i < lines.length && i < startIdx + 300; i++) {
            const line = lines[i];
            if (/^\s{0,6}[A-Z0-9-]+\s+(SECTION|PARAGRAPH)\.?/i.test(line) ||
                /^\s{0,6}[A-Z0-9-]+\.\s*$/i.test(line)) {
                endIdx = i - 1;
                break;
            }
            endIdx = i;
        }
    } else {
        // C-style: use brace matching
        for (let i = startIdx; i < lines.length && i < startIdx + 300; i++) {
            const line = lines[i];
            braceCount += (line.match(/\{/g) || []).length;
            braceCount -= (line.match(/\}/g) || []).length;
            
            if (braceCount > 0) foundOpen = true;
            
            if (foundOpen && braceCount === 0) {
                endIdx = i;
                break;
            }
            endIdx = i;
        }
    }
    
    return lines.slice(startIdx, endIdx + 1).join('\n');
}

/**
 * Generate file-level summaries
 */
async function generateFileSummaries() {
    // Process all files (file summaries are built from function summaries, no LLM calls)
    const files = Array.from(contextFiles.entries());
    
    log(`generateFileSummaries: Processing ${files.length} files`);
    
    let processed = 0;
    for (const [filePath, file] of files) {
        if (taskController.isCancelled) break;
        
        const fileName = pathUtils.getFileName(filePath);
        
        // Get function summaries for this file
        const fileFuncSummaries = [];
        for (const [key, summary] of codeIndex.summaries) {
            if (summary.file === filePath) {
                fileFuncSummaries.push(`- ${summary.name}: ${summary.summary}`);
            }
        }
        
        // Build file summary from function summaries + structure
        let fileSummary = '';
        if (fileFuncSummaries.length > 0) {
            fileSummary = `File ${fileName} contains ${fileFuncSummaries.length} functions:\n${fileFuncSummaries.slice(0, 30).join('\n')}`;
            if (fileFuncSummaries.length > 30) {
                fileSummary += `\n... and ${fileFuncSummaries.length - 30} more functions`;
            }
        } else {
            // Quick structural summary
            const lines = file.content.split('\n').length;
            fileSummary = `File ${fileName}: ${lines} lines of ${file.language} code`;
        }
        
        codeIndex.fileSummaries.set(filePath, fileSummary);
        processed++;
        
        // Log progress every 20 files
        if (processed % 20 === 0 || processed === files.length) {
            log(`generateFileSummaries: ${processed}/${files.length} files processed`);
        }
    }
    
    log(`generateFileSummaries: Complete. ${codeIndex.fileSummaries.size} file summaries created`);
}

/**
 * Generate overall codebase summary from file summaries
 */
async function generateOverallSummary() {
    if (codeIndex.fileSummaries.size === 0) {
        codeIndex.overallSummary = `Codebase with ${contextFiles.size} files, ${codeIndex.symbols.size} symbols`;
        return;
    }
    
    // Group file summaries by module for better synthesis
    const moduleMap = new Map();
    for (const [filePath, summary] of codeIndex.fileSummaries) {
        const parts = pathUtils.splitPath(filePath);
        const module = parts.length > 2 ? parts.slice(-3, -1).join('/') : parts.slice(0, -1).join('/') || 'root';
        const fileName = pathUtils.getFileName(filePath);
        if (!moduleMap.has(module)) moduleMap.set(module, []);
        moduleMap.get(module).push({ file: fileName, summary });
    }
    
    // Build module-level summary text
    let summaryText = `## Codebase Structure (${contextFiles.size} files, ${codeIndex.fileSummaries.size} summarized)\n\n`;
    
    for (const [module, files] of Array.from(moduleMap.entries()).slice(0, 30)) {
        summaryText += `### ${module}/ (${files.length} files)\n`;
        for (const f of files.slice(0, 5)) {
            summaryText += `- ${f.file}: ${f.summary.substring(0, 150)}\n`;
        }
        if (files.length > 5) summaryText += `- ... +${files.length - 5} more\n`;
        summaryText += '\n';
    }
    
    const prompt = `Based on these module and file summaries, write a DEVELOPER-FOCUSED overview (3-5 sentences) of what this codebase does:

${summaryText}

Focus on:
1. Main purpose/functionality
2. Key modules and their responsibilities  
3. Architectural patterns (if evident)
4. Important dependencies or integration points

Write for developers who need to understand this codebase quickly.`;

    try {
        // Use summary-specific LLM call (allows longer responses)
        const response = await callLanguageModelForSummary(prompt, 2000);
        codeIndex.overallSummary = response?.substring(0, 2500) || 
            `Codebase with ${contextFiles.size} files containing ${codeIndex.symbols.size} symbols across ${moduleMap.size} modules`;
    } catch (error) {
        log('generateOverallSummary: Error:', error.message);
        codeIndex.overallSummary = `Codebase with ${contextFiles.size} files containing ${codeIndex.symbols.size} symbols`;
    }
}

/**
 * Discover domain from indexed code
 * Analyzes file paths, symbol names, and code patterns to infer the domain
 * This info is cleared when the index is cleared
 */
function discoverDomain() {
    log('discoverDomain: Analyzing indexed code...');
    
    const domain = {
        languages: new Map(),      // language -> count
        frameworks: [],            // detected frameworks
        patterns: [],              // detected patterns (e.g., MVC, microservices)
        keyTerms: new Map(),       // frequent terms in symbol names
        modules: [],               // top-level modules/directories
        fileTypes: new Map(),      // file extensions -> count
        description: ''            // One-line description
    };
    
    // Analyze languages
    for (const [path, file] of contextFiles) {
        const lang = file.language || 'unknown';
        domain.languages.set(lang, (domain.languages.get(lang) || 0) + 1);
        
        const ext = path.split('.').pop();
        domain.fileTypes.set(ext, (domain.fileTypes.get(ext) || 0) + 1);
    }
    
    // Analyze symbol names to find key terms
    const termCounts = new Map();
    for (const [key, symbol] of codeIndex.symbols) {
        if (key.includes('@')) continue;
        
        // Extract words from symbol name
        const words = symbol.name
            .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
            .replace(/_/g, ' ')                     // snake_case
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 3);
        
        for (const word of words) {
            termCounts.set(word, (termCounts.get(word) || 0) + 1);
        }
    }
    
    // Get top terms (excluding very common ones)
    const commonWords = new Set(['init', 'get', 'set', 'create', 'delete', 'update', 'handle', 'process', 'make', 'check', 'validate', 'parse', 'read', 'write', 'open', 'close', 'start', 'stop', 'data', 'info', 'list', 'item', 'node', 'value', 'result', 'error', 'state', 'type', 'name', 'index', 'count', 'size', 'length']);
    const sortedTerms = Array.from(termCounts.entries())
        .filter(([term, count]) => count > 2 && !commonWords.has(term))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30);
    
    domain.keyTerms = new Map(sortedTerms);
    
    // Analyze top-level directories
    const dirCounts = new Map();
    for (const [filePath] of contextFiles) {
        const parts = pathUtils.splitPath(filePath);
        if (parts.length > 1) {
            const topDir = parts.slice(0, Math.min(3, parts.length - 1)).join('/');
            dirCounts.set(topDir, (dirCounts.get(topDir) || 0) + 1);
        }
    }
    domain.modules = Array.from(dirCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([dir, count]) => ({ name: dir, files: count }));
    
    // Build description from what we found
    const langList = Array.from(domain.languages.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([lang]) => lang);
    
    const topTerms = Array.from(domain.keyTerms.keys()).slice(0, 10);
    const topModules = domain.modules.slice(0, 5).map(m => pathUtils.getFileName(m.name));
    
    domain.description = `${langList.join('/')} codebase with ${contextFiles.size} files. ` +
        `Key areas: ${topModules.join(', ')}. ` +
        `Frequent terms: ${topTerms.join(', ')}.`;
    
    codeIndex.discoveredDomain = domain;
    log('discoverDomain: Complete -', domain.description);
    
    return domain;
}

/**
 * Get discovered domain info for planner
 */
function getDomainContext() {
    if (!codeIndex.discoveredDomain) {
        discoverDomain();
    }
    
    const d = codeIndex.discoveredDomain;
    if (!d) return '';
    
    let context = `## Discovered Domain (from attached code)\n`;
    context += `${d.description}\n\n`;
    
    if (d.keyTerms.size > 0) {
        context += `**Key terms in code:** ${Array.from(d.keyTerms.keys()).slice(0, 15).join(', ')}\n`;
    }
    
    if (d.modules.length > 0) {
        context += `**Main modules:** ${d.modules.slice(0, 8).map(m => m.name).join(', ')}\n`;
    }
    
    context += '\n';
    return context;
}

/**
 * Get summary context for high-level queries
 * Returns aggregated summaries suitable for answering overview questions
 */
function getHighLevelContext() {
    let context = '';
    
    // Overall summary
    if (codeIndex.overallSummary) {
        context += `## Codebase Overview\n${codeIndex.overallSummary}\n\n`;
    }
    
    // File statistics
    context += `## Statistics\n`;
    context += `- Files: ${contextFiles.size}\n`;
    context += `- Symbols: ${codeIndex.symbols.size}\n`;
    context += `- Function Summaries: ${codeIndex.summaries.size}\n`;
    context += `- File Summaries: ${codeIndex.fileSummaries.size}\n`;
    context += `- Call Graph Edges: ${Array.from(codeIndex.callGraph.values()).reduce((s, c) => s + c.size, 0)}\n\n`;
    
    // ================================================================
    // Group file summaries by MODULE (2-level hierarchy)
    // e.g., src/backend/access/* -> "backend/access"
    // ================================================================
    const moduleTree = new Map(); // "backend/access" -> { submodules: Map<"brin" -> files[]> }
    
    for (const [filePath, summary] of codeIndex.fileSummaries) {
        const parts = pathUtils.splitPath(filePath);
        const fileName = pathUtils.getFileName(filePath);
        
        // Get module path (2 levels up from file)
        let modulePath, submodule;
        const dirParts = parts.slice(0, -1); // Exclude file name
        if (dirParts.length >= 2) {
            modulePath = dirParts.slice(-3, -1).join('/') || dirParts.slice(-2).join('/');
            submodule = dirParts[dirParts.length - 1];
        } else {
            modulePath = dirParts.join('/') || 'root';
            submodule = 'main';
        }
        
        if (!moduleTree.has(modulePath)) {
            moduleTree.set(modulePath, new Map());
        }
        if (!moduleTree.get(modulePath).has(submodule)) {
            moduleTree.get(modulePath).set(submodule, []);
        }
        moduleTree.get(modulePath).get(submodule).push({ name: fileName, summary });
    }
    
    // Sort modules by total file count
    const sortedModules = Array.from(moduleTree.entries())
        .map(([mod, subs]) => ({
            module: mod,
            submodules: subs,
            totalFiles: Array.from(subs.values()).reduce((sum, files) => sum + files.length, 0)
        }))
        .sort((a, b) => b.totalFiles - a.totalFiles);
    
    context += `## Modules/Components (${sortedModules.length} top-level modules)\n`;
    
    for (const { module, submodules, totalFiles } of sortedModules) {
        context += `\n### ${module}/ (${totalFiles} files)\n`;
        
        // Sort submodules by file count
        const sortedSubs = Array.from(submodules.entries())
            .sort((a, b) => b[1].length - a[1].length);
        
        for (const [subName, files] of sortedSubs.slice(0, 10)) {
            context += `\n**${subName}/** (${files.length} files):\n`;
            
            // Show top files with summaries
            for (const f of files.slice(0, 5)) {
                const shortSummary = f.summary.substring(0, 120).replace(/\n/g, ' ');
                context += `- ${f.name}: ${shortSummary}\n`;
            }
            if (files.length > 5) {
                context += `- ... +${files.length - 5} more files\n`;
            }
        }
        
        if (sortedSubs.length > 10) {
            context += `\n... +${sortedSubs.length - 10} more subdirectories\n`;
        }
    }
    
    // ================================================================
    // Function summaries grouped by module
    // ================================================================
    if (codeIndex.summaries.size > 0) {
        context += `\n## Key Functions (${codeIndex.summaries.size} summarized)\n`;
        
        const funcsByModule = new Map();
        for (const [key, summary] of codeIndex.summaries) {
            const parts = summary.file?.split('/') || [];
            const module = parts.slice(-2, -1)[0] || 'root';
            
            if (!funcsByModule.has(module)) {
                funcsByModule.set(module, []);
            }
            funcsByModule.get(module).push(summary);
        }
        
        // Show top functions per module
        const sortedFuncModules = Array.from(funcsByModule.entries())
            .sort((a, b) => b[1].length - a[1].length);
        
        for (const [module, funcs] of sortedFuncModules.slice(0, 15)) {
            context += `\n**${module}/** (${funcs.length} functions):\n`;
            for (const f of funcs.slice(0, 5)) {
                const shortSummary = f.summary?.substring(0, 80) || '';
                context += `- ${f.name}: ${shortSummary}\n`;
            }
        }
    }
    
    // ================================================================
    // Key entry points (functions with no callers but that call others)
    // ================================================================
    const entryPoints = [];
    for (const [name, symbol] of codeIndex.symbols) {
        if (name.includes('@')) continue;
        if (!codeIndex.reverseCallGraph.has(name) && codeIndex.callGraph.has(name)) {
            const calls = codeIndex.callGraph.get(name)?.size || 0;
            if (calls > 2) { // Only significant entry points
                const summary = codeIndex.summaries.get(`${name}@${symbol.file}`);
                entryPoints.push({
                    name,
                    calls,
                    file: pathUtils.getFileName(symbol.file),
                    module: pathUtils.getParentDirName(symbol.file) || '?',
                    summary: summary?.summary || ''
                });
            }
        }
    }
    entryPoints.sort((a, b) => b.calls - a.calls);
    
    if (entryPoints.length > 0) {
        context += `\n## Entry Points (likely public APIs)\n`;
        for (const ep of entryPoints.slice(0, 25)) {
            context += `- **${ep.name}** (${ep.module}/${ep.file}, calls ${ep.calls}): ${ep.summary.substring(0, 60)}\n`;
        }
    }
    
    // Ensure context fits within limits
    if (context.length > SUMMARY_CONFIG.CONTEXT_WINDOW_LIMIT) {
        log('getHighLevelContext: Truncating from', context.length, 'to', SUMMARY_CONFIG.CONTEXT_WINDOW_LIMIT);
        context = context.substring(0, SUMMARY_CONFIG.CONTEXT_WINDOW_LIMIT) + '\n\n... [summary truncated for context limit]';
    }
    
    return context;
}

/**
 * Handle high-level/overview queries using pre-computed summaries
 */
async function handleHighLevelQuery(query) {
    log('handleHighLevelQuery: Processing overview query');
    
    // Check if we have summaries
    if (codeIndex.summaries.size === 0 && codeIndex.fileSummaries.size === 0) {
        // Generate summaries on-demand if not available
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n📊 *Analyzing codebase structure...*\n`
        });
        
        // Quick structural analysis without full LLM summarization
        return await generateQuickOverview(query);
    }
    
    // Use pre-computed summaries
    const context = getHighLevelContext();
    
    const prompt = `Based on this codebase summary, answer the user's question:

${context}

USER QUESTION: ${query}

Provide a clear, organized answer focusing on the high-level architecture and functionality. Use the summary information provided.`;

    try {
        const response = await callLanguageModel(prompt);
        return response;
    } catch (error) {
        log('handleHighLevelQuery: Error:', error.message);
        return `Error generating overview: ${error.message}`;
    }
}

/**
 * Generate quick overview without pre-computed summaries
 * Builds COMPREHENSIVE hierarchical view of ALL modules
 */
async function generateQuickOverview(query) {
    log('generateQuickOverview: Building comprehensive structural overview');
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `\n📂 *Building comprehensive codebase overview (${contextFiles.size} files)...*\n`
    });
    
    // ================================================================
    // STEP 1: Group files by directory hierarchy (modules)
    // ================================================================
    const moduleTree = new Map(); // path -> { files: [], symbols: [], submodules: Map }
    
    for (const [filePath, file] of contextFiles) {
        // Get directory path (module)
        const fileName = pathUtils.getFileName(filePath);
        const dirPath = pathUtils.getParentDir(filePath) || 'root';
        
        // Get or create module entry
        if (!moduleTree.has(dirPath)) {
            moduleTree.set(dirPath, {
                files: [],
                symbols: [],
                functions: 0,
                types: 0,
                lines: 0
            });
        }
        
        const module = moduleTree.get(dirPath);
        module.files.push(fileName);
        module.lines += file.content.split('\n').length;
        
        // Count symbols in this file
        for (const [key, symbol] of codeIndex.symbols) {
            if (symbol.file === filePath) {
                if (['function', 'procedure', 'method'].includes(symbol.type)) {
                    module.functions++;
                } else if (['struct', 'class', 'type', 'typedef', 'enum'].includes(symbol.type)) {
                    module.types++;
                }
                module.symbols.push(symbol.name);
            }
        }
    }
    
    // ================================================================
    // STEP 2: Build hierarchical module summary
    // ================================================================
    let context = `# Codebase Overview: ${contextFiles.size} files, ${codeIndex.symbols.size} symbols\n\n`;
    
    // Group modules by top-level directory
    const topLevelModules = new Map();
    for (const [dirPath, moduleData] of moduleTree) {
        const topLevel = dirPath.split('/').slice(0, 3).join('/') || dirPath;
        if (!topLevelModules.has(topLevel)) {
            topLevelModules.set(topLevel, {
                submodules: [],
                totalFiles: 0,
                totalFunctions: 0,
                totalTypes: 0,
                totalLines: 0
            });
        }
        const top = topLevelModules.get(topLevel);
        top.submodules.push({ path: dirPath, ...moduleData });
        top.totalFiles += moduleData.files.length;
        top.totalFunctions += moduleData.functions;
        top.totalTypes += moduleData.types;
        top.totalLines += moduleData.lines;
    }
    
    // Sort by file count (largest modules first)
    const sortedModules = Array.from(topLevelModules.entries())
        .sort((a, b) => b[1].totalFiles - a[1].totalFiles);
    
    context += `## Module Structure\n\n`;
    
    for (const [modulePath, moduleData] of sortedModules) {
        const moduleName = modulePath.split('/').pop() || modulePath;
        context += `### ${moduleName}/ (${moduleData.totalFiles} files, ${moduleData.totalFunctions} functions)\n`;
        
        // List submodules with their key functions
        const submodulesSorted = moduleData.submodules.sort((a, b) => b.files.length - a.files.length);
        
        for (const sub of submodulesSorted.slice(0, 15)) { // Top 15 submodules per module
            const subName = sub.path.split('/').pop() || sub.path;
            const keyFuncs = sub.symbols.slice(0, 5).join(', ');
            context += `- **${subName}/**: ${sub.files.length} files, ${sub.functions} funcs`;
            if (keyFuncs) {
                context += ` (${keyFuncs}${sub.symbols.length > 5 ? '...' : ''})`;
            }
            context += `\n`;
        }
        
        if (submodulesSorted.length > 15) {
            context += `- ... and ${submodulesSorted.length - 15} more subdirectories\n`;
        }
        context += `\n`;
    }
    
    // ================================================================
    // STEP 3: Key entry points and most-connected functions
    // ================================================================
    context += `## Key Functions (by connectivity)\n\n`;
    
    const funcConnections = [];
    for (const [name, calls] of codeIndex.callGraph) {
        const callers = codeIndex.reverseCallGraph.get(name)?.size || 0;
        const symbol = codeIndex.symbols.get(name);
        funcConnections.push({ 
            name, 
            calls: calls.size, 
            callers, 
            total: calls.size + callers,
            file: pathUtils.getFileName(symbol?.file) || '?',
            module: pathUtils.getParentDirName(symbol?.file) || '?'
        });
    }
    funcConnections.sort((a, b) => b.total - a.total);
    
    // Group top functions by module
    const topFuncsByModule = new Map();
    for (const f of funcConnections.slice(0, 100)) {
        if (!topFuncsByModule.has(f.module)) {
            topFuncsByModule.set(f.module, []);
        }
        if (topFuncsByModule.get(f.module).length < 5) {
            topFuncsByModule.get(f.module).push(f);
        }
    }
    
    for (const [module, funcs] of topFuncsByModule) {
        context += `**${module}/**:\n`;
        for (const f of funcs) {
            context += `- ${f.name} (${f.file}): calls ${f.calls}, called by ${f.callers}\n`;
        }
        context += `\n`;
    }
    
    // ================================================================
    // STEP 4: Entry points (functions not called by others)
    // ================================================================
    const entryPoints = [];
    for (const [name, symbol] of codeIndex.symbols) {
        if (name.includes('@')) continue;
        if (symbol.type !== 'function') continue;
        if (!codeIndex.reverseCallGraph.has(name) && codeIndex.callGraph.has(name)) {
            const calls = codeIndex.callGraph.get(name)?.size || 0;
            if (calls > 0) { // Only include functions that call others
                entryPoints.push({
                    name,
                    calls,
                    file: pathUtils.getFileName(symbol.file) || '?',
                    module: pathUtils.getParentDirName(symbol.file) || '?'
                });
            }
        }
    }
    entryPoints.sort((a, b) => b.calls - a.calls);
    
    if (entryPoints.length > 0) {
        context += `## Likely Entry Points (functions not called by others)\n\n`;
        for (const ep of entryPoints.slice(0, 30)) {
            context += `- **${ep.name}** (${ep.module}/${ep.file}): calls ${ep.calls} functions\n`;
        }
        context += `\n`;
    }
    
    // ================================================================
    // STEP 5: Data structures (structs, types, enums)
    // ================================================================
    const dataStructures = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (key.includes('@')) continue;
        if (['struct', 'class', 'type', 'typedef', 'enum'].includes(symbol.type)) {
            dataStructures.push({
                name: symbol.name,
                type: symbol.type,
                file: pathUtils.getFileName(symbol.file) || '?',
                module: pathUtils.getParentDirName(symbol.file) || '?'
            });
        }
    }
    
    if (dataStructures.length > 0) {
        context += `## Key Data Structures (${dataStructures.length} total)\n\n`;
        
        // Group by module
        const structsByModule = new Map();
        for (const ds of dataStructures) {
            if (!structsByModule.has(ds.module)) {
                structsByModule.set(ds.module, []);
            }
            structsByModule.get(ds.module).push(ds);
        }
        
        for (const [module, structs] of Array.from(structsByModule.entries()).slice(0, 20)) {
            context += `**${module}/**: ${structs.slice(0, 8).map(s => s.name).join(', ')}`;
            if (structs.length > 8) context += ` (+${structs.length - 8} more)`;
            context += `\n`;
        }
        context += `\n`;
    }
    
    // ================================================================
    // STEP 6: Language breakdown
    // ================================================================
    const byLanguage = new Map();
    for (const [path, file] of contextFiles) {
        const lang = file.language || 'unknown';
        if (!byLanguage.has(lang)) byLanguage.set(lang, 0);
        byLanguage.set(lang, byLanguage.get(lang) + 1);
    }
    
    context += `## Language Breakdown\n\n`;
    for (const [lang, count] of Array.from(byLanguage.entries()).sort((a, b) => b[1] - a[1])) {
        context += `- **${lang}**: ${count} files\n`;
    }
    
    // Limit context size but keep it comprehensive
    if (context.length > SUMMARY_CONFIG.CONTEXT_WINDOW_LIMIT) {
        context = context.substring(0, SUMMARY_CONFIG.CONTEXT_WINDOW_LIMIT) + '\n\n... [truncated for context limit]';
    }
    
    log('generateQuickOverview: Built context of', context.length, 'chars');
    
    // ================================================================
    // STEP 7: Send to LLM for final synthesis
    // ================================================================
    const prompt = `You are analyzing a large codebase. Based on this comprehensive structural analysis, provide a HIGH-LEVEL OVERVIEW.

${context}

USER QUESTION: ${query}

Provide a well-organized answer that:
1. Describes the OVERALL PURPOSE of this codebase
2. Lists the MAJOR MODULES/COMPONENTS and their responsibilities
3. Identifies KEY ARCHITECTURAL PATTERNS
4. Notes important ENTRY POINTS and how components interact
5. Highlights any interesting DESIGN DECISIONS evident from the structure

Be comprehensive - this is a summary of the ENTIRE codebase, not just one part.`;

    return await callLanguageModel(prompt);
}

/**
 * Handle detailed queries using search + chunking
 */
/**
 * Check if an LLM response is actually an error message
 * Returns true if the response looks like an error template
 */
function isLlmErrorResponse(response) {
    if (!response) return false;
    const trimmed = response.trim();
    return (
        trimmed.includes('Fix Option 1:') ||
        trimmed.includes('Fix Option 2:') ||
        trimmed.startsWith('**Language Model not available') ||
        trimmed.startsWith('**Cannot generate') ||
        trimmed.startsWith('❌ GitHub Copilot') ||
        trimmed.includes('LLM unavailable')
    );
}

async function handleDetailedQuery(query) {
    
    debugLog('SEARCH', `handleDetailedQuery started`, {
        query: query.substring(0, 100),
        totalFiles: contextFiles.size
    });
    
    // VERBOSE: Show which code path we're in
    if (AGENT_CONFIG.verboseSearch) {
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n**🔧 Debug: Using handleDetailedQuery (large codebase path)**\n**Query:** ${query.substring(0, 100)}...\n\n`
        });
    }
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `\n🔍 *Searching codebase...*\n`
    });
    
    // Step 1: Search for relevant code using all available methods
    const searchResults = await comprehensiveSearch(query);
    
    
    debugLog('SEARCH', `comprehensiveSearch completed`, {
        resultsFound: searchResults.length,
        topResults: searchResults.slice(0, 5).map(r => ({
            name: r.name,
            file: pathUtils.getFileName(r.file),
            score: r.score?.toFixed(2),
            source: r.source,
            hasContent: !!r.content
        }))
    });
    
    if (searchResults.length === 0) {
        debugLog('SEARCH', 'No results found');
        return `No relevant code found for: "${query}". Try rephrasing or check if the functionality exists in the attached files.`;
    }
    
    // ================================================================
    // Step 1.5: LOAD ACTUAL SOURCE CODE CONTENT (CRITICAL FIX)
    // Search results often have content: null - we must load actual code
    // before analysis, otherwise LLM only sees metadata (file names, line numbers)
    // ================================================================
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `📂 *Loading source code for ${searchResults.length} matches...*\n`
    });
    
    let contentLoadedCount = 0;
    let contentAlreadyHadCount = 0;
    let contentFailedCount = 0;
    
    // Group results by file to avoid loading same file multiple times
    const resultsByFile = new Map();
    for (const result of searchResults) {
        if (!result.file) continue;
        if (!resultsByFile.has(result.file)) {
            resultsByFile.set(result.file, []);
        }
        resultsByFile.get(result.file).push(result);
    }
    
    debugLog('SEARCH', `Loading content for ${resultsByFile.size} unique files`);
    
    for (const [filePath, fileResults] of resultsByFile) {
        // Get the file content from contextFiles
        let fileContent = null;
        const file = contextFiles.get(filePath);
        
        if (file?.content) {
            fileContent = file.content;
        } else {
            // Try to find by filename match (in case paths differ slightly)
            const fileName = pathUtils.getFileName(filePath);
            for (const [ctxPath, ctxFile] of contextFiles) {
                if (pathUtils.getFileName(ctxPath) === fileName) {
                    fileContent = ctxFile.content;
                    break;
                }
            }
        }
        
        if (!fileContent) {
            contentFailedCount += fileResults.length;
            debugLog('SEARCH', `Could not find content for: ${pathUtils.getFileName(filePath)}`);
            continue;
        }
        
        // Load content for each result in this file
        for (const result of fileResults) {
            if (!result.content) {
                // Extract context around the result's line
                // Use larger context (40 lines) to capture function bodies
                result.content = extractCodeContext(fileContent, result.line || 1, 40);
                contentLoadedCount++;
            } else {
                contentAlreadyHadCount++;
            }
        }
    }
    
    debugLog('SEARCH', `Content loading complete`, {
        loaded: contentLoadedCount,
        alreadyHad: contentAlreadyHadCount,
        failed: contentFailedCount,
        total: searchResults.length
    });
    
    
    // Filter out results that still have no content
    const resultsWithContent = searchResults.filter(r => r.content && r.content.length > 0);
    
    
    if (resultsWithContent.length === 0) {
        debugLog('SEARCH', 'No results with content after loading');
        return `Found ${searchResults.length} code references but couldn't load their content. Please ensure files are properly added to context.`;
    }
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `✓ Loaded content for ${contentLoadedCount} code sections\n`
    });
    
    // ================================================================
    // Extract high-priority files (filename matches get score >= 1.4)
    // ================================================================
    const highPriorityFiles = [...new Set(
        resultsWithContent
            .filter(r => r.score >= 1.4 && r.source?.includes('filename'))
            .map(r => pathUtils.getFileName(r.file))
            .filter(Boolean)
    )];
    
    // Extract all analyzed files (deduped)
    const allFilesAnalyzed = [...new Set(resultsWithContent.map(r => pathUtils.getFileName(r.file)).filter(Boolean))];
    
    debugLog('SEARCH', `File analysis`, {
        highPriorityFiles,
        allFilesCount: allFilesAnalyzed.length,
        allFiles: allFilesAnalyzed.slice(0, 10)
    });
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `Found ${resultsWithContent.length} relevant code sections in ${allFilesAnalyzed.length} files...\n`
    });
    
    // ================================================================
    // Step 2: Chunk the results to fit context window
    // ================================================================
    const chunks = chunkSearchResults(resultsWithContent, SUMMARY_CONFIG.CHUNK_SIZE_FOR_QUERY);
    
    debugLog('SEARCH', `Chunking results`, {
        totalChunks: chunks.length,
        chunkSizes: chunks.map(c => c.length),
        totalContentSize: resultsWithContent.reduce((sum, r) => sum + (r.content?.length || 0), 0)
    });
    
    // Limit chunks to prevent overwhelming the system
    const MAX_CHUNKS = AGENT_CONFIG.maxChunks || 8;
    const chunksToProcess = chunks.slice(0, MAX_CHUNKS);
    
    if (chunks.length > MAX_CHUNKS) {
        debugLog('SEARCH', `Limiting chunks: ${chunks.length} → ${MAX_CHUNKS}`);
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*Note: Processing top ${MAX_CHUNKS} of ${chunks.length} relevant chunks for efficiency*\n`
        });
    }
    
    // ================================================================
    // Step 3: Analyze each chunk
    // ================================================================
    const chunkAnalyses = [];
    
    for (let i = 0; i < chunksToProcess.length; i++) {
        if (taskController.isCancelled) {
            throw new Error('Query cancelled by user');
        }
        
        // Show what files are in this chunk
        const chunkFiles = [...new Set(chunksToProcess[i].map(r => pathUtils.getFileName(r.file)))];
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n📖 *Analyzing chunk ${i + 1}/${chunksToProcess.length} (${chunkFiles.slice(0, 3).join(', ')}${chunkFiles.length > 3 ? '...' : ''})...*\n`
        });
        
        const analysis = await analyzeChunk(query, chunksToProcess[i], i + 1, chunksToProcess.length);
        if (analysis) {
            chunkAnalyses.push(analysis);
        }
    }
    
    debugLog('SEARCH', `Chunk analysis complete`, {
        chunksAnalyzed: chunkAnalyses.length,
        chunksProcessed: chunksToProcess.length
    });
    
    // ================================================================
    // Step 4: Synthesize final answer
    // ================================================================
    if (chunkAnalyses.length === 0) {
        return `Found code but couldn't analyze it. The code may be too complex or the LLM is unavailable.`;
    }
    
    // Always synthesize to get structured format, even for single chunk
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `\n🧩 *Synthesizing results from ${chunkAnalyses.length} analyses...*\n`
    });
    
    return await synthesizeChunkAnalyses(query, chunkAnalyses, highPriorityFiles, allFilesAnalyzed);
}

/**
 * Comprehensive search using all available methods
 * Priority: 1) File name matches, 2) Symbol name matches, 3) Grep, 4) Vector
 * 
 * v5.2: Query-type-based score boosting
 */
async function comprehensiveSearch(query) {
    const results = new Map(); // Use map to dedupe by file:line
    
    // Extract keywords for search
    const keywords = extractSearchKeywords(query);
    
    // ================================================================
    // QUERY TYPE CLASSIFICATION & SCORE BOOSTS (v5.2)
    // ================================================================
    let queryType = 'general';
    let qc = null;
    let cobolContext = null;
    
    // Standard query classification
    if (queryClassifier) {
        qc = queryClassifier.classify(query);
        queryType = qc?.type || 'general';
    }
    
    // COBOL-specific classification (if COBOL codebase)
    if (cobolClassifier && cobolClassifier.initialized) {
        const cobolQuery = cobolClassifier.classify(query);
        
        // Handle LIST_TABLES_IN_MODULE - instant lookup from index
        if (cobolQuery.intent === 'LIST_TABLES_IN_MODULE' && cobolQuery.extractedNames.length > 0) {
            const moduleName = cobolQuery.extractedNames[0];
            log('COBOL: Getting tables for module:', moduleName, '(from pre-built index)');
            
            // Instant lookup - NO FILE SCANNING
            const tableResult = cobolClassifier.getTablesInModule(moduleName);
            
            log('COBOL: Found', tableResult.cobolTables.length, 'COBOL tables,', 
                tableResult.sqlTables.length, 'SQL tables in', tableResult.matchedFiles.length, 'files');
            
            // Add COBOL tables to results
            for (const table of tableResult.cobolTables) {
                const key = `${table.file}:${table.line}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: table.file,
                        line: table.line,
                        name: table.name,
                        type: 'cobol-table',
                        score: 3.0,
                        source: 'cobol-table-index',
                        content: `OCCURS ${table.maxOccurs} TIMES${table.indexes.length > 0 ? ' INDEXED BY ' + table.indexes.join(', ') : ''}`
                    });
                }
            }
            
            // Add SQL tables to results
            for (const table of tableResult.sqlTables) {
                const key = `${table.file}:sql:${table.name}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: table.file,
                        line: table.line,
                        name: table.name,
                        type: 'sql-table',
                        score: 2.8,
                        source: 'cobol-sql-index',
                        content: `SQL Table - Operations: ${table.operations.join(', ')}`
                    });
                }
            }
        }
        
        // Handle LIST_ALL_TABLES - instant lookup from index
        if (cobolQuery.intent === 'LIST_ALL_TABLES') {
            log('COBOL: Getting ALL tables (from pre-built index)');
            
            // Instant lookup - NO FILE SCANNING
            const allTables = cobolClassifier.getAllTables();
            
            log('COBOL: Found', allTables.summary.cobolTableCount, 'COBOL tables,',
                allTables.summary.sqlTableCount, 'SQL tables total');
            
            for (const table of allTables.cobolTables) {
                const key = `${table.file}:${table.line}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: table.file,
                        line: table.line,
                        name: table.name,
                        type: 'cobol-table',
                        score: 2.5,
                        source: 'cobol-table-index',
                        content: `OCCURS ${table.maxOccurs} TIMES`
                    });
                }
            }
        }
        
        // Handle LIST_SQL_TABLES - instant lookup from index
        if (cobolQuery.intent === 'LIST_SQL_TABLES') {
            log('COBOL: Getting SQL tables (from pre-built index)');
            
            // Instant lookup - NO FILE SCANNING
            const allTables = cobolClassifier.getAllTables();
            
            for (const table of allTables.sqlTables) {
                const key = `${table.file}:sql:${table.name}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: table.file,
                        line: table.line,
                        name: table.name,
                        type: 'sql-table',
                        score: 2.3,
                        source: 'cobol-sql-index',
                        content: `SQL: ${table.operations.join(', ')}`
                    });
                }
            }
        }
    }
    
    // Score boosts by query type (higher = more important for this query)
    const BOOSTS = {
        'concept':       { sum: 2.5, sym: 1.2, tri: 0.5, file: 1.0 },
        'structure':     { sum: 0.5, sym: 3.0, tri: 1.5, file: 0.8 },
        'call_graph':    { sum: 0.8, sym: 2.5, tri: 0.8, file: 0.5 },
        'implementation':{ sum: 2.0, sym: 2.5, tri: 1.5, file: 1.2 },
        'flow':          { sum: 2.0, sym: 1.5, tri: 0.8, file: 1.0 },
        'files_trace':   { sum: 1.5, sym: 1.0, tri: 0.8, file: 3.0 },
        'cross_module':  { sum: 1.0, sym: 2.0, tri: 0.5, file: 1.5 },
        'general':       { sum: 1.5, sym: 1.2, tri: 1.5, file: 1.0 }
    };
    
    const b = BOOSTS[queryType] || BOOSTS['general'];
    
    debugLog('SEARCH', 'comprehensiveSearch starting', {
        query: query.substring(0, 80),
        keywords,
        queryType,
        boosts: b,
        totalFiles: contextFiles.size,
        indexedSymbols: codeIndex.symbols.size
    });
    
    // File filter - skip non-code files
    const SKIP_FILE_PATTERNS = [
        /\.po$/i, /\.pot$/i,           // Translation files
        /\.md$/i, /\.txt$/i,           // Documentation
        /README/i, /LICENSE/i,         // Meta files
        /\.json$/i, /\.yaml$/i, /\.yml$/i,  // Config (unless specifically asked)
        /Makefile$/i, /CMakeLists/i,   // Build files
        /\.css$/i, /\.scss$/i,         // Stylesheets
    ];
    
    const shouldSkipFile = (filePath) => {
        if (!filePath) return true;
        // Don't skip if keyword matches filename
        const fileName = pathUtils.getFileName(filePath).toLowerCase();
        for (const kw of keywords) {
            if (fileName.includes(kw.toLowerCase())) return false;
        }
        return SKIP_FILE_PATTERNS.some(p => p.test(filePath));
    };

    if (cobolClassifier && cobolClassifier.initialized) {
        const cobolQuery = cobolClassifier.classify(query);
        
        if (cobolQuery.intent === 'LIST_TABLES_IN_MODULE' && cobolQuery.extractedNames.length > 0) {
            log('COBOL: Handling table query for module:', cobolQuery.extractedNames[0]);
            
            const tableResult = handleTableQuery(
                cobolQuery.extractedNames[0], 
                contextFiles,
                { log }
            );
            
            // Add table results as search results
            for (const table of tableResult.cobolTables) {
                const key = `${table.file}:${table.line}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: table.file,
                        line: table.line,
                        name: table.name,
                        type: 'cobol-table',
                        score: 3.0,  // High score for direct matches
                        source: 'cobol-table-search',
                        content: `OCCURS ${table.maxOccurs} TIMES${table.indexes.length > 0 ? ' INDEXED BY ' + table.indexes.join(', ') : ''}`
                    });
                }
            }
            
            for (const table of tableResult.sqlTables) {
                // Find a file that references this table
                const key = `${table.file}:${table.lines[0] || 1}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: table.file,
                        line: table.lines[0] || 1,
                        name: table.name,
                        type: 'sql-table',
                        score: 2.8,
                        source: 'cobol-sql-table-search',
                        content: `SQL Table - Operations: ${table.operations.join(', ')}`
                    });
                }
            }
            
            log('COBOL: Added', tableResult.cobolTables.length, 'COBOL tables and', 
                tableResult.sqlTables.length, 'SQL tables to results');
        }
        
        // Handle LIST_ALL_TABLES intent
        if (cobolQuery.intent === 'LIST_ALL_TABLES' || cobolQuery.intent === 'LIST_SQL_TABLES') {
            log('COBOL: Handling list all tables query');
            
            // Search all COBOL files for tables
            for (const [filePath, file] of contextFiles) {
                if (!/\.(cbl|cob|cobol|cpy)$/i.test(filePath)) continue;
                
                const content = file.content || '';
                
                if (cobolQuery.intent === 'LIST_ALL_TABLES') {
                    const tables = extractCobolTables(content);
                    for (const table of tables) {
                        const key = `${filePath}:${table.line}`;
                        if (!results.has(key)) {
                            results.set(key, {
                                file: filePath,
                                line: table.line,
                                name: table.name,
                                type: 'cobol-table',
                                score: 2.5,
                                source: 'cobol-table-scan',
                                content: `OCCURS ${table.maxOccurs} TIMES`
                            });
                        }
                    }
                }
                
                // SQL tables
                const sqlTables = extractSqlTables(content);
                for (const table of sqlTables) {
                    const key = `${filePath}:sql:${table.name}`;
                    if (!results.has(key)) {
                        results.set(key, {
                            file: filePath,
                            line: table.lines[0] || 1,
                            name: table.name,
                            type: 'sql-table',
                            score: 2.3,
                            source: 'cobol-sql-scan',
                            content: `SQL: ${table.operations.join(', ')}`
                        });
                    }
                }
            }
        }
    }

    // ================================================================
    // PHASE 0: INVERTED INDEX / CONCEPT SEARCH (Highest Priority)
    // Best for concept queries like "nested loops", "payment validation"
    // BOOSTED for: concept (2.5x), flow (2.0x), implementation (2.0x)
    // ================================================================
    const invertedBefore = results.size;
    if (typeof searchModule.searchConcept === 'function') {
        try {
            // Search summaries and content for concepts
            const conceptResults = searchModule.searchConcept(query, { maxResults: 30 });
            for (const r of conceptResults) {
                const file = r.file || r.path;
                if (!file || shouldSkipFile(file)) continue;
                
                const key = `${file}:${r.line || 1}`;
                if (!results.has(key)) {
                    const baseScore = 2.0 + (r.score || 0) * 0.3;
                    results.set(key, {
                        file: file,
                        line: r.line || 1,
                        name: r.name || pathUtils.getFileName(file),
                        type: r.type || 'concept',
                        score: baseScore * b.sum,  // Apply summary boost
                        source: 'inverted-concept',
                        matchedTerms: r.matchedTerms,
                        content: null
                    });
                }
            }
            
            // Also try keyword search on content
            const keywordResults = searchModule.searchByKeyword ? 
                searchModule.searchByKeyword(query, { maxResults: 20 }) : [];
            for (const r of keywordResults) {
                const file = r.path || r.file;
                if (!file || shouldSkipFile(file)) continue;
                
                const key = `${file}:${r.line || 1}`;
                if (!results.has(key)) {
                    const baseScore = 1.8 + (r.score || 0) * 0.2;
                    results.set(key, {
                        file: file,
                        line: r.line || 1,
                        name: r.name || pathUtils.getFileName(file),
                        type: 'keyword',
                        score: baseScore * b.sum * 0.9,  // Apply summary boost
                        source: 'inverted-keyword',
                        matchedTerms: r.matchedTerms,
                        content: null
                    });
                }
            }
            
            debugLog('SEARCH', `Phase 0: Inverted index complete`, {
                summaryBoost: b.sum,
                newMatches: results.size - invertedBefore,
                resultsAfterPhase0: results.size
            });
        } catch (e) {
            log('comprehensiveSearch: Inverted index error:', e.message);
        }
    }

    // ================================================================
    // PHASE 1: FILE NAME AND DIRECTORY MATCHING (High Priority)
    // For "show files related to X", directory matches are most important
    // Uses QueryClassifier for dynamic term expansion (no hardcoding!)
    // BOOSTED for: files_trace (3.0x)
    // ================================================================
    let filenameMatches = 0;
    const filenameBefore = results.size;
    
    // Use query classifier for intelligent term expansion
    // This dynamically learns module mappings from the codebase structure
    let queryClassification = qc;  // Use qc from above
    const expandedKeywords = new Set();
    
    if (queryClassifier && queryClassifier.isLearned) {
        // Classify the query to get expanded terms and module hints
        queryClassification = queryClassifier.classify(query);
        
        debugLog('SEARCH', 'Query classified', {
            type: queryClassification.type,
            entities: queryClassification.entities,
            expandedTerms: queryClassification.expandedTerms?.slice(0, 5),
            moduleHints: queryClassification.moduleHints
        });
        
        // Use expanded terms from classifier (includes learned synonyms)
        for (const term of queryClassification.expandedTerms || []) {
            expandedKeywords.add(term.toLowerCase());
        }
        // Add COBOL-specific expanded terms
        if (cobolContext && cobolContext.expandedTerms) {
            for (const term of cobolContext.expandedTerms) {
                expandedKeywords.add(term.toLowerCase());
            }
            // Also add COBOL boost terms
            for (const term of cobolContext.searchBoost || []) {
                expandedKeywords.add(term.toLowerCase());
            }
        }

        
        // Also add original keywords
        for (const kw of keywords) {
            expandedKeywords.add(kw.toLowerCase());
        }
        
        // For FILES_TRACE queries, prioritize getting related files directly
        if (queryClassification.type === QueryTypes.FILES_TRACE && queryClassification.entities.length > 0) {
            for (const entity of queryClassification.entities) {
                const relatedFiles = queryClassifier.getRelatedFiles(entity, contextFiles);
                for (const rf of relatedFiles) {
                    const key = `${rf.path}:1`;
                    if (!results.has(key)) {
                        results.set(key, {
                            file: rf.path,
                            line: 1,
                            name: pathUtils.getFileName(rf.path),
                            type: 'module-file',
                            score: (rf.score + 1.5) * b.file,  // Apply file boost
                            source: `classifier-${rf.reason}`,
                            content: null
                        });
                    }
                }
            }
        }
    } else {
        // Fallback: just use original keywords
        for (const kw of keywords) {
            expandedKeywords.add(kw.toLowerCase());
        }
    }
    
    for (const keyword of expandedKeywords) {
        if (keyword.length < 2) continue;
        const keywordLower = keyword.toLowerCase();
        
        for (const [filePath, file] of contextFiles) {
            if (shouldSkipFile(filePath)) continue;
            
            const fileName = pathUtils.getFileName(filePath).toLowerCase();
            const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
            const filePathLower = filePath.toLowerCase();
            
            // Check for directory/module match (HIGHEST priority)
            // e.g., "btree" matches files in "/nbtree/" or "/btree/" directories
            const dirParts = filePathLower.split('/');
            const isInMatchingDir = dirParts.some(part => 
                part.includes(keywordLower) || 
                (part.length >= 3 && keywordLower.includes(part)) ||
                // Also match "nbtree" for "btree" search
                (keywordLower.length >= 3 && part.includes(keywordLower.substring(0, keywordLower.length - 1)))
            );
            
            // Check filename match
            const keywordInFile = fileNameNoExt.includes(keywordLower) || fileName.includes(keywordLower);
            const fileInKeyword = keywordLower.length >= 4 && keywordLower.includes(fileNameNoExt.substring(0, Math.min(4, fileNameNoExt.length)));
            const commonPrefix = fileNameNoExt.length >= 4 && keywordLower.length >= 4 && 
                                fileNameNoExt.substring(0, 4) === keywordLower.substring(0, 4);
            
            // Score based on match type - apply file boost
            let matchScore = 0;
            let matchSource = 'filename-match';
            
            if (isInMatchingDir) {
                // Directory match - HIGHEST priority
                matchScore = (keywordInFile ? 1.8 : 1.6) * b.file;
                matchSource = 'directory-match';
            } else if (keywordInFile) {
                // Exact filename match
                matchScore = 1.5 * b.file;
            } else if (fileInKeyword || commonPrefix) {
                // Partial filename match
                matchScore = 1.4 * b.file;
            }
            
            if (matchScore > 0) {
                let addedFromFile = 0;
                for (const [symKey, symbol] of codeIndex.symbols) {
                    if (symbol.file === filePath && !symKey.includes('@')) {
                        const key = `${symbol.file}:${symbol.line}`;
                        if (!results.has(key)) {
                            results.set(key, {
                                file: symbol.file,
                                line: symbol.line,
                                name: symbol.name,
                                type: symbol.type,
                                score: matchScore,
                                source: matchSource,
                                content: null
                            });
                            addedFromFile++;
                        }
                    }

                    if (cobolContext && cobolContext.extractedNames.length > 0) {
                        const symbolUpper = symbol.name.toUpperCase();
                        for (const cobolName of cobolContext.extractedNames) {
                            if (symbolUpper === cobolName || symbolUpper.includes(cobolName)) {
                                score *= 1.5;  // Boost exact COBOL name matches
                                break;
                            }
                        }
                    }
                }
                
                // Also add the file itself as a result
                if (addedFromFile === 0 || matchScore >= 1.6) {
                    const key = `${filePath}:1`;
                    if (!results.has(key)) {
                        results.set(key, {
                            file: filePath,
                            line: 1,
                            name: fileName,
                            type: 'file',
                            score: matchScore - 0.1,  // Slightly lower than symbols
                            source: matchSource,
                            content: extractCodeContext(file.content, 1, 50)
                        });
                    }
                }
                
                filenameMatches++;
            }
        }
    }
    
    debugLog('SEARCH', `Phase 1: Filename/directory matching complete`, {
        filenameMatches,
        newMatches: results.size - filenameBefore,
        resultsAfterPhase1: results.size
    });

    // ================================================================
    // PHASE 2: SYMBOL NAME SEARCH (Exact and Partial only - NO FUZZY)
    // BOOSTED for: structure (3.0x), call_graph (2.5x), implementation (2.5x)
    // ================================================================
    const symbolMatchesBefore = results.size;
    for (const keyword of keywords) {
        const keywordLower = keyword.toLowerCase();
        
        for (const [symKey, symbol] of codeIndex.symbols) {
            if (symKey.includes('@')) continue;
            if (shouldSkipFile(symbol.file)) continue;
            
            const symNameLower = symbol.name.toLowerCase();
            const key = `${symbol.file}:${symbol.line}`;
            
            if (results.has(key)) continue;
            
            // Exact match - apply symbol boost
            if (symNameLower === keywordLower) {
                results.set(key, {
                    file: symbol.file,
                    line: symbol.line,
                    name: symbol.name,
                    type: symbol.type,
                    score: 1.3 * b.sym,
                    source: 'symbol-exact',
                    content: null
                });
            } 
            // Partial match (keyword in symbol name) - apply symbol boost
            else if (symNameLower.includes(keywordLower) && keywordLower.length >= 3) {
                results.set(key, {
                    file: symbol.file,
                    line: symbol.line,
                    name: symbol.name,
                    type: symbol.type,
                    score: 1.0 * b.sym,
                    source: 'symbol-partial',
                    content: null
                });
            }
        }
    }
    
    debugLog('SEARCH', `Phase 2: Symbol exact/partial complete`, {
        symbolBoost: b.sym,
        newMatches: results.size - symbolMatchesBefore,
        resultsAfterPhase2: results.size
    });

    // ================================================================
    // PHASE 3: TRIGRAM SEARCH
    // BOOSTED for: structure (1.5x), implementation (1.5x), general (1.5x)
    // ================================================================
    const trigramMatchesBefore = results.size;
    if (trigramIndex && trigramIndex.index && trigramIndex.index.size > 0) {
        for (const keyword of keywords.slice(0, 3)) {
            if (keyword.length < 3) continue;
            try {
                const trigramResults = searchTrigramIndex(keyword, { maxResults: 15 });
                for (const tr of trigramResults) {
                    if (shouldSkipFile(tr.file)) continue;
                    
                    const key = `${tr.file}:${tr.line}`;
                    if (!results.has(key)) {
                        results.set(key, {
                            file: tr.file,
                            line: tr.line,
                            name: tr.context?.split('\n')[0]?.substring(0, 50) || keyword,
                            type: 'trigram',
                            score: 0.8 * b.tri,
                            source: 'trigram',
                            content: tr.context
                        });
                    }
                }
            } catch (e) {
                log('comprehensiveSearch: Trigram error:', e.message);
            }
        }
    }
    
    debugLog('SEARCH', `Phase 3: Trigram search complete`, {
        trigramBoost: b.tri,
        trigramIndexSize: trigramIndex?.index?.size || 0,
        newMatches: results.size - trigramMatchesBefore,
        resultsAfterPhase3: results.size
    });

    // ================================================================
    // PHASE 4: GREP SEARCH (fallback text search)
    // ================================================================
    const grepMatchesBefore = results.size;
    for (const keyword of keywords.slice(0, 3)) {
        try {
            const grepResults = await AGENT_TOOLS.grep_context.execute({ 
                pattern: keyword, 
                contextLines: 10 
            });
            
            if (grepResults.success && grepResults.data?.results) {
                for (const match of grepResults.data.results) {
                    const file = findFileByName(match.fileName);
                    if (file && !shouldSkipFile(file.path)) {
                        const key = `${file.path}:${match.startLine}`;
                        if (!results.has(key)) {
                            results.set(key, {
                                file: file.path,
                                line: match.startLine,
                                name: match.fileName,
                                type: 'grep',
                                score: 0.6,
                                source: 'grep',
                                content: match.content
                            });
                        }
                    }
                }
            }
        } catch (e) {
            log('comprehensiveSearch: Grep error:', e.message);
        }
    }
    
    debugLog('SEARCH', `Phase 4: Grep search complete`, {
        newMatches: results.size - grepMatchesBefore,
        resultsAfterPhase4: results.size
    });

    // ================================================================
    // PHASE 5: VECTOR SEARCH (semantic similarity)
    // ================================================================
    const vectorMatchesBefore = results.size;
    if (vectorIndex && vectorIndex.chunks && vectorIndex.chunks.length > 0) {
        try {
            const vectorResults = await hybridSearch(query, { maxResults: 20 });
            for (const vr of vectorResults) {
                if (shouldSkipFile(vr.file)) continue;
                
                const key = `${vr.file}:${vr.line}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: vr.file,
                        line: vr.line,
                        name: vr.symbol || vr.fileName,
                        type: 'vector',
                        score: vr.score || 0.5,
                        source: 'vector',
                        content: vr.preview
                    });
                }
            }
        } catch (e) {
            log('comprehensiveSearch: Vector search error:', e.message);
        }
    }
    
    debugLog('SEARCH', `Phase 5: Vector search complete`, {
        vectorIndexSize: vectorIndex?.chunks?.length || 0,
        newMatches: results.size - vectorMatchesBefore,
        resultsAfterPhase5: results.size
    });

    // ================================================================
    // PHASE 6: CALL GRAPH TRAVERSAL (for trace queries)
    // ================================================================
    if (/trace|flow|call|calls|calling|invokes?/i.test(query)) {
        const callGraphBefore = results.size;
        for (const keyword of keywords) {
            const symbol = codeIndex.symbols.get(keyword);
            if (symbol && codeIndex.callGraph.has(keyword)) {
                const calls = codeIndex.callGraph.get(keyword);
                for (const called of calls) {
                    const calledSymbol = codeIndex.symbols.get(called);
                    if (calledSymbol && !shouldSkipFile(calledSymbol.file)) {
                        const key = `${calledSymbol.file}:${calledSymbol.line}`;
                        if (!results.has(key)) {
                            results.set(key, {
                                file: calledSymbol.file,
                                line: calledSymbol.line,
                                name: called,
                                type: 'callgraph',
                                score: 0.7,
                                source: 'callgraph',
                                content: null
                            });
                        }
                    }
                }
                
                const callers = codeIndex.reverseCallGraph.get(keyword);
                if (callers) {
                    for (const caller of callers) {
                        const callerSymbol = codeIndex.symbols.get(caller);
                        if (callerSymbol && !shouldSkipFile(callerSymbol.file)) {
                            const key = `${callerSymbol.file}:${callerSymbol.line}`;
                            if (!results.has(key)) {
                                results.set(key, {
                                    file: callerSymbol.file,
                                    line: callerSymbol.line,
                                    name: caller,
                                    type: 'callgraph',
                                    score: 0.7,
                                    source: 'callgraph',
                                    content: null
                                });
                            }
                        }
                    }
                }
            }
        }
        debugLog('SEARCH', `Phase 6: Call graph complete`, {
            newMatches: results.size - callGraphBefore
        });
    }

    // ================================================================
    // PHASE 7: FUZZY SEARCH (LAST RESORT - only if < 5 results)
    // ================================================================
    const MIN_RESULTS_BEFORE_FUZZY = 5;
    
    if (results.size < MIN_RESULTS_BEFORE_FUZZY) {
        debugLog('SEARCH', `Phase 7: Running fuzzy search (only ${results.size} results so far)`);
        
        const fuzzyMatchesBefore = results.size;
        for (const keyword of keywords) {
            if (keyword.length < 3) continue;
            
            const symbolResults = fuzzySearchSymbols(keyword, null, 50, 20);  // minScore=50
            for (const symbol of symbolResults) {
                if (shouldSkipFile(symbol.file)) continue;
                
                const key = `${symbol.file}:${symbol.line}`;
                if (!results.has(key)) {
                    // NORMALIZE SCORE: divide by 100 and cap at 0.4
                    const normalizedScore = Math.min((symbol.matchScore || 50) / 100 * 0.5, 0.4);
                    
                    results.set(key, {
                        file: symbol.file,
                        line: symbol.line,
                        name: symbol.name,
                        type: symbol.type,
                        score: normalizedScore,  // 0.0 - 0.4 range
                        source: 'symbol-fuzzy',
                        content: null
                    });
                }
            }
            
            // Stop fuzzy if we have enough results now
            if (results.size >= 20) break;
        }
        
        debugLog('SEARCH', `Phase 7: Fuzzy search complete`, {
            newMatches: results.size - fuzzyMatchesBefore,
            resultsAfterPhase7: results.size
        });
    } else {
        debugLog('SEARCH', `Phase 7: Skipping fuzzy search (have ${results.size} good results)`);
    }

    // ================================================================
    // FINAL: Sort by score and return
    // ================================================================
    const sortedResults = Array.from(results.values())
        .sort((a, b) => b.score - a.score);
    
    // Debug output
    if (Config?.general?.verboseDebug) {
        let verboseOutput = '\n**🔎 comprehensiveSearch Results:**\n\n';
        verboseOutput += `Keywords: ${keywords.join(', ')}\n\n`;
        verboseOutput += '| Source | Count | Top Matches |\n|:-------|:------|:------------|\n';
        
        const bySrc = {};
        for (const r of sortedResults) {
            if (!bySrc[r.source]) bySrc[r.source] = [];
            bySrc[r.source].push(r.name);
        }
        for (const [src, names] of Object.entries(bySrc)) {
            verboseOutput += `| ${src} | ${names.length} | ${names.slice(0, 5).join(', ')}... |\n`;
        }
        
        verboseOutput += '\nTop 10 Results:\n';
        for (const r of sortedResults.slice(0, 10)) {
            verboseOutput += `- ${r.name} (${r.type}) in ${pathUtils.getFileName(r.file)}:${r.line} [score=${r.score.toFixed(2)}, src=${r.source}]\n`;
        }
        
        chatWebviewView?.webview.postMessage({ type: 'appendResponse', text: verboseOutput });
    }
    
    debugLog('SEARCH', 'comprehensiveSearch complete', {
        totalResults: sortedResults.length,
        topScore: sortedResults[0]?.score,
        topSource: sortedResults[0]?.source
    });
    
    return sortedResults;
}

function extractSearchKeywords(query) {
    // Remove common words AND task words (words that describe what to do, not what to search for)
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after',
        'above', 'below', 'between', 'under', 'again', 'further', 'then',
        'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
        'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
        'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
        'am', 'and', 'but', 'if', 'or', 'because', 'until', 'while',
        // Task words - describe actions, not search targets
        'explain', 'explained', 'explaining', 'explaing', // common typo
        'describe', 'described', 'show', 'shown', 'showing',
        'tell', 'me', 'about', 'find', 'found', 'finding',
        'code', 'function', 'method', 'class', 'file', 'does', 'work', 'works', 'working',
        'how', 'implement', 'implemented', 'implementation', 'implements',
        'identify', 'bug', 'bugs', 'issue', 'issues', 'problem', 'problems',
        'review', 'analyze', 'analyse', 'check', 'fix', 'look', 'see',
        'list', 'give', 'provide', 'help', 'want', 'need', 'please',
        'using', 'used', 'use', 'get', 'gets', 'getting'
    ]);
    
    // Helper: check if word is similar to any stop word (1 char difference)
    const isSimilarToStopWord = (word) => {
        const wLower = word.toLowerCase();
        if (stopWords.has(wLower)) return true;
        // Check for 1-char typos in common task words
        const taskRoots = ['explain', 'describe', 'implement', 'function', 'method'];
        for (const root of taskRoots) {
            if (wLower.startsWith(root) || root.startsWith(wLower.substring(0, 4))) return true;
        }
        return false;
    };
    
    // Extract words and technical terms
    const words = query
        .replace(/[^\w\s_.-]/g, ' ')  // Keep dots for file extensions
        .split(/\s+/)
        .filter(w => w.length > 2)
        .filter(w => !isSimilarToStopWord(w));
    
    // Also extract camelCase/snake_case parts
    const extraTerms = [];
    for (const word of words) {
        // Split camelCase
        const camelParts = word.split(/(?=[A-Z])/).filter(p => p.length > 2);
        extraTerms.push(...camelParts);
        
        // Split snake_case
        const snakeParts = word.split('_').filter(p => p.length > 2);
        extraTerms.push(...snakeParts);
    }
    
    // Combine and dedupe
    const allTerms = [...new Set([...words, ...extraTerms])];
    
    // ================================================================
    // QUERY EXPANSION: Add executor/implementation file hints
    // When asking "how X is implemented", add executor file patterns
    // ================================================================
    const queryLower = query.toLowerCase();
    const isImplementationQuery = queryLower.match(/\b(how|implement|execution|execute|perform|process|algorithm)\b/);
    
    if (isImplementationQuery) {
        // Add "node" prefix for executor files in PostgreSQL (e.g., nodeHashjoin, nodeSeqscan)
        for (const term of allTerms.slice(0, 5)) {
            const termLower = term.toLowerCase();
            // Add executor file patterns
            if (!termLower.startsWith('node')) {
                extraTerms.push('node' + term);      // nodeHashjoin
                extraTerms.push('Node' + term);      // NodeHashjoin
            }
            // Add "Exec" prefix for execution functions
            if (!termLower.startsWith('exec')) {
                extraTerms.push('Exec' + term);      // ExecHashJoin
                extraTerms.push('exec' + term);      // execHashjoin
            }
        }
        
        // Common PostgreSQL executor patterns
        if (queryLower.includes('hash') && queryLower.includes('join')) {
            extraTerms.push('nodeHashjoin', 'ExecHashJoin', 'HashJoinState', 'hashtable');
        }
        if (queryLower.includes('seq') || queryLower.includes('scan')) {
            extraTerms.push('nodeSeqscan', 'ExecSeqScan', 'SeqScanState');
        }
        if (queryLower.includes('index')) {
            extraTerms.push('nodeIndexscan', 'ExecIndexScan', 'IndexScanState');
        }
        if (queryLower.includes('sort')) {
            extraTerms.push('nodeSort', 'ExecSort', 'SortState', 'tuplesort');
        }
        if (queryLower.includes('aggregate') || queryLower.includes('group')) {
            extraTerms.push('nodeAgg', 'ExecAgg', 'AggState');
        }
        
        // Query execution pipeline questions
        if (queryLower.includes('query') && (queryLower.includes('parsing') || queryLower.includes('execution') || queryLower.includes('pipeline') || queryLower.includes('flow'))) {
            extraTerms.push(
                'postgres', 'postmaster',           // Entry points
                'exec_simple_query', 'PostgresMain', // Main query handler
                'pg_parse_query', 'raw_parser',     // Parser
                'parse_analyze', 'transformStmt',   // Analyzer
                'pg_rewrite_query', 'QueryRewrite', // Rewriter
                'pg_plan_query', 'planner',         // Planner
                'ExecutorStart', 'ExecutorRun', 'ExecutorEnd', // Executor
                'PortalRun', 'ProcessQuery'         // Portal/Query processing
            );
        }
    }
    
    // ================================================================
    // MODULE/DIRECTORY EXPANSION: Map topic names to PostgreSQL modules
    // ================================================================
    const moduleExpansions = {
        'btree': ['nbtree', 'nbtinsert', 'nbtsearch', 'nbtpage', 'nbtsort', 'nbtutils', 'nbtxlog', 'btree'],
        'hash': ['hash', 'hashinsert', 'hashsearch', 'hashpage', 'hashutil', 'hashfunc'],
        'gist': ['gist', 'gistutil', 'gistbuild', 'gistscan', 'gistget', 'gistproc'],
        'gin': ['gin', 'ginutil', 'gininsert', 'ginscan', 'ginget', 'ginfast', 'ginlogic'],
        'brin': ['brin', 'brin_inclusion', 'brin_minmax', 'brin_bloom', 'brin_tuple'],
        'heap': ['heapam', 'hio', 'pruneheap', 'vacuumlazy', 'visibilitymap', 'syncscan'],
        'vacuum': ['vacuum', 'vacuumlazy', 'analyze', 'autovacuum'],
        'wal': ['xlog', 'xloginsert', 'xlogreader', 'xlogrecovery', 'xlogutils'],
        'lock': ['lock', 'lmgr', 'lwlock', 'predicate', 'deadlock'],
        'buffer': ['bufmgr', 'freelist', 'localbuf', 'bufpage'],
        'storage': ['smgr', 'md', 'fd', 'buffile', 'copydir'],
        'catalog': ['pg_class', 'pg_type', 'pg_attribute', 'pg_index', 'syscache', 'catcache'],
        'executor': ['execMain', 'execProcnode', 'execScan', 'execTuples', 'execUtils'],
        'planner': ['planner', 'planmain', 'subselect', 'setrefs', 'pathnode', 'costsize'],
        'parser': ['parser', 'analyze', 'gram', 'scan', 'parse_clause', 'parse_expr'],
        'rewriter': ['rewriteHandler', 'rewriteManip', 'rewriteDefine', 'rewriteSupport'],
    };
    
    for (const [topic, expansions] of Object.entries(moduleExpansions)) {
        if (queryLower.includes(topic)) {
            extraTerms.push(...expansions);
        }
    }
    
    // Re-dedupe after expansion
    const finalTerms = [...new Set([...allTerms, ...extraTerms.filter(t => t.length > 2)])];
    
    return finalTerms.slice(0, 25); // Limit keywords (increased for expanded terms)
}

/**
 * Extract specific file names from query
 * Returns array of { fileName, baseName } for files mentioned
 */
function extractFileNamesFromQuery(query) {
    const files = [];
    
    // Match file patterns: word.ext or word_word.ext
    const filePatterns = [
        /\b([\w-]+\.(?:c|h|cpp|hpp|java|py|js|ts|go|rs|rb|sql|tal|cob|cbl))\b/gi,
        /\b([\w-]+\.(?:json|xml|yaml|yml|md|txt))\b/gi
    ];
    
    for (const pattern of filePatterns) {
        const matches = query.matchAll(pattern);
        for (const match of matches) {
            const fileName = match[1];
            const baseName = fileName.replace(/\.[^.]+$/, '');
            files.push({ fileName, baseName });
        }
    }
    
    return files;
}

/**
 * Find file path by name
 */
function findFileByName(fileName) {
    for (const [filePath, file] of contextFiles) {
        if (filePath.endsWith(fileName) || pathUtils.getFileName(filePath) === fileName) {
            return { path: filePath, file };
        }
    }
    return null;
}

/**
 * Extract code context around a line
 */
function extractCodeContext(content, lineNum, contextLines = 20) {
    const lines = content.split('\n');
    const start = Math.max(0, lineNum - contextLines - 1);
    const end = Math.min(lines.length, lineNum + contextLines);
    
    return lines.slice(start, end)
        .map((line, i) => `${(start + i + 1).toString().padStart(5)}: ${line}`)
        .join('\n');
}

/**
 * Chunk search results to fit context window
 */
function chunkSearchResults(results, maxChunkSize) {
    const chunks = [];
    let currentChunk = [];
    let currentSize = 0;
    
    for (const result of results) {
        const resultSize = (result.content?.length || 0) + 200; // 200 for metadata
        
        if (currentSize + resultSize > maxChunkSize && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentSize = 0;
        }
        
        currentChunk.push(result);
        currentSize += resultSize;
    }
    
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    
    return chunks;
}

/**
 * Analyze a chunk of search results
 */
async function analyzeChunk(query, chunk, chunkNum, totalChunks) {
    
    // Build context from chunk - now with actual source code content
    let context = '';
    let filesInChunk = new Set();
    let hasActualContent = false;
    
    for (const result of chunk) {
        const fileName = result.file?.split('/').pop() || 'unknown';
        filesInChunk.add(fileName);
        
        context += `\n### ${result.name} (${result.type} in ${fileName}:${result.line})\n`;
        
        if (result.content && result.content.length > 0) {
            hasActualContent = true;
            // Determine language for syntax highlighting
            const ext = fileName.split('.').pop()?.toLowerCase() || '';
            const langMap = {
                'c': 'c', 'h': 'c', 'cpp': 'cpp', 'hpp': 'cpp', 'cc': 'cpp',
                'java': 'java', 'py': 'python', 'js': 'javascript', 'ts': 'typescript',
                'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php',
                'sql': 'sql', 'sh': 'bash', 'yaml': 'yaml', 'json': 'json',
                'tal': 'c', 'cob': 'cobol', 'cbl': 'cobol'
            };
            const lang = langMap[ext] || '';
            context += `\`\`\`${lang}\n${result.content}\n\`\`\`\n`;
        } else {
            context += `[No source content available - metadata only]\n`;
        }
    }
    
    
    // Warn if no actual content
    if (!hasActualContent) {
        log(`analyzeChunk: WARNING - Chunk ${chunkNum} has no actual source code content!`);
        debugLog('SEARCH', `Chunk ${chunkNum} has no content`, {
            results: chunk.length,
            files: Array.from(filesInChunk)
        });
    }
    
    // IMPORTANT: Limit context size to prevent "prompt too large" errors
    const MAX_CONTEXT_SIZE = 12000;  // Increased since we now have actual code
    if (context.length > MAX_CONTEXT_SIZE) {
        log(`analyzeChunk: Truncating context from ${context.length} to ${MAX_CONTEXT_SIZE} chars`);
        context = context.substring(0, MAX_CONTEXT_SIZE) + '\n\n[... context truncated for size ...]';
    }
    
    // Detect if this is a "how" or "explain" question that needs structured analysis
    const isHowExplainQuery = /\b(how|explain|describe|what happens|walk.?through|detail|mechanism|process|algorithm|implementation|parsed|parsing|works)\b/i.test(query);
    
    
    // Build the appropriate prompt based on query type
    let prompt;
    
    if (isHowExplainQuery) {
        // Use ALGORITHM_GUIDANCE structure for how/explain questions
        prompt = `Analyze the following SOURCE CODE to answer the user's question.

## Source Code (Chunk ${chunkNum}/${totalChunks})
Files: ${Array.from(filesInChunk).join(', ')}

${context}

## User Question
${query}

${ALGORITHM_GUIDANCE}

## CRITICAL RULES FOR THIS CHUNK
1. **ANALYZE ONLY THE CODE SHOWN ABOVE** - don't use general knowledge about similar systems
2. Show ACTUAL code snippets from the chunk above in your steps
3. Cite file:line for every claim
4. If a section has no findings in THIS chunk, write "Not visible in this chunk"
5. **SKIP** Makefile, meson.build, README - focus on implementation files (.c, .h, .java, .py, .js)
6. This is chunk ${chunkNum} of ${totalChunks} - other chunks may have additional details

Your structured analysis based on the source code above:`;
    } else {
        // Standard analysis for non-how/explain questions
        prompt = `Analyze the following SOURCE CODE to answer the user's question.

## Source Code (Chunk ${chunkNum}/${totalChunks})
Files: ${Array.from(filesInChunk).join(', ')}

${context}

## User Question
${query}

## Instructions
1. **ANALYZE THE ACTUAL CODE** shown above - don't use general knowledge about similar systems
2. Extract specific insights from the code:
   - Function names, signatures, and their purposes
   - Data structures and their fields
   - Control flow and logic patterns
   - Key algorithms and operations
3. Quote specific code snippets or line numbers to support your analysis
4. Explain what the code does based on what you see, not what you assume
5. If the code is incomplete or truncated, note what's visible and what might be in other chunks
6. **SKIP** analysis of Makefile, meson.build, README - these don't contain implementation
7. Focus on .c, .h, .java, .py, .js files that have actual implementation code

Your analysis based on the source code:`;
    }


    try {
        let analysis = await callLanguageModel(prompt);
        
        
        // Check if the response is actually an error message
        if (isLlmErrorResponse(analysis)) {
            log('analyzeChunk: Got error template instead of analysis');
            return null;
        }
        
        // Truncate overly long analyses to prevent prompt explosion
        const MAX_ANALYSIS_LENGTH = 10000;  // ~2500 words
        if (analysis && analysis.length > MAX_ANALYSIS_LENGTH) {
            log(`analyzeChunk: Truncating analysis from ${analysis.length} to ${MAX_ANALYSIS_LENGTH} chars`);
            analysis = analysis.substring(0, MAX_ANALYSIS_LENGTH) + '\n\n[... truncated for brevity ...]';
        }
        
        return analysis;
    } catch (error) {
        log('analyzeChunk: Error:', error.message);
        return null;
    }
}

/**
 * Synthesize multiple chunk analyses into final answer
 */
async function synthesizeChunkAnalyses(query, analyses, priorityFiles = [], allFilesAnalyzed = []) {
    
    // ================================================================
    // HIERARCHICAL MAP/REDUCE SYNTHESIS
    // If we have many analyses, merge them in batches to avoid token limits
    // Like merge sort: combine small groups → combine those → final result
    // ================================================================
    
    const MAX_BATCH_SIZE = 3;  // Process 3 analyses at a time (reduced for API limits)
    const MAX_COMBINED_SIZE = 15000;  // Trigger hierarchical merge early (API limit ~25K)
    
    log(`synthesizeChunkAnalyses: Processing ${analyses.length} analyses`);
    
    // Check if we need hierarchical merging
    let combinedAnalyses = analyses.map((a, i) => `### Part ${i + 1}\n${a}`).join('\n\n');
    
    
    if (combinedAnalyses.length > MAX_COMBINED_SIZE && analyses.length > MAX_BATCH_SIZE) {
        log(`synthesizeChunkAnalyses: Content too large (${Math.round(combinedAnalyses.length/1024)}KB), using hierarchical merge`);
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n🔄 *Large result set - using hierarchical merge (${analyses.length} chunks → batches of ${MAX_BATCH_SIZE})...*\n`
        });
        
        // Merge analyses in batches until we have a manageable size
        let currentAnalyses = [...analyses];
        let mergeRound = 1;
        
        while (currentAnalyses.length > MAX_BATCH_SIZE) {
            const mergedBatches = [];
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n*Merge round ${mergeRound}: ${currentAnalyses.length} → ~${Math.ceil(currentAnalyses.length / MAX_BATCH_SIZE)} summaries...*\n`
            });
            
            // Process in batches
            for (let i = 0; i < currentAnalyses.length; i += MAX_BATCH_SIZE) {
                const batch = currentAnalyses.slice(i, i + MAX_BATCH_SIZE);
                const batchNum = Math.floor(i / MAX_BATCH_SIZE) + 1;
                const totalBatches = Math.ceil(currentAnalyses.length / MAX_BATCH_SIZE);
                
                // Merge this batch into an intermediate summary
                let batchContent = batch.map((a, j) => `### Section ${j + 1}\n${a}`).join('\n\n');
                
                // Limit batch content size to prevent prompt overflow
                const MAX_BATCH_CONTENT = 10000;  // Conservative to stay under 25K API limit
                if (batchContent.length > MAX_BATCH_CONTENT) {
                    log(`synthesizeChunkAnalyses: Truncating batch ${batchNum} from ${batchContent.length} to ${MAX_BATCH_CONTENT}`);
                    batchContent = batchContent.substring(0, MAX_BATCH_CONTENT) + '\n\n[... truncated ...]';
                }
                
                const mergePrompt = `Merge these ${batch.length} analysis sections into a comprehensive technical summary.

## Original Query
${query}

## Sections to Merge
${batchContent}

## Instructions
1. PRESERVE all specific code references (function names, file names, line numbers)
2. PRESERVE technical patterns and implementation details
3. PRESERVE the "how it works" explanations with concrete examples
4. PRESERVE code snippets that demonstrate key logic
5. Remove only true duplicates where the exact same point is made twice
6. For HOW/EXPLAIN questions, maintain this structure:
   - High-Level Summary
   - Key Inputs and Outputs  
   - Core Algorithm Steps (with code snippets)
   - Key Data Structures
   - Key Functions
   - Process Flow
   - Error Handling
7. Keep technical depth - this is for developers, not executives
8. Target 2500-3000 words - detail is more important than brevity
9. **OMIT any analysis of Makefile, meson.build, CMakeLists.txt, README** - these are build files, not implementation

Merged technical summary:`;

                try {
                    let merged = await callLanguageModel(mergePrompt);
                    
                    // Ensure merge didn't over-compress
                    if (merged && merged.length < 1000 && batchContent.length > 3000) {
                        log(`synthesizeChunkAnalyses: Merge too short (${merged.length}), keeping original`);
                        merged = batch.join('\n\n---\n\n');
                    }
                    
                    if (merged && merged.length > 50) {
                        mergedBatches.push(merged);
                        log(`synthesizeChunkAnalyses: Merged batch ${batchNum}/${totalBatches} (${batch.length} → 1)`);
                    } else {
                        // Keep original if merge failed
                        mergedBatches.push(batch.join('\n\n---\n\n'));
                    }
                } catch (err) {
                    log(`synthesizeChunkAnalyses: Batch ${batchNum} merge failed:`, err.message);
                    mergedBatches.push(batch.join('\n\n---\n\n'));
                }
            }
            
            currentAnalyses = mergedBatches;
            mergeRound++;
            
            // Safety check to prevent infinite loops
            if (mergeRound > 5) {
                log('synthesizeChunkAnalyses: Max merge rounds reached, proceeding with current results');
                break;
            }
        }
        
        // Update combinedAnalyses with merged results
        combinedAnalyses = currentAnalyses.map((a, i) => `### Summary ${i + 1}\n${a}`).join('\n\n');
        log(`synthesizeChunkAnalyses: After ${mergeRound - 1} merge rounds: ${Math.round(combinedAnalyses.length/1024)}KB`);
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*Merge complete: ${analyses.length} chunks → ${currentAnalyses.length} summaries (${Math.round(combinedAnalyses.length/1024)}KB)*\n`
        });
    }
    
    // Add priority file information at the TOP of the context
    if (priorityFiles.length > 0) {
        // Limit to top 10 unique files
        const topPriorityFiles = priorityFiles.slice(0, 10);
        const prioritySection = `## ⭐ HIGH-PRIORITY FILES (filename matches query topic)
These files are MOST LIKELY to contain core implementation - prioritize them in key_files:
${topPriorityFiles.map(f => `- ${f}`).join('\n')}

---

`;
        combinedAnalyses = prioritySection + combinedAnalyses;
    }
    
    // VERBOSE: Show which code path we're in
    if (AGENT_CONFIG.verboseSearch) {
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n**🔧 Debug: Using synthesizeChunkAnalyses (${analyses.length} chunks, ${Math.round(combinedAnalyses.length/1024)}KB)**\n`
        });
        if (priorityFiles.length > 0) {
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `**Priority files (filename matches):** ${priorityFiles.join(', ')}\n\n`
            });
        }
    }
    
    // Use the two-stage synthesis approach for consistent formatting
    const subQuestions = decomposeQuestion(query);
    
    
    // Route through the two-stage synthesis function
    const result = await synthesizeFindingsWithReferences(
        query,
        combinedAnalyses,
        null, // domain
        null, // domain_notes
        subQuestions,
        allFilesAnalyzed, // filesAnalyzed
        [], // relatedFiles  
        []  // functionsFound
    );
    
    
    if (result.success && result.data?.answer) {
        return result.data.answer;
    }
    
    // Fallback if two-stage fails
    log('synthesizeChunkAnalyses: Two-stage failed, falling back to direct synthesis');
    
    // Detect if this is a "how" or "explain" question
    const isHowExplainQuery = /\b(how|explain|describe|what happens|walk.?through|detail|mechanism|process|algorithm|implementation|parsed|parsing|works)\b/i.test(query);
    
    let prompt;
    if (isHowExplainQuery) {
        prompt = `Synthesize these partial analyses into a complete, structured answer.

## Original Question
${query}

## Analyses from Different Code Sections
${combinedAnalyses}

${ALGORITHM_GUIDANCE}

## Additional Instructions
1. Combine the insights from all analyses into the structured format above
2. Resolve any contradictions between sections
3. Include specific code references (function names, file:line)
4. Show actual code snippets for key steps
5. **NEVER mention or summarize**: Makefile, meson.build, CMakeLists.txt, README files
6. If a section has no findings, write "Not found in analyzed code"

Final synthesized answer:`;
    } else {
        prompt = `Synthesize these partial analyses into a complete answer.

## Original Question
${query}

## Analyses from Different Code Sections
${combinedAnalyses}

## Instructions
1. Combine the insights from all analyses
2. Resolve any contradictions
3. Provide a coherent, complete answer
4. Include specific code references (function names, line numbers)
5. Structure the answer logically (overview first, then details)
6. FOCUS ON FILES that contain actual content - code (.c, .h, .java, .py, .js, etc.)
7. **NEVER mention or summarize**: Makefile, meson.build, CMakeLists.txt, README files

Final synthesized answer:`;
    }

    const fallbackResult = await callLanguageModel(prompt);
    
    // Check if the fallback also failed
    if (isLlmErrorResponse(fallbackResult)) {
        return `**Unable to synthesize analysis**

The LLM is currently unavailable. Please check your GitHub Copilot or API configuration.

**What was found:**
${analyses.length > 0 ? `- Analyzed ${analyses.length} code chunks` : '- No code chunks analyzed'}
${priorityFiles.length > 0 ? `- Priority files: ${priorityFiles.slice(0, 5).join(', ')}` : ''}

Try again later or check the Output panel (View → Output → AstraCode) for details.`;
    }
    
    return fallbackResult;
}

/**
 * Search for relevant code using all available methods
 * Used by answer_question tool for search-first approach
 */
async function searchForRelevantCode(question, subQuestions = []) {
    log('searchForRelevantCode: Starting multi-method search');
    
    const results = new Map(); // Dedupe by file:line
    
    // Combine question and sub-questions for keyword extraction
    const fullQuery = [question, ...subQuestions].join(' ');
    const keywords = extractSearchKeywords(fullQuery);
    log('searchForRelevantCode: Keywords:', keywords.slice(0, 10));
    
    // ================================================================
    // -1. SPECIFIC FILE MENTIONED IN QUERY (HIGHEST PRIORITY)
    // For "identify bugs in partdesc.c" → focus on partdesc.c
    // ================================================================
    const mentionedFiles = extractFileNamesFromQuery(fullQuery);
    if (mentionedFiles.length > 0) {
        log('searchForRelevantCode: Specific files mentioned:', mentionedFiles.map(f => f.fileName));
        
        for (const { fileName, baseName } of mentionedFiles) {
            // Find this file in context
            for (const [filePath, file] of contextFiles) {
                const pathFileName = pathUtils.getFileName(filePath);
                if (pathFileName === fileName || pathFileName.toLowerCase() === fileName.toLowerCase()) {
                    log(`searchForRelevantCode: Found mentioned file: ${filePath}`);
                    
                    // Add ALL symbols from this file with HIGHEST priority
                    for (const [symKey, symbol] of codeIndex.symbols) {
                        if (symbol.file === filePath && !symKey.includes('@')) {
                            const key = `${symbol.file}:${symbol.line}`;
                            if (!results.has(key)) {
                                results.set(key, {
                                    file: symbol.file,
                                    line: symbol.line,
                                    name: symbol.name,
                                    type: symbol.type,
                                    score: 2.0, // HIGHEST score - specific file mentioned
                                    source: 'mentioned-file',
                                    content: null
                                });
                            }
                        }
                    }
                    
                    // Also add the file header if no symbols
                    if (results.size === 0) {
                        results.set(`${filePath}:1`, {
                            file: filePath,
                            line: 1,
                            name: pathFileName,
                            type: 'file',
                            score: 2.0,
                            source: 'mentioned-file',
                            content: extractCodeContext(file.content, 1, 100)
                        });
                    }
                }
            }
        }
        
        // If we found the specific file, we may want to focus on it
        if (results.size > 0) {
            log(`searchForRelevantCode: Found ${results.size} results from mentioned files`);
        }
    }
    
    // ================================================================
    // 0. FILE NAME MATCHING (HIGH PRIORITY)
    // For queries like "show me partition code", find files with "partition" in name
    // Also handles: keyword in filename OR filename stem in keyword
    // ================================================================
    log('searchForRelevantCode: Checking file name matches...');
    for (const keyword of keywords) {
        if (keyword.length < 3) continue;
        const keywordLower = keyword.toLowerCase();
        
        for (const [filePath, file] of contextFiles) {
            const fileName = pathUtils.getFileName(filePath).toLowerCase();
            const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
            
            // Check BOTH directions:
            // 1. keyword in filename: "part" matches "partdesc.c"
            // 2. filename stem in keyword: "partdesc" matches "partitioning" (via common prefix)
            const keywordInFile = fileNameNoExt.includes(keywordLower) || fileName.includes(keywordLower);
            const fileInKeyword = keywordLower.includes(fileNameNoExt.substring(0, 4)); // First 4 chars
            const commonPrefix = fileNameNoExt.substring(0, 4) === keywordLower.substring(0, 4); // e.g., "part" == "part"
            
            if (keywordInFile || (fileNameNoExt.length >= 4 && (fileInKeyword || commonPrefix))) {
                // Add all top-level symbols from this file with HIGH priority
                let addedFromFile = 0;
                for (const [symKey, symbol] of codeIndex.symbols) {
                    if (symbol.file === filePath && !symKey.includes('@')) {
                        const key = `${symbol.file}:${symbol.line}`;
                        if (!results.has(key)) {
                            results.set(key, {
                                file: symbol.file,
                                line: symbol.line,
                                name: symbol.name,
                                type: symbol.type,
                                score: 1.5, // HIGH score for file name matches
                                source: 'filename-match',
                                content: null
                            });
                            addedFromFile++;
                        }
                    }
                }
                
                // If no symbols found, add the file header
                if (addedFromFile === 0) {
                    const key = `${filePath}:1`;
                    if (!results.has(key)) {
                        results.set(key, {
                            file: filePath,
                            line: 1,
                            name: fileName,
                            type: 'file',
                            score: 1.4,
                            source: 'filename-match',
                            content: extractCodeContext(file.content, 1, 50)
                        });
                    }
                }
                
                log(`searchForRelevantCode: File name match: ${fileName} for keyword "${keyword}"`);
            }
        }
    }
    log('searchForRelevantCode: After file name matching:', results.size, 'results');
    
    // ================================================================
    // 1. SYMBOL NAME SEARCH (exact matches get higher score)
    // ================================================================
    log('searchForRelevantCode: Searching symbol index...');
    for (const keyword of keywords.slice(0, 8)) {
        const keywordLower = keyword.toLowerCase();
        
        // First: exact/partial symbol name matches
        for (const [symKey, symbol] of codeIndex.symbols) {
            if (symKey.includes('@')) continue;
            
            const symNameLower = symbol.name.toLowerCase();
            const key = `${symbol.file}:${symbol.line}`;
            
            if (results.has(key)) continue; // Already have from file match
            
            if (symNameLower === keywordLower) {
                results.set(key, {
                    file: symbol.file,
                    line: symbol.line,
                    name: symbol.name,
                    type: symbol.type,
                    score: 1.3, // High score for exact name match
                    source: 'symbol-exact',
                    content: null
                });
            } else if (symNameLower.includes(keywordLower)) {
                results.set(key, {
                    file: symbol.file,
                    line: symbol.line,
                    name: symbol.name,
                    type: symbol.type,
                    score: 1.0, // Good score for partial name match
                    source: 'symbol-partial',
                    content: null
                });
            }
        }
        
        // Then fuzzy search for remaining
        const symbolResults = fuzzySearchSymbols(keyword, null, 30);
        for (const symbol of symbolResults) {
            const key = `${symbol.file}:${symbol.line}`;
            if (!results.has(key)) {
                results.set(key, {
                    file: symbol.file,
                    line: symbol.line,
                    name: symbol.name,
                    type: symbol.type,
                    score: (symbol.matchScore || 0.5) + 0.1,
                    source: 'symbol-fuzzy',
                    content: null
                });
            }
        }
    }
    log('searchForRelevantCode: After symbol search:', results.size, 'results');
    
    // 2. VECTOR/EMBEDDING SEARCH (semantic similarity)
    if (vectorIndex.chunks.length > 0) {
        log('searchForRelevantCode: Searching vector index...');
        try {
            const vectorResults = await hybridSearch(question, { maxResults: 30 });
            for (const vr of vectorResults) {
                const key = `${vr.file}:${vr.line || 0}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: vr.file,
                        line: vr.line || 1,
                        name: vr.symbol || vr.file?.split('/').pop(),
                        type: 'vector',
                        score: (vr.score || 0.5) + 0.2, // Boost semantic matches
                        source: 'vector',
                        content: vr.preview
                    });
                } else {
                    // Boost score if found by multiple methods
                    const existing = results.get(key);
                    existing.score += 0.15;
                }
            }
            log('searchForRelevantCode: Vector search total now', results.size);
        } catch (e) {
            log('searchForRelevantCode: Vector search error:', e.message);
        }
    }
    
    // 3. GREP SEARCH (text patterns - catches things symbol parser might miss)
    log('searchForRelevantCode: Running grep search...');
    for (const keyword of keywords.slice(0, 5)) {
        if (keyword.length < 3) continue;
        
        try {
            const grepResults = grepContext(keyword, 8);
            for (const match of grepResults) {
                // Find the file path
                let filePath = null;
                for (const [path, file] of contextFiles) {
                    if (path.endsWith(match.fileName) || path.includes(match.fileName)) {
                        filePath = path;
                        break;
                    }
                }
                
                if (filePath) {
                    const key = `${filePath}:${match.startLine}`;
                    if (!results.has(key)) {
                        results.set(key, {
                            file: filePath,
                            line: match.startLine,
                            name: match.fileName,
                            type: 'grep',
                            score: 0.6,
                            source: 'grep',
                            content: match.content
                        });
                    } else {
                        // Boost if found by multiple methods
                        const existing = results.get(key);
                        existing.score += 0.1;
                    }
                }
            }
        } catch (e) {
            log('searchForRelevantCode: Grep error for', keyword, ':', e.message);
        }
    }
    log('searchForRelevantCode: After grep, total', results.size);
    
    // 4. CALL GRAPH TRAVERSAL (for tracing/flow questions)
    if (/trace|flow|call|calls|calling|invoke|path|chain/i.test(question)) {
        log('searchForRelevantCode: Adding call graph results for flow query...');
        for (const keyword of keywords.slice(0, 5)) {
            // Find functions matching keyword
            for (const [name, symbol] of codeIndex.symbols) {
                if (name.includes('@')) continue;
                if (!name.toLowerCase().includes(keyword.toLowerCase())) continue;
                
                // Add what this function calls
                const calls = codeIndex.callGraph.get(name);
                if (calls) {
                    for (const called of calls) {
                        const calledSymbol = codeIndex.symbols.get(called);
                        if (calledSymbol) {
                            const key = `${calledSymbol.file}:${calledSymbol.line}`;
                            if (!results.has(key)) {
                                results.set(key, {
                                    file: calledSymbol.file,
                                    line: calledSymbol.line,
                                    name: called,
                                    type: 'callgraph',
                                    score: 0.7,
                                    source: 'callgraph-callee',
                                    content: null
                                });
                            }
                        }
                    }
                }
                
                // Add what calls this function
                const callers = codeIndex.reverseCallGraph.get(name);
                if (callers) {
                    for (const caller of callers) {
                        const callerSymbol = codeIndex.symbols.get(caller);
                        if (callerSymbol) {
                            const key = `${callerSymbol.file}:${callerSymbol.line}`;
                            if (!results.has(key)) {
                                results.set(key, {
                                    file: callerSymbol.file,
                                    line: callerSymbol.line,
                                    name: caller,
                                    type: 'callgraph',
                                    score: 0.7,
                                    source: 'callgraph-caller',
                                    content: null
                                });
                            }
                        }
                    }
                }
            }
        }
        log('searchForRelevantCode: After call graph, total', results.size);
    }
    
    // Convert to array and fill in missing content
    const resultsArray = Array.from(results.values());
    
    for (const result of resultsArray) {
        if (!result.content && result.file) {
            const file = contextFiles.get(result.file);
            if (file) {
                // Extract more context for better analysis
                result.content = extractCodeContext(file.content, result.line, 40);
            }
        }
    }
    
    // Sort by score (highest first)
    resultsArray.sort((a, b) => b.score - a.score);
    
    // Return top results (limit to avoid overwhelming LLM)
    const maxResults = 80;
    log('searchForRelevantCode: Returning top', Math.min(resultsArray.length, maxResults), 'of', resultsArray.length, 'results');
    
    return resultsArray.slice(0, maxResults);
}

/**
 * Build focused chunks from search results
 * Groups related results and ensures chunks fit within size limit
 */
function buildFocusedChunks(searchResults, maxChunkSize) {
    const chunks = [];
    let currentChunk = { content: '', files: new Set(), resultCount: 0 };
    
    // Group results by file for better context
    const byFile = new Map();
    for (const result of searchResults) {
        const fileName = pathUtils.getFileName(result.file) || 'unknown';
        if (!byFile.has(fileName)) {
            byFile.set(fileName, []);
        }
        byFile.get(fileName).push(result);
    }
    
    // Build chunks, keeping file results together when possible
    for (const [fileName, fileResults] of byFile) {
        // Sort results within file by line number
        fileResults.sort((a, b) => (a.line || 0) - (b.line || 0));
        
        for (const result of fileResults) {
            const resultText = `### ${result.name} (${result.type} in ${fileName}:${result.line})
Source: ${result.source}, Score: ${(result.score * 100).toFixed(0)}%
\`\`\`
${result.content || 'No content available'}
\`\`\`

`;
            
            // Check if adding this result would exceed chunk size
            if (currentChunk.content.length + resultText.length > maxChunkSize && currentChunk.resultCount > 0) {
                // Save current chunk and start new one
                chunks.push(currentChunk);
                currentChunk = { content: '', files: new Set(), resultCount: 0 };
            }
            
            currentChunk.content += resultText;
            currentChunk.files.add(fileName);
            currentChunk.resultCount++;
        }
    }
    
    // Don't forget the last chunk
    if (currentChunk.resultCount > 0) {
        chunks.push(currentChunk);
    }
    
    log('buildFocusedChunks: Created', chunks.length, 'chunks from', searchResults.length, 'results');
    
    return chunks;
}

/**
 * Simple synchronous grep for context search
 */
function grepContext(pattern, contextLines = 5) {
    const results = [];
    const patternLower = pattern.toLowerCase();
    
    for (const [filePath, file] of contextFiles) {
        const lines = file.content.split('\n');
        const fileName = pathUtils.getFileName(filePath);
        
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(patternLower)) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length, i + contextLines + 1);
                const content = lines.slice(start, end)
                    .map((line, idx) => `${(start + idx + 1).toString().padStart(5)}: ${line}`)
                    .join('\n');
                
                results.push({
                    fileName,
                    filePath: filePath,
                    startLine: i + 1,
                    matchLine: i + 1,
                    content
                });
                
                // Skip ahead to avoid duplicate overlapping matches
                i += contextLines;
            }
        }
    }
    
    return results;
}

function parseFile(path, content, language) {
    const symbols = [];
    const lines = content.split('\n');
    
    log('parseFile: Parsing', path);
    log('parseFile: Language:', language, '- Lines:', lines.length);
    
    const parsers = {
        // C/C++
        'c': parseCStyle,
        'cpp': parseCStyle,
        'h': parseCStyle,
        
        // Java/JVM
        'java': parseJavaStyle,
        'kotlin': parseJavaStyle,
        'scala': parseJavaStyle,
        
        // C#
        'csharp': parseCSharp,
        
        // JavaScript/TypeScript
        'javascript': parseJSStyle,
        'typescript': parseJSStyle,
        
        // Python
        'python': parsePython,
        
        // SQL
        'sql': parseSQL,
        
        // COBOL
        'cobol': parseCobol,
        
        // TAL
        'tal': parseTal,
        
        // Go
        'go': parseGo,
        
        // Rust
        'rust': parseRust,
        
        // Default
        'default': parseGeneric
    };
    
    const parser = parsers[language];
    if (!parser) {
        log('parseFile: No parser for language:', language, '- using default');
    }
    const actualParser = parser || parsers['default'];
    const fileSymbols = actualParser(content, lines);
    
    // Add summaries to callable symbols (functions, procedures, methods)
    const callableTypes = new Set([
        'function', 'procedure', 'method', 'subproc', 'constructor',
        'section', 'paragraph', 'program', 'macro'
    ]);
    
    for (const symbol of fileSymbols) {
        if (callableTypes.has(symbol.type) && symbol.line) {
            const summary = generateFunctionSummary(content, symbol.line, language);
            if (summary) {
                symbol.summary = summary;
            } else {
                // Generate from name: convertCamelCase → "Convert camel case"
                symbol.summary = generateSummaryFromName(symbol.name);
            }
        }
    }
    
    log('parseFile:', path, '- found', fileSymbols.length, 'symbols');
    return {
        path,
        language,
        symbols: fileSymbols,
        lineCount: lines.length
    };
}

function parseCStyle(content, lines) {
    const symbols = [];
    
    // Function definitions: type name(params) {
    const funcRegex = /^[\s]*(?:static\s+)?(?:inline\s+)?(?:const\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*\(([^)]*)\)\s*(?:\{|$)/gm;
    let match;
    
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[2],
            type: 'function',
            returnType: match[1].trim(),
            params: match[3].trim(),
            line: lineNum,
            signature: `${match[1].trim()} ${match[2]}(${match[3].trim()})`
        });
    }
    
    // Struct definitions
    const structRegex = /\b(?:struct|class|union|enum)\s+(\w+)/g;
    while ((match = structRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'struct',
            line: lineNum
        });
    }
    
    // #define macros
    const defineRegex = /^#define\s+(\w+)(?:\(([^)]*)\))?/gm;
    while ((match = defineRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: match[2] ? 'macro-function' : 'macro',
            params: match[2] || '',
            line: lineNum
        });
    }
    
    // Global variables (simplified)
    const globalRegex = /^(?:static\s+)?(?:const\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*(?:=|;)/gm;
    while ((match = globalRegex.exec(content)) !== null) {
        // Skip if it's inside a function (simplified check)
        const before = content.substring(0, match.index);
        const braceCount = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
        if (braceCount === 0) {
            const lineNum = before.split('\n').length;
            const hasInit = content.substring(match.index).match(/^\s*[^;]*=/);
            symbols.push({
                name: match[2],
                type: 'variable',
                dataType: match[1].trim(),
                line: lineNum,
                initLine: hasInit ? lineNum : null,
                scope: 'global'
            });
        }
    }
    
    // Local variables inside functions (scan function bodies)
    const funcBodyRegex = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let funcMatch;
    while ((funcMatch = funcBodyRegex.exec(content)) !== null) {
        const bodyStart = content.substring(0, funcMatch.index).split('\n').length;
        const body = funcMatch[1];
        
        // Find variable declarations in function body
        const localVarRegex = /(?:^|\n)\s*(?:const\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*(=\s*[^;]+)?;/g;
        let localMatch;
        while ((localMatch = localVarRegex.exec(body)) !== null) {
            const relLineNum = body.substring(0, localMatch.index).split('\n').length;
            const lineNum = bodyStart + relLineNum;
            const dataType = localMatch[1].trim();
            // Skip common keywords that look like types
            if (!['return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue'].includes(dataType)) {
                symbols.push({
                    name: localMatch[2],
                    type: 'variable',
                    dataType: dataType,
                    line: lineNum,
                    initLine: localMatch[3] ? lineNum : null,
                    scope: 'local'
                });
            }
        }
    }
    
    // Function parameters
    const paramRegex = /\(([^)]+)\)/g;
    while ((match = paramRegex.exec(content)) !== null) {
        const params = match[1].split(',');
        const lineNum = content.substring(0, match.index).split('\n').length;
        for (const param of params) {
            const paramMatch = param.trim().match(/(\w+(?:\s*\*)*)\s+(\w+)$/);
            if (paramMatch) {
                symbols.push({
                    name: paramMatch[2],
                    type: 'parameter',
                    dataType: paramMatch[1].trim(),
                    line: lineNum,
                    scope: 'parameter'
                });
            }
        }
    }
    
    return symbols;
}

function parseJavaStyle(content, lines) {
    const symbols = [];
    let match;
    
    // Class definitions
    const classRegex = /\b(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/g;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'class',
            line: lineNum
        });
    }
    
    // Method definitions
    const methodRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
    while ((match = methodRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        if (match[2] !== 'if' && match[2] !== 'for' && match[2] !== 'while') {
            symbols.push({
                name: match[2],
                type: 'method',
                returnType: match[1],
                params: match[3].trim(),
                line: lineNum,
                signature: `${match[1]} ${match[2]}(${match[3].trim()})`
            });
            
            // Extract parameters
            const params = match[3].split(',');
            for (const param of params) {
                const paramMatch = param.trim().match(/(\w+(?:<[^>]+>)?)\s+(\w+)$/);
                if (paramMatch) {
                    symbols.push({
                        name: paramMatch[2],
                        type: 'parameter',
                        dataType: paramMatch[1],
                        line: lineNum,
                        scope: 'parameter'
                    });
                }
            }
        }
    }
    
    // Class fields (member variables)
    const fieldRegex = /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*(?:=\s*[^;]+)?;/g;
    while ((match = fieldRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const hasInit = match[0].includes('=');
        symbols.push({
            name: match[2],
            type: 'field',
            dataType: match[1],
            line: lineNum,
            initLine: hasInit ? lineNum : null,
            scope: 'member'
        });
    }
    
    // Local variables in method bodies
    const localVarRegex = /(?:^|\n)\s*(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*=\s*[^;]+;/g;
    while ((match = localVarRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const dataType = match[1];
        // Skip keywords and already captured
        if (!['return', 'if', 'else', 'for', 'while', 'switch', 'case', 'new', 'throw', 'public', 'private', 'protected'].includes(dataType)) {
            symbols.push({
                name: match[2],
                type: 'variable',
                dataType: dataType,
                line: lineNum,
                initLine: lineNum,
                scope: 'local'
            });
        }
    }
    
    return symbols;
}

function parseJSStyle(content, lines) {
    const symbols = [];
    let match;
    
    // Function declarations (including exported)
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'function',
            params: match[2].trim(),
            line: lineNum,
            signature: `function ${match[1]}(${match[2].trim()})`
        });
    }
    
    // Arrow functions and const functions (including exported)
    const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?([^)=]*?)\)?\s*=>/g;
    while ((match = arrowRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'function',
            params: match[2].trim(),
            line: lineNum,
            signature: `const ${match[1]} = (${match[2].trim()}) =>`
        });
    }
    
    // Export default function
    const exportDefaultFuncRegex = /export\s+default\s+(?:async\s+)?function\s*(\w*)\s*\(([^)]*)\)/g;
    while ((match = exportDefaultFuncRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1] || 'default';
        symbols.push({
            name: name,
            type: 'function',
            params: match[2].trim(),
            line: lineNum,
            isDefault: true
        });
    }
    
    // Class definitions (including exported)
    const classRegex = /(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'class',
            extends: match[2] || null,
            line: lineNum
        });
    }
    
    // Class methods (including static, async, get, set)
    const methodRegex = /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(([^)]*)\)\s*\{/gm;
    while ((match = methodRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1];
        if (!['if', 'for', 'while', 'switch', 'function', 'catch', 'with'].includes(name)) {
            symbols.push({
                name: name,
                type: 'method',
                params: match[2].trim(),
                line: lineNum
            });
        }
    }
    
    // TypeScript interfaces
    const interfaceRegex = /(?:export\s+)?interface\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+[\w,\s<>]+)?/g;
    while ((match = interfaceRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'interface',
            line: lineNum
        });
    }
    
    // TypeScript type aliases
    const typeRegex = /(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=/g;
    while ((match = typeRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'type',
            line: lineNum
        });
    }
    
    // TypeScript enums
    const enumRegex = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/g;
    while ((match = enumRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'enum',
            line: lineNum
        });
    }
    
    // React functional components (const X = () => { return <jsx> } or function X() { return <jsx> })
    // Already captured by function/arrow patterns above
    
    // Module.exports patterns (CommonJS)
    const moduleExportRegex = /module\.exports\s*=\s*(?:\{[^}]*(\w+)[^}]*\}|(\w+))/g;
    while ((match = moduleExportRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1] || match[2];
        if (name && !symbols.some(s => s.name === name)) {
            symbols.push({
                name: name,
                type: 'export',
                line: lineNum
            });
        }
    }
    
    // Object method shorthand in exports: { methodName() { } }
    const objMethodRegex = /(\w+)\s*\(([^)]*)\)\s*\{/g;
    // Already captured by method regex
    
    // Constants/Variables that might be important (exported)
    const constRegex = /export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/g;
    while ((match = constRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        // Skip if it's a function (already captured)
        const restOfLine = content.substring(match.index, match.index + 200);
        if (!restOfLine.includes('=>') && !restOfLine.includes('function')) {
            symbols.push({
                name: match[1],
                type: 'variable',
                line: lineNum
            });
        }
    }
    
    return symbols;
}

function parsePython(content, lines) {
    const symbols = [];
    let match;
    
    log('parsePython: Parsing', lines.length, 'lines of Python code');
    log('parsePython: First 200 chars:', content.substring(0, 200).replace(/\n/g, '\\n'));
    
    // Function definitions - allow leading whitespace for class methods
    const funcRegex = /^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        log('parsePython: Found function', match[1], 'at line', lineNum);
        symbols.push({
            name: match[1],
            type: 'function',
            params: match[2].trim(),
            line: lineNum
        });
        
        // Extract parameters with type hints
        const params = match[2].split(',');
        for (const param of params) {
            const paramMatch = param.trim().match(/^(\w+)(?:\s*:\s*(\w+(?:\[[^\]]+\])?))?/);
            if (paramMatch && paramMatch[1] !== 'self' && paramMatch[1] !== 'cls') {
                symbols.push({
                    name: paramMatch[1],
                    type: 'parameter',
                    dataType: paramMatch[2] || 'Any',
                    line: lineNum,
                    scope: 'parameter'
                });
            }
        }
    }
    
    // Class definitions - allow leading whitespace for nested classes
    const classRegex = /^[ \t]*class\s+(\w+)(?:\(([^)]*)\))?:/gm;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        log('parsePython: Found class', match[1], 'at line', lineNum);
        symbols.push({
            name: match[1],
            type: 'class',
            extends: match[2] || null,
            line: lineNum
        });
    }
    
    // Class attributes with type annotations
    const attrRegex = /^\s+(\w+)\s*:\s*(\w+(?:\[[^\]]+\])?)\s*(?:=\s*(.+))?$/gm;
    while ((match = attrRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'field',
            dataType: match[2],
            line: lineNum,
            initLine: match[3] ? lineNum : null,
            scope: 'member'
        });
    }
    
    // Global/module-level variables with assignments
    const globalVarRegex = /^([A-Z_][A-Z0-9_]*)\s*(?::\s*(\w+))?\s*=\s*(.+)$/gm;
    while ((match = globalVarRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'constant',
            dataType: match[2] || inferPythonType(match[3]),
            line: lineNum,
            initLine: lineNum,
            scope: 'global'
        });
    }
    
    // Local variable assignments (simple heuristic)
    const localVarRegex = /^\s{4,}(\w+)\s*(?::\s*(\w+(?:\[[^\]]+\])?))\s*=\s*(.+)$/gm;
    while ((match = localVarRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        if (!['self', 'cls', 'if', 'for', 'while', 'with', 'try', 'except', 'return'].includes(match[1])) {
            symbols.push({
                name: match[1],
                type: 'variable',
                dataType: match[2] || 'Any',
                line: lineNum,
                initLine: lineNum,
                scope: 'local'
            });
        }
    }
    
    log('parsePython: Found', symbols.length, 'total symbols');
    return symbols;
}

// Helper to infer Python type from value
function inferPythonType(value) {
    if (!value) return 'Any';
    value = value.trim();
    if (value.startsWith('"') || value.startsWith("'")) return 'str';
    if (value.startsWith('[')) return 'list';
    if (value.startsWith('{')) return value.includes(':') ? 'dict' : 'set';
    if (value.startsWith('(')) return 'tuple';
    if (value === 'True' || value === 'False') return 'bool';
    if (value === 'None') return 'None';
    if (/^\d+$/.test(value)) return 'int';
    if (/^\d+\.\d+$/.test(value)) return 'float';
    return 'Any';
}

function parseCobol(content, lines) {
    const symbols = [];
    let match;
    
    // Program ID
    const progIdRegex = /PROGRAM-ID\.\s*([A-Z0-9-]+)/gi;
    while ((match = progIdRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1].toUpperCase(),  // Normalize to uppercase
            type: 'program',
            line: lineNum
        });
    }
    
    // SECTION definitions in PROCEDURE DIVISION
    const sectionRegex = /^\s{0,6}\d{0,6}\s*([A-Z0-9][A-Z0-9-]*)\s+SECTION\s*\./gim;
    while ((match = sectionRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1].trim().toUpperCase();  // Normalize to uppercase
        if (!['CONFIGURATION', 'INPUT-OUTPUT', 'FILE', 'WORKING-STORAGE', 'LOCAL-STORAGE', 'LINKAGE', 'SCREEN', 'REPORT'].includes(name)) {
            symbols.push({
                name: name,
                type: 'section',
                line: lineNum
            });
        }
    }
    
    // Paragraph definitions (names followed by period, no SECTION keyword)
    const paraRegex = /^\s{0,6}\d{0,6}\s*([A-Z][A-Z0-9-]*)\s*\.\s*$/gim;
    while ((match = paraRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1].trim().toUpperCase();  // Normalize to uppercase for COBOL
        // Skip division/section names and common keywords
        const skipNames = ['IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE', 'DIVISION', 
            'CONFIGURATION', 'INPUT-OUTPUT', 'FILE', 'WORKING-STORAGE', 'LOCAL-STORAGE', 
            'LINKAGE', 'SCREEN', 'REPORT', 'FD', 'SD', 'COPY', 'REPLACE', 'END-IF', 
            'END-PERFORM', 'END-EVALUATE', 'END-READ', 'END-WRITE', 'END-CALL'];
        if (!skipNames.includes(name) && name.length > 1) {
            symbols.push({
                name: name,
                type: 'paragraph',
                line: lineNum
            });
        }
    }
    
    // 01 level data items (records)
    const level01Regex = /^\s{0,6}\d{0,6}\s*01\s+([A-Z0-9][A-Z0-9-]*)/gim;
    while ((match = level01Regex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1].trim().toUpperCase();
        if (name !== 'FILLER') {
            symbols.push({
                name: name,
                type: 'record',
                dataType: 'GROUP',
                level: '01',
                line: lineNum,
                scope: 'global'
            });
        }
    }
    
    // 77 level data items (standalone variables)
    const level77Regex = /^\s{0,6}\d{0,6}\s*77\s+([A-Z0-9][A-Z0-9-]*)\s+(?:PIC|PICTURE)\s+([^\s.]+)/gim;
    while ((match = level77Regex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1].trim().toUpperCase(),
            type: 'variable',
            dataType: parseCobolPic(match[2]),
            level: '77',
            line: lineNum,
            scope: 'global'
        });
    }
    
    // Data items with PIC clauses (levels 02-49)
    const dataItemRegex = /^\s{0,6}\d{0,6}\s*(0[2-9]|[1-4]\d)\s+([A-Z0-9][A-Z0-9-]*)\s+(?:PIC|PICTURE)\s+([^\s.]+)/gim;
    while ((match = dataItemRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[2].trim().toUpperCase();
        if (name !== 'FILLER') {
            symbols.push({
                name: name,
                type: 'variable',
                dataType: parseCobolPic(match[3]),
                level: match[1],
                line: lineNum,
                scope: 'member'
            });
        }
    }
    
    // 88 level conditions
    const level88Regex = /^\s{0,6}\d{0,6}\s*88\s+([A-Z0-9][A-Z0-9-]*)\s+VALUE/gim;
    while ((match = level88Regex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1].trim().toUpperCase(),
            type: 'condition',
            dataType: 'BOOLEAN',
            level: '88',
            line: lineNum,
            scope: 'member'
        });
    }
    
    // COPY statements
    const copyRegex = /\bCOPY\s+([A-Z0-9][A-Z0-9-]*)/gi;
    while ((match = copyRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1].trim().toUpperCase(),  // Normalize to uppercase
            type: 'copybook',
            line: lineNum
        });
    }
    
    // File definitions (FD)
    const fdRegex = /^\s{0,6}\d{0,6}\s*FD\s+([A-Z0-9][A-Z0-9-]*)/gim;
    while ((match = fdRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1].trim().toUpperCase(),  // Normalize to uppercase
            type: 'file',
            line: lineNum
        });
    }
    
    return symbols;
}

// Helper to parse COBOL PIC clause into a readable type with precision
function parseCobolPic(pic) {
    if (!pic) return 'unknown';
    pic = pic.toUpperCase();
    
    // Extract numeric precision from PIC clause
    // e.g., PIC 9(5)V99 → DECIMAL(5,2)
    // e.g., PIC S9(7)V9(4) → DECIMAL(7,4) SIGNED
    
    const signed = pic.startsWith('S') ? 'SIGNED ' : '';
    
    if (pic.includes('V') || pic.match(/9.*\./)) {
        // Has decimal point (V = implied decimal)
        // Extract integer and decimal digits
        let intDigits = 0;
        let decDigits = 0;
        
        // Count digits before V
        const beforeV = pic.split('V')[0] || pic.split('.')[0];
        const afterV = pic.split('V')[1] || pic.split('.')[1] || '';
        
        // Parse 9(n) or 9999 patterns
        const intMatch = beforeV.match(/9\((\d+)\)|9+/g);
        if (intMatch) {
            for (const m of intMatch) {
                if (m.includes('(')) {
                    intDigits += parseInt(m.match(/\((\d+)\)/)[1]);
                } else {
                    intDigits += m.length;
                }
            }
        }
        
        const decMatch = afterV.match(/9\((\d+)\)|9+/g);
        if (decMatch) {
            for (const m of decMatch) {
                if (m.includes('(')) {
                    decDigits += parseInt(m.match(/\((\d+)\)/)[1]);
                } else {
                    decDigits += m.length;
                }
            }
        }
        
        if (pic.includes('COMP-3') || pic.includes('COMP3')) {
            return `${signed}PACKED-DECIMAL(${intDigits},${decDigits})`;
        }
        return `${signed}DECIMAL(${intDigits},${decDigits})`;
    }
    
    if (pic.match(/^S?9/)) {
        // Integer only
        let digits = 0;
        const digitMatch = pic.match(/9\((\d+)\)|9+/g);
        if (digitMatch) {
            for (const m of digitMatch) {
                if (m.includes('(')) {
                    digits += parseInt(m.match(/\((\d+)\)/)[1]);
                } else {
                    digits += m.length;
                }
            }
        }
        
        if (pic.includes('COMP-3') || pic.includes('COMP3')) {
            return `${signed}PACKED-INT(${digits})`;
        }
        if (pic.includes('COMP')) {
            return `${signed}BINARY(${digits})`;
        }
        return `${signed}NUMERIC(${digits})`;
    }
    
    if (pic.startsWith('X')) {
        const lenMatch = pic.match(/X\((\d+)\)|X+/);
        if (lenMatch) {
            const len = lenMatch[1] ? parseInt(lenMatch[1]) : lenMatch[0].length;
            return `ALPHANUMERIC(${len})`;
        }
        return 'ALPHANUMERIC';
    }
    
    if (pic.startsWith('A')) {
        const lenMatch = pic.match(/A\((\d+)\)|A+/);
        if (lenMatch) {
            const len = lenMatch[1] ? parseInt(lenMatch[1]) : lenMatch[0].length;
            return `ALPHABETIC(${len})`;
        }
        return 'ALPHABETIC';
    }
    
    return pic;
}

/**
 * Enhanced TAL Parser - Ported from Python tal_enhanced_parser.py
 * 
 * Provides comprehensive parsing of TAL (Transaction Application Language):
 * - Procedure declarations with attributes (MAIN, FORWARD, EXTERNAL, etc.)
 * - DEFINE statements (constants and macros)
 * - STRUCT definitions with field analysis
 * - LITERAL declarations
 * - Global variable declarations
 * - Call graph extraction (CALL, PCAL, function-style)
 * - Cyclomatic complexity calculation
 */

// TAL type enumeration
const TAL_TYPES = {
    INT: 'INT',
    INT16: 'INT(16)',
    INT32: 'INT(32)',
    INT64: 'INT(64)',
    STRING: 'STRING',
    REAL: 'REAL',
    REAL32: 'REAL(32)',
    REAL64: 'REAL(64)',
    FIXED: 'FIXED',
    UNSIGNED: 'UNSIGNED',
    BYTE: 'BYTE',
    CHAR: 'CHAR',
    STRUCT: 'STRUCT',
    POINTER: 'POINTER',
    UNKNOWN: 'UNKNOWN'
};

// TAL keywords for identification
const TAL_KEYWORDS = new Set([
    'PROC', 'SUBPROC', 'BEGIN', 'END', 'IF', 'THEN', 'ELSE', 'WHILE', 'DO', 'FOR',
    'TO', 'DOWNTO', 'BY', 'CASE', 'OF', 'OTHERWISE', 'CALL', 'RETURN',
    'DEFINE', 'LITERAL', 'STRUCT', 'INT', 'REAL', 'STRING', 'FIXED',
    'UNSIGNED', 'FORWARD', 'EXTERNAL', 'MAIN', 'AND', 'OR', 'NOT',
    'XOR', 'LOR', 'LAND', 'USE', 'DROP', 'ASSERT', 'SCAN', 'RSCAN',
    'STORE', 'CODE', 'STACK', 'ENTRY', 'PRIV', 'RESIDENT',
    'CALLABLE', 'VARIABLE', 'EXTENSIBLE', 'INTERRUPT', 'PRIVATE',
    'NAME', 'BLOCK', 'FILLER', 'GOTO', 'LABEL', 'PCAL'
]);

// TAL system procedures (commonly called, not defined in user code)
const TAL_SYSTEM_PROCS = new Set([
    'INITIALIZER', 'PROCESS_CREATE_', 'PROCESS_STOP_', 'FILE_OPEN_',
    'FILE_CLOSE_', 'FILE_READ_', 'FILE_WRITE_', 'READX', 'WRITEX',
    'AWAITIO', 'DELAY', 'SHIFTSTRING', 'NUMIN', 'NUMOUT', 'CONTIME',
    'DEBUG', 'ABEND', 'STOP', 'MOVERIGHT', 'MOVELEFT', 'BADDR', 'WADDR',
    '$RECEIVE', '$SEND', 'MONITORCPUS', 'MYTERM', 'MYPID'
]);

// Store last TAL parse result for call graph access
let lastTalParseResult = null;

/**
 * Parse TAL type string to normalized type
 */
function parseTalType(typeStr) {
    if (!typeStr) return TAL_TYPES.UNKNOWN;
    typeStr = typeStr.toUpperCase().trim();
    
    if (typeStr.startsWith('INT(')) {
        if (typeStr.includes('32')) return TAL_TYPES.INT32;
        if (typeStr.includes('64')) return TAL_TYPES.INT64;
        if (typeStr.includes('16')) return TAL_TYPES.INT16;
        return TAL_TYPES.INT;
    }
    if (typeStr.startsWith('REAL(')) {
        if (typeStr.includes('64')) return TAL_TYPES.REAL64;
        if (typeStr.includes('32')) return TAL_TYPES.REAL32;
        return TAL_TYPES.REAL;
    }
    if (typeStr.startsWith('UNSIGNED')) return TAL_TYPES.UNSIGNED;
    if (typeStr.startsWith('STRING')) return TAL_TYPES.STRING;
    if (typeStr.startsWith('FIXED')) return TAL_TYPES.FIXED;
    if (typeStr === 'INT') return TAL_TYPES.INT;
    if (typeStr === 'REAL') return TAL_TYPES.REAL;
    if (typeStr === 'BYTE') return TAL_TYPES.BYTE;
    
    return TAL_TYPES.UNKNOWN;
}

/**
 * Get size in bytes for a TAL type
 */
function getTalTypeSize(talType) {
    const sizes = {
        [TAL_TYPES.INT]: 2,
        [TAL_TYPES.INT16]: 2,
        [TAL_TYPES.INT32]: 4,
        [TAL_TYPES.INT64]: 8,
        [TAL_TYPES.REAL]: 4,
        [TAL_TYPES.REAL32]: 4,
        [TAL_TYPES.REAL64]: 8,
        [TAL_TYPES.STRING]: 1,
        [TAL_TYPES.FIXED]: 8,
        [TAL_TYPES.UNSIGNED]: 2,
        [TAL_TYPES.BYTE]: 1,
        [TAL_TYPES.CHAR]: 1
    };
    return sizes[talType] || 2;
}

/**
 * Remove TAL comments (! to end of line) from a line
 */
function removeTalComments(line) {
    let inString = false;
    let result = '';
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && !inString) {
            inString = true;
            result += char;
        } else if (char === '"' && inString) {
            inString = false;
            result += char;
        } else if (char === '!' && !inString) {
            // Comment starts here
            break;
        } else {
            result += char;
        }
    }
    return result;
}

/**
 * Main TAL parser function - returns symbols array for indexer compatibility
 * Also stores rich parse result in lastTalParseResult for call graph access
 */
function parseTal(content, lines) {
    const symbols = [];
    const parseResult = {
        procedures: [],
        subprocs: [],
        defines: [],
        structs: [],
        literals: [],
        globals: [],
        calls: [],
        errors: [],
        sourceLines: lines ? lines.length : content.split('\n').length
    };
    
    const sourceLines = content.split('\n');
    
    // Parse in order: defines, literals, structs, globals, procedures
    parseTalDefines(content, sourceLines, symbols, parseResult);
    parseTalLiterals(content, sourceLines, symbols, parseResult);
    parseTalStructs(content, sourceLines, symbols, parseResult);
    parseTalGlobals(content, sourceLines, symbols, parseResult);
    parseTalProcedures(content, sourceLines, symbols, parseResult);
    parseTalSubprocs(content, sourceLines, symbols, parseResult);
    parseTalCalls(content, sourceLines, parseResult);
    
    // Calculate complexity for each procedure
    for (const proc of parseResult.procedures) {
        if (proc.bodyText) {
            proc.complexity = calculateTalComplexity(proc.bodyText);
        }
    }
    
    // Build call relationships
    buildTalCallRelationships(parseResult);
    
    // Store for call graph access
    lastTalParseResult = parseResult;
    
    log('parseTal: Found', symbols.length, 'symbols,', 
        parseResult.procedures.length, 'procedures,',
        parseResult.calls.length, 'calls');
    
    return symbols;
}

/**
 * Parse DEFINE statements
 */
function parseTalDefines(content, lines, symbols, parseResult) {
    let currentDefine = null;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const cleanLine = removeTalComments(line).trim();
        
        if (!cleanLine) continue;
        
        // Check for DEFINE start
        const defineMatch = cleanLine.match(
            /^DEFINE\s+([a-zA-Z_][a-zA-Z0-9_^]*)(?:\s*\(([^)]*)\))?\s*=\s*(.*)$/i
        );
        
        if (defineMatch) {
            const name = defineMatch[1];
            const paramsStr = defineMatch[2];
            let value = defineMatch[3].trim();
            
            const params = paramsStr ? 
                paramsStr.split(',').map(p => p.trim()).filter(p => p) : [];
            
            // Check if value ends with terminator
            if (value.endsWith(';') || value.endsWith('#')) {
                value = value.slice(0, -1).trim();
                
                const defineInfo = {
                    name: name,
                    value: value,
                    params: params,
                    isMacro: params.length > 0,
                    line: lineNum + 1
                };
                parseResult.defines.push(defineInfo);
                
                symbols.push({
                    name: name,
                    type: params.length > 0 ? 'macro' : 'define',
                    value: value.substring(0, 100),
                    params: params,
                    line: lineNum + 1
                });
            } else {
                // Multi-line define
                currentDefine = {
                    name: name,
                    params: params,
                    valueParts: [value],
                    startLine: lineNum + 1
                };
            }
        } else if (currentDefine) {
            // Continuation of multi-line define
            if (cleanLine.endsWith(';') || cleanLine.endsWith('#')) {
                currentDefine.valueParts.push(cleanLine.slice(0, -1).trim());
                
                const fullValue = currentDefine.valueParts.join(' ');
                const defineInfo = {
                    name: currentDefine.name,
                    value: fullValue,
                    params: currentDefine.params,
                    isMacro: currentDefine.params.length > 0,
                    line: currentDefine.startLine
                };
                parseResult.defines.push(defineInfo);
                
                symbols.push({
                    name: currentDefine.name,
                    type: currentDefine.params.length > 0 ? 'macro' : 'define',
                    value: fullValue.substring(0, 100),
                    params: currentDefine.params,
                    line: currentDefine.startLine
                });
                
                currentDefine = null;
            } else {
                currentDefine.valueParts.push(cleanLine);
            }
        }
    }
}

/**
 * Parse LITERAL declarations
 */
function parseTalLiterals(content, lines, symbols, parseResult) {
    let inLiteral = false;
    let literalText = [];
    let startLine = 0;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const cleanLine = removeTalComments(line).trim();
        
        if (!cleanLine) continue;
        
        if (/^\s*LITERAL\b/i.test(cleanLine)) {
            inLiteral = true;
            startLine = lineNum + 1;
            // Remove LITERAL keyword
            literalText = [cleanLine.replace(/^\s*LITERAL\s*/i, '')];
        } else if (inLiteral) {
            literalText.push(cleanLine);
        }
        
        // Check for terminator
        if (inLiteral && (cleanLine.endsWith(';') || cleanLine.endsWith('#'))) {
            let fullText = literalText.join(' ');
            if (fullText.endsWith(';') || fullText.endsWith('#')) {
                fullText = fullText.slice(0, -1);
            }
            
            // Parse individual literals: name = value, name2 = value2
            const parts = splitTalDeclarations(fullText);
            for (const part of parts) {
                const match = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_^]*)\s*=\s*(.+)$/);
                if (match) {
                    const name = match[1];
                    const valueStr = match[2].trim();
                    
                    let literalType = TAL_TYPES.INT;
                    let value = valueStr;
                    
                    // Determine type and parse value
                    if (valueStr.startsWith('"')) {
                        literalType = TAL_TYPES.STRING;
                        value = valueStr.replace(/^"|"$/g, '');
                    } else if (/^-?\d+$/.test(valueStr)) {
                        value = parseInt(valueStr, 10);
                    } else if (/^%H[0-9A-Fa-f]+$/i.test(valueStr)) {
                        value = parseInt(valueStr.substring(2), 16);
                    } else if (/^%B[01]+$/i.test(valueStr)) {
                        value = parseInt(valueStr.substring(2), 2);
                    } else if (/^%[0-7]+$/.test(valueStr)) {
                        value = parseInt(valueStr.substring(1), 8);
                    } else if (/^-?\d+\.\d*$/.test(valueStr)) {
                        literalType = TAL_TYPES.REAL;
                        value = parseFloat(valueStr);
                    }
                    
                    parseResult.literals.push({
                        name: name,
                        value: value,
                        literalType: literalType,
                        line: startLine
                    });
                    
                    symbols.push({
                        name: name,
                        type: 'literal',
                        value: value,
                        dataType: literalType,
                        line: startLine
                    });
                }
            }
            
            inLiteral = false;
            literalText = [];
        }
    }
}

/**
 * Parse STRUCT definitions
 */
function parseTalStructs(content, lines, symbols, parseResult) {
    let inStruct = false;
    let structLines = [];
    let structName = '';
    let startLine = 0;
    let structDepth = 0;
    let hasBegin = false;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const cleanLine = removeTalComments(line).trim();
        
        if (!cleanLine) continue;
        
        // Check for STRUCT start (not inside a procedure)
        const structMatch = cleanLine.match(/^STRUCT\s+([.*a-zA-Z_][a-zA-Z0-9_^]*)/i);
        
        if (structMatch && !inStruct) {
            inStruct = true;
            structName = structMatch[1];
            startLine = lineNum + 1;
            structLines = [cleanLine];
            structDepth = 0;
            hasBegin = false;
            
            // Check if it's a struct pointer/reference like "STRUCT .ptr(other);"
            if (/\([^)]+\)\s*;?\s*$/.test(cleanLine)) {
                const structInfo = parseTalStructDefinition(structName, structLines.join('\n'), startLine);
                if (structInfo) {
                    parseResult.structs.push(structInfo);
                    symbols.push({
                        name: structInfo.name,
                        type: 'struct',
                        fields: structInfo.fields.length,
                        totalSize: structInfo.totalSize,
                        isReferral: structInfo.isReferral,
                        line: startLine
                    });
                }
                inStruct = false;
                structLines = [];
            }
        } else if (inStruct) {
            structLines.push(cleanLine);
            
            // Track BEGIN
            if (/\bBEGIN\b/i.test(cleanLine)) {
                structDepth++;
                hasBegin = true;
            }
            
            // Track END
            if (/\bEND\b/i.test(cleanLine)) {
                structDepth--;
                if (structDepth === 0 && hasBegin) {
                    const structText = structLines.join('\n');
                    const structInfo = parseTalStructDefinition(structName, structText, startLine);
                    if (structInfo) {
                        parseResult.structs.push(structInfo);
                        symbols.push({
                            name: structInfo.name,
                            type: 'struct',
                            fields: structInfo.fields.length,
                            totalSize: structInfo.totalSize,
                            isReferral: structInfo.isReferral,
                            line: startLine
                        });
                    }
                    inStruct = false;
                    structLines = [];
                    hasBegin = false;
                }
            }
        }
    }
}

/**
 * Parse a single STRUCT definition
 */
function parseTalStructDefinition(name, text, startLine) {
    const isReferral = name.startsWith('.');
    const isTemplate = name === '*';
    const cleanName = name.replace(/^[.*]+/, '');
    
    const structInfo = {
        name: cleanName,
        fields: [],
        totalSize: 0,
        isReferral: isReferral,
        isTemplate: isTemplate,
        line: startLine
    };
    
    const lines = text.split('\n');
    let currentOffset = 0;
    
    for (let i = 1; i < lines.length; i++) { // Skip STRUCT declaration line
        let line = removeTalComments(lines[i]).trim();
        if (!line || /^END\b/i.test(line)) continue;
        if (line.endsWith(';')) line = line.slice(0, -1).trim();
        if (!line || line.toUpperCase() === 'BEGIN') continue;
        
        // Parse field: TYPE name or TYPE name[bounds]
        const fieldMatch = line.match(
            /^(INT(?:\([^)]*\))?|REAL(?:\([^)]*\))?|STRING(?:\([^)]*\))?|FIXED(?:\([^)]*\))?|UNSIGNED(?:\([^)]*\))?|STRUCT|FILLER|BEGIN)\s*([.*a-zA-Z_][a-zA-Z0-9_^]*)?\s*(?:\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\])?/i
        );
        
        if (fieldMatch) {
            const fieldTypeStr = fieldMatch[1];
            const fieldName = fieldMatch[2];
            const arrayStart = fieldMatch[3];
            const arrayEnd = fieldMatch[4];
            
            if (!fieldName) continue;
            
            const field = {
                name: fieldName.replace(/^[.*]+/, ''),
                fieldType: parseTalType(fieldTypeStr),
                offset: currentOffset,
                size: 0,
                isArray: false,
                arrayBounds: null,
                isPointer: fieldName.startsWith('.'),
                isFiller: fieldName.toUpperCase() === 'FILLER' || fieldTypeStr.toUpperCase() === 'FILLER'
            };
            
            // Handle arrays
            if (arrayStart !== undefined && arrayEnd !== undefined) {
                field.isArray = true;
                field.arrayBounds = [parseInt(arrayStart), parseInt(arrayEnd)];
            }
            
            // Calculate size
            field.size = getTalTypeSize(field.fieldType);
            if (field.isArray && field.arrayBounds) {
                field.size *= (field.arrayBounds[1] - field.arrayBounds[0] + 1);
            }
            
            structInfo.fields.push(field);
            currentOffset += field.size;
        }
    }
    
    structInfo.totalSize = currentOffset;
    return structInfo;
}

/**
 * Parse global variable declarations
 */
function parseTalGlobals(content, lines, symbols, parseResult) {
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const cleanLine = removeTalComments(line).trim();
        
        if (!cleanLine) continue;
        
        // Skip known declaration types
        if (/^\s*(DEFINE|LITERAL|STRUCT|PROC|SUBPROC)\b/i.test(cleanLine)) continue;
        
        // Look for variable declarations: TYPE name, name2;
        const varMatch = cleanLine.match(
            /^(INT(?:\([^)]*\))?|REAL(?:\([^)]*\))?|STRING(?:\([^)]*\))?|FIXED(?:\([^)]*\))?|UNSIGNED(?:\([^)]*\))?)\s+(.+?)\s*;/i
        );
        
        if (varMatch) {
            const varTypeStr = varMatch[1];
            const varNames = varMatch[2];
            const varType = parseTalType(varTypeStr);
            
            // Check if we're inside a procedure
            const before = content.substring(0, content.indexOf(line));
            const procCount = (before.match(/\bPROC\b/gi) || []).length;
            const endCount = (before.match(/\bEND\s*;/gi) || []).length;
            const isGlobal = procCount <= endCount;
            
            if (!isGlobal) continue;
            
            // Parse each variable name
            for (let varPart of varNames.split(',')) {
                varPart = varPart.trim();
                if (!varPart) continue;
                
                // Check for array syntax [start:end]
                const arrayMatch = varPart.match(
                    /^([.*a-zA-Z_][a-zA-Z0-9_^]*)\s*\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]/
                );
                
                let varName, arrayBounds = null, isArray = false;
                if (arrayMatch) {
                    varName = arrayMatch[1];
                    arrayBounds = [parseInt(arrayMatch[2]), parseInt(arrayMatch[3])];
                    isArray = true;
                } else {
                    varName = varPart;
                }
                
                const globalInfo = {
                    name: varName.replace(/^[.*]+/, ''),
                    varType: varType,
                    isArray: isArray,
                    arrayBounds: arrayBounds,
                    isPointer: varName.startsWith('.'),
                    line: lineNum + 1
                };
                parseResult.globals.push(globalInfo);
                
                symbols.push({
                    name: globalInfo.name,
                    type: 'variable',
                    dataType: varType + (isArray ? '[]' : ''),
                    isArray: isArray,
                    isPointer: globalInfo.isPointer,
                    line: lineNum + 1,
                    scope: 'global'
                });
            }
        }
    }
}

/**
 * Parse procedure declarations
 */
function parseTalProcedures(content, lines, symbols, parseResult) {
    // Find all PROC declarations with their full signatures
    const procRegex = /(?:(INT(?:\([^)]*\))?|REAL(?:\([^)]*\))?|STRING|FIXED|UNSIGNED(?:\([^)]*\))?)\s+)?PROC\s+([a-zA-Z_][a-zA-Z0-9_^]*)\s*(?:\(([^)]*)\))?/gi;
    
    let match;
    const procStarts = [];
    
    while ((match = procRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        procStarts.push({
            index: match.index,
            returnType: match[1] || null,
            name: match[2],
            paramsStr: match[3] || '',
            line: lineNum
        });
    }
    
    // Sort by position
    procStarts.sort((a, b) => a.index - b.index);
    
    // Process each procedure
    for (let i = 0; i < procStarts.length; i++) {
        const proc = procStarts[i];
        
        // Find the declaration line for attributes
        const declStart = proc.index;
        const declEnd = content.indexOf(';', declStart);
        const declaration = declEnd > 0 ? content.substring(declStart, declEnd + 1) : '';
        
        // Check for attributes
        const isMain = /\bMAIN\b/i.test(declaration);
        const isForward = /\bFORWARD\b/i.test(declaration);
        const isExternal = /\bEXTERNAL\b/i.test(declaration);
        const isInterrupt = /\bINTERRUPT\b/i.test(declaration);
        const isResident = /\bRESIDENT\b/i.test(declaration);
        const isPrivate = /\bPRIVATE\b/i.test(declaration);
        
        const attributes = [];
        if (isMain) attributes.push('MAIN');
        if (isForward) attributes.push('FORWARD');
        if (isExternal) attributes.push('EXTERNAL');
        if (isInterrupt) attributes.push('INTERRUPT');
        if (isResident) attributes.push('RESIDENT');
        if (isPrivate) attributes.push('PRIVATE');
        
        // Parse parameters
        const parameters = [];
        if (proc.paramsStr) {
            for (const param of proc.paramsStr.split(',')) {
                const paramName = param.trim();
                if (paramName) {
                    parameters.push({
                        name: paramName.replace(/^[.*]+/, ''),
                        type: TAL_TYPES.UNKNOWN,
                        isPointer: paramName.startsWith('.')
                    });
                }
            }
        }
        
        // Find procedure body boundaries
        let bodyStartLine = 0;
        let bodyEndLine = 0;
        let bodyText = '';
        
        if (!isForward && !isExternal) {
            // Find end boundary (next PROC or end of file)
            const nextProcIndex = i + 1 < procStarts.length ? procStarts[i + 1].index : content.length;
            const procSection = content.substring(declStart, nextProcIndex);
            
            // Find first BEGIN
            const beginMatch = /\bBEGIN\b/i.exec(procSection);
            if (beginMatch) {
                bodyStartLine = content.substring(0, declStart + beginMatch.index).split('\n').length;
                
                // Find matching END;
                let depth = 0;
                const procLines = procSection.split('\n');
                let foundEnd = false;
                
                for (let j = 0; j < procLines.length; j++) {
                    const line = removeTalComments(procLines[j]).toUpperCase();
                    if (/\bBEGIN\b/.test(line)) depth++;
                    if (/\bEND\s*;/.test(line)) {
                        depth--;
                        if (depth === 0) {
                            bodyEndLine = proc.line + j;
                            bodyText = procLines.slice(0, j + 1).join('\n');
                            foundEnd = true;
                            break;
                        }
                    }
                }
                
                if (!foundEnd) {
                    bodyEndLine = proc.line + procLines.length - 1;
                    bodyText = procSection;
                }
            }
        }
        
        const procDetail = {
            name: proc.name,
            returnType: proc.returnType ? parseTalType(proc.returnType) : null,
            parameters: parameters,
            localVars: [],
            subprocs: [],
            calls: [],
            calledBy: [],
            attributes: attributes,
            isMain: isMain,
            isForward: isForward,
            isExternal: isExternal,
            isInterrupt: isInterrupt,
            isResident: isResident,
            bodyText: bodyText,
            bodyStartLine: bodyStartLine,
            bodyEndLine: bodyEndLine,
            complexity: 1,
            line: proc.line
        };
        
        // Parse local variables from body
        if (bodyText) {
            parseTalLocalVariables(bodyText, procDetail);
        }
        
        parseResult.procedures.push(procDetail);
        
        // Add to symbols
        symbols.push({
            name: proc.name,
            type: isForward ? 'forward' : (isExternal ? 'external' : 'procedure'),
            returnType: proc.returnType || null,
            params: proc.paramsStr,
            parameters: parameters,
            attributes: attributes,
            isMain: isMain,
            complexity: procDetail.complexity,
            line: proc.line,
            bodyStartLine: bodyStartLine,
            bodyEndLine: bodyEndLine,
            signature: `${proc.returnType ? proc.returnType + ' ' : ''}PROC ${proc.name}(${proc.paramsStr})`
        });
    }
}

/**
 * Parse local variable declarations from procedure body
 */
function parseTalLocalVariables(bodyText, procDetail) {
    const lines = bodyText.split('\n');
    
    for (const line of lines) {
        const cleanLine = removeTalComments(line).trim();
        if (!cleanLine) continue;
        
        // Stop at first executable statement
        if (/^(IF|WHILE|FOR|CALL|CASE|RETURN)\b/i.test(cleanLine)) break;
        
        // Look for type declarations
        const varMatch = cleanLine.match(
            /^(INT(?:\([^)]*\))?|REAL(?:\([^)]*\))?|STRING(?:\([^)]*\))?|FIXED(?:\([^)]*\))?|UNSIGNED(?:\([^)]*\))?)\s+(.+?)\s*;/i
        );
        
        if (varMatch) {
            const typeStr = varMatch[1];
            const namesStr = varMatch[2];
            
            for (let name of namesStr.split(',')) {
                name = name.trim();
                if (!name) continue;
                
                // Check for array
                const arrayMatch = name.match(/^([.*a-zA-Z_][a-zA-Z0-9_^]*)\s*\[/);
                const varName = arrayMatch ? arrayMatch[1] : name;
                
                procDetail.localVars.push({
                    name: varName.replace(/^[.*]+/, ''),
                    type: typeStr.toUpperCase(),
                    isPointer: varName.startsWith('.')
                });
            }
        }
    }
}

/**
 * Parse SUBPROC declarations
 */
function parseTalSubprocs(content, lines, symbols, parseResult) {
    let currentProc = null;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const cleanLine = removeTalComments(line).trim();
        
        // Track current procedure
        const procMatch = cleanLine.match(/\bPROC\s+([a-zA-Z_][a-zA-Z0-9_^]*)/i);
        if (procMatch) {
            currentProc = procMatch[1];
            continue;
        }
        
        if (!currentProc) continue;
        
        // Find SUBPROC declarations
        const subprocMatch = cleanLine.match(
            /^(?:(INT(?:\([^)]*\))?|REAL(?:\([^)]*\))?|STRING|FIXED|UNSIGNED(?:\([^)]*\))?)\s+)?SUBPROC\s+([a-zA-Z_][a-zA-Z0-9_^]*)/i
        );
        
        if (subprocMatch) {
            const returnTypeStr = subprocMatch[1];
            const subprocName = subprocMatch[2];
            
            const subprocInfo = {
                name: subprocName,
                parentProc: currentProc,
                returnType: returnTypeStr ? parseTalType(returnTypeStr) : null,
                parameters: [],
                line: lineNum + 1
            };
            parseResult.subprocs.push(subprocInfo);
            
            // Track in parent procedure
            const parentProc = parseResult.procedures.find(p => p.name === currentProc);
            if (parentProc) {
                parentProc.subprocs.push(subprocName);
            }
            
            symbols.push({
                name: subprocName,
                type: 'subproc',
                parentProc: currentProc,
                returnType: returnTypeStr || null,
                line: lineNum + 1
            });
        }
    }
}

/**
 * Extract all procedure calls from the source
 */
function parseTalCalls(content, lines, parseResult) {
    let currentProc = null;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const cleanLine = removeTalComments(line).trim();
        
        // Track current procedure
        const procMatch = cleanLine.match(/\bPROC\s+([a-zA-Z_][a-zA-Z0-9_^]*)/i);
        if (procMatch) {
            currentProc = procMatch[1];
            continue;
        }
        
        if (!currentProc) continue;
        
        // Find CALL statements
        const callRegex = /\bCALL\s+([a-zA-Z_][a-zA-Z0-9_^]*)\s*(?:\(([^)]*)\))?/gi;
        let callMatch;
        while ((callMatch = callRegex.exec(cleanLine)) !== null) {
            const callee = callMatch[1];
            const argsStr = callMatch[2] || '';
            const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(a => a) : [];
            
            parseResult.calls.push({
                callee: callee,
                caller: currentProc,
                arguments: args,
                callType: 'CALL',
                line: lineNum + 1
            });
        }
        
        // Find PCAL statements (privileged call)
        const pcalRegex = /\bPCAL\s+([a-zA-Z_][a-zA-Z0-9_^]*)\s*(?:\(([^)]*)\))?/gi;
        let pcalMatch;
        while ((pcalMatch = pcalRegex.exec(cleanLine)) !== null) {
            const callee = pcalMatch[1];
            const argsStr = pcalMatch[2] || '';
            const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(a => a) : [];
            
            parseResult.calls.push({
                callee: callee,
                caller: currentProc,
                arguments: args,
                callType: 'PCAL',
                line: lineNum + 1
            });
        }
        
        // Find function-style calls: name(args) - but exclude CALL/PCAL already captured
        const funcCallRegex = /(?<![a-zA-Z0-9_])([a-zA-Z_][a-zA-Z0-9_^]*)\s*\(([^)]*)\)/g;
        let funcMatch;
        while ((funcMatch = funcCallRegex.exec(cleanLine)) !== null) {
            const potentialCallee = funcMatch[1];
            
            // Skip keywords, types, current procedure
            if (TAL_KEYWORDS.has(potentialCallee.toUpperCase())) continue;
            if (potentialCallee === currentProc) continue;
            
            // Skip if preceded by CALL/PCAL
            const beforePos = funcMatch.index;
            const prefix = cleanLine.substring(0, beforePos).trim().toUpperCase();
            if (prefix.endsWith('CALL') || prefix.endsWith('PCAL')) continue;
            
            // Skip if it looks like an array access
            if (/^[a-zA-Z_][a-zA-Z0-9_^]*\s*\[/.test(cleanLine.substring(funcMatch.index))) continue;
            
            const argsStr = funcMatch[2] || '';
            const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(a => a) : [];
            
            parseResult.calls.push({
                callee: potentialCallee,
                caller: currentProc,
                arguments: args,
                callType: 'function',
                line: lineNum + 1
            });
        }
    }
}

/**
 * Build call relationships between procedures
 */
function buildTalCallRelationships(parseResult) {
    // Build reverse lookup: callee -> [callers]
    const reverseCalls = new Map();
    for (const call of parseResult.calls) {
        if (!reverseCalls.has(call.callee)) {
            reverseCalls.set(call.callee, []);
        }
        if (!reverseCalls.get(call.callee).includes(call.caller)) {
            reverseCalls.get(call.callee).push(call.caller);
        }
    }
    
    // Update procedure details
    for (const proc of parseResult.procedures) {
        proc.calls = parseResult.calls.filter(c => c.caller === proc.name);
        proc.calledBy = reverseCalls.get(proc.name) || [];
    }
}

/**
 * Calculate cyclomatic complexity of procedure body
 */
function calculateTalComplexity(bodyText) {
    let complexity = 1; // Base complexity
    
    // Remove strings to avoid false matches
    const cleanBody = bodyText.replace(/"[^"]*"/g, '""');
    
    // Count decision points
    const decisionPatterns = [
        /\bIF\b/gi,           // IF statements
        /\bWHILE\b/gi,        // WHILE loops
        /\bFOR\b/gi,          // FOR loops
        /\bCASE\b/gi,         // CASE statements
        /\bAND\b/gi,          // Compound conditions
        /\bOR\b/gi,           // Compound conditions
        /\bLAND\b/gi,         // Logical AND
        /\bLOR\b/gi           // Logical OR
    ];
    
    for (const pattern of decisionPatterns) {
        const matches = cleanBody.match(pattern);
        if (matches) {
            complexity += matches.length;
        }
    }
    
    return complexity;
}

/**
 * Split declarations by comma, handling nested parentheses
 */
function splitTalDeclarations(text) {
    const parts = [];
    let current = '';
    let depth = 0;
    
    for (const char of text) {
        if (char === '(') {
            depth++;
            current += char;
        } else if (char === ')') {
            depth--;
            current += char;
        } else if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    if (current.trim()) {
        parts.push(current.trim());
    }
    
    return parts;
}

function parseGo(content, lines) {
    const symbols = [];
    
    // Function definitions
    const funcRegex = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/gm;
    let match;
    
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'function',
            params: match[2].trim(),
            line: lineNum
        });
    }
    
    // Type definitions
    const typeRegex = /^type\s+(\w+)\s+(?:struct|interface)/gm;
    while ((match = typeRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'struct',
            line: lineNum
        });
    }
    
    return symbols;
}

function parseRust(content, lines) {
    const symbols = [];
    
    // Function definitions
    const funcRegex = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/gm;
    let match;
    
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'function',
            params: match[2].trim(),
            line: lineNum
        });
    }
    
    // Struct definitions
    const structRegex = /^\s*(?:pub\s+)?struct\s+(\w+)/gm;
    while ((match = structRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'struct',
            line: lineNum
        });
    }
    
    // Impl blocks
    const implRegex = /^\s*impl(?:<[^>]+>)?\s+(\w+)/gm;
    while ((match = implRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'impl',
            line: lineNum
        });
    }
    
    return symbols;
}

function parseCSharp(content, lines) {
    const symbols = [];
    let match;
    
    // Namespace
    const nsRegex = /^\s*namespace\s+([\w.]+)/gm;
    while ((match = nsRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'namespace',
            line: lineNum
        });
    }
    
    // Class, interface, struct, enum definitions
    const classRegex = /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:abstract\s+)?(?:sealed\s+)?(?:partial\s+)?(class|interface|struct|enum|record)\s+(\w+)(?:<[^>]+>)?/gm;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[2],
            type: match[1],
            line: lineNum
        });
    }
    
    // Method definitions
    const methodRegex = /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:async\s+)?(?:[\w<>\[\],\s]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:where\s+[^{]+)?(?:\{|=>)/gm;
    while ((match = methodRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1];
        // Skip common keywords
        if (!['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new', 'throw'].includes(name)) {
            symbols.push({
                name: name,
                type: 'method',
                params: match[2].trim(),
                line: lineNum,
                signature: `${name}(${match[2].trim()})`
            });
        }
    }
    
    // Properties
    const propRegex = /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:[\w<>\[\],\s]+)\s+(\w+)\s*\{\s*(?:get|set)/gm;
    while ((match = propRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'property',
            line: lineNum
        });
    }
    
    // Events
    const eventRegex = /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?event\s+[\w<>]+\s+(\w+)/gm;
    while ((match = eventRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'event',
            line: lineNum
        });
    }
    
    // Delegates
    const delegateRegex = /^\s*(?:public|private|protected|internal)?\s*delegate\s+[\w<>]+\s+(\w+)\s*\(/gm;
    while ((match = delegateRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'delegate',
            line: lineNum
        });
    }
    
    return symbols;
}

function parseSQL(content, lines) {
    const symbols = [];
    let match;
    
    // Stored Procedures
    const procRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?PROC(?:EDURE)?\s+(?:[\w.]+\.)?(\w+)/gi;
    while ((match = procRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'procedure',
            line: lineNum
        });
    }
    
    // Functions
    const funcRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?FUNCTION\s+(?:[\w.]+\.)?(\w+)/gi;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'function',
            line: lineNum
        });
    }
    
    // Views
    const viewRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:[\w.]+\.)?(\w+)/gi;
    while ((match = viewRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'view',
            line: lineNum
        });
    }
    
    // Tables
    const tableRegex = /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w.]+\.)?(\w+)/gi;
    while ((match = tableRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'table',
            line: lineNum
        });
    }
    
    // Triggers
    const triggerRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:[\w.]+\.)?(\w+)/gi;
    while ((match = triggerRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'trigger',
            line: lineNum
        });
    }
    
    // Indexes
    const indexRegex = /CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+)?(?:NONCLUSTERED\s+)?INDEX\s+(?:[\w.]+\.)?(\w+)/gi;
    while ((match = indexRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'index',
            line: lineNum
        });
    }
    
    // Packages (Oracle/PL-SQL)
    const pkgRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?(?:[\w.]+\.)?(\w+)/gi;
    while ((match = pkgRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'package',
            line: lineNum
        });
    }
    
    // CTEs (Common Table Expressions) - WITH clause
    const cteRegex = /\bWITH\s+(\w+)\s+AS\s*\(/gi;
    while ((match = cteRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'cte',
            line: lineNum
        });
    }
    
    return symbols;
}

function parseGeneric(content, lines) {
    const symbols = [];
    let match;
    
    // Generic function-like patterns
    const funcRegex = /(?:function|def|fn|func|proc|sub|method)\s+(\w+)/gi;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'function',
            line: lineNum
        });
    }
    
    // Generic class-like patterns
    const classRegex = /(?:class|struct|interface|type|enum)\s+(\w+)/gi;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'class',
            line: lineNum
        });
    }
    
    // Generic constant patterns (ALL_CAPS = value)
    const constRegex = /^([A-Z][A-Z0-9_]{2,})\s*[:=]/gm;
    while ((match = constRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'constant',
            line: lineNum
        });
    }
    
    // Generic variable patterns (type name or var/let/const name)
    const varRegex = /(?:var|let|const|dim|local|global|int|string|bool|float|double)\s+(\w+)/gi;
    while ((match = varRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: 'variable',
            line: lineNum
        });
    }
    
    return symbols;
}

/**
 * Find function calls within a function body
 */
function findFunctionCalls(content, symbol, language) {
    const calls = [];
    const lines = content.split('\n');
    let functionBody = '';
    
    // COBOL needs special handling - paragraphs don't have braces
    if (language === 'cobol') {
        log('findFunctionCalls COBOL:', symbol.name, 'type:', symbol.type, 'line:', symbol.line);
        
        // For COBOL, we need to find the paragraph body which runs until the next paragraph
        const startLine = symbol.line - 1;
        const symbolType = symbol.type;
        
        if (symbolType === 'paragraph' || symbolType === 'section') {
            // Find the end of this paragraph (next paragraph/section or end of procedure division)
            // COBOL paragraph: starts in column 8-11, name followed by period
            const paragraphEndRegex = /^\s{0,6}\d{0,6}\s{1,4}[A-Z][A-Z0-9-]*\s*(?:SECTION)?\s*\.\s*$/;
            
            for (let i = startLine + 1; i < lines.length; i++) {
                const line = lines[i];
                
                // Check if we've hit another paragraph/section definition
                if (paragraphEndRegex.test(line)) {
                    log('  Paragraph end at line', i + 1, ':', line.trim().substring(0, 30));
                    break;
                }
                
                // Check if we've hit end of procedure division or program
                if (/^\s{0,6}\d{0,6}\s*(?:END\s+PROGRAM|IDENTIFICATION\s+DIVISION)/i.test(line)) {
                    break;
                }
                
                functionBody += line + '\n';
                
                if (i - startLine > 500) break; // Safety limit
            }
            
            log('  Paragraph body length:', functionBody.length, 'chars');
            
        } else if (symbolType === 'program') {
            // For the program itself, search the entire PROCEDURE DIVISION
            let inProcedure = false;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/PROCEDURE\s+DIVISION/i.test(line)) {
                    inProcedure = true;
                    log('  Found PROCEDURE DIVISION at line', i + 1);
                    continue;
                }
                if (inProcedure) {
                    if (/^\s{0,6}\d{0,6}\s*END\s+PROGRAM/i.test(line)) {
                        break;
                    }
                    functionBody += line + '\n';
                }
            }
            log('  Program procedure body length:', functionBody.length, 'chars');
        }
        
        // Extract COBOL calls from the body
        let match;
        
        // PERFORM paragraph/section (handles PERFORM ... THRU ...)
        const performRegex = /PERFORM\s+([A-Z0-9][A-Z0-9-]*)(?:\s+(?:THRU|THROUGH)\s+([A-Z0-9][A-Z0-9-]*))?/gi;
        while ((match = performRegex.exec(functionBody)) !== null) {
            const name = match[1].toUpperCase();
            if (!['UNTIL', 'VARYING', 'TIMES', 'WITH', 'TEST', 'BEFORE', 'AFTER'].includes(name)) {
                log('  Found PERFORM:', name);
                calls.push(name);
                if (match[2]) {
                    log('  Found PERFORM THRU:', match[2].toUpperCase());
                    calls.push(match[2].toUpperCase());
                }
            }
        }
        
        // CALL external program (with or without quotes)
        const cobolCallRegex = /CALL\s+['"]?([A-Z0-9][A-Z0-9-]*)['"]?/gi;
        while ((match = cobolCallRegex.exec(functionBody)) !== null) {
            log('  Found CALL:', match[1].toUpperCase());
            calls.push(match[1].toUpperCase());
        }
        
        // GO TO paragraph
        const gotoRegex = /GO\s+TO\s+([A-Z0-9][A-Z0-9-]*)/gi;
        while ((match = gotoRegex.exec(functionBody)) !== null) {
            log('  Found GO TO:', match[1].toUpperCase());
            calls.push(match[1].toUpperCase());
        }
        
        // COPY copybook reference
        const copyRegex = /COPY\s+([A-Z0-9][A-Z0-9-]*)/gi;
        while ((match = copyRegex.exec(functionBody)) !== null) {
            log('  Found COPY:', match[1].toUpperCase());
            calls.push(match[1].toUpperCase());
        }
        
        log('  Total calls found for', symbol.name, ':', calls.length);
        return [...new Set(calls)]; // Deduplicate
    }
    
    // TAL needs special handling - similar to COBOL, uses BEGIN/END blocks
    if (language === 'tal') {
        log('findFunctionCalls TAL:', symbol.name, 'type:', symbol.type, 'line:', symbol.line);
        
        const startLine = symbol.line - 1;
        const symbolType = symbol.type;
        
        if (symbolType === 'procedure' || symbolType === 'subproc') {
            // Find procedure body between BEGIN and matching END;
            let depth = 0;
            let foundBegin = false;
            
            for (let i = startLine; i < lines.length; i++) {
                const line = removeTalComments(lines[i]);
                const upperLine = line.toUpperCase();
                
                // Count BEGIN/END
                if (/\bBEGIN\b/.test(upperLine)) {
                    depth++;
                    foundBegin = true;
                }
                if (/\bEND\s*;/.test(upperLine) || /\bEND\s*$/.test(upperLine)) {
                    depth--;
                    if (depth <= 0 && foundBegin) {
                        functionBody += line + '\n';
                        break;
                    }
                }
                
                if (foundBegin) {
                    functionBody += line + '\n';
                }
                
                if (i - startLine > 500) break; // Safety limit
            }
            
            log('  TAL procedure body length:', functionBody.length, 'chars');
        }
        
        // Extract TAL calls from the body
        let match;
        
        // CALL statements
        const talCallRegex = /\bCALL\s+([a-zA-Z_][a-zA-Z0-9_^]*)/gi;
        while ((match = talCallRegex.exec(functionBody)) !== null) {
            log('  Found CALL:', match[1]);
            calls.push(match[1]);
        }
        
        // PCAL statements (privileged call)
        const talPcalRegex = /\bPCAL\s+([a-zA-Z_][a-zA-Z0-9_^]*)/gi;
        while ((match = talPcalRegex.exec(functionBody)) !== null) {
            log('  Found PCAL:', match[1]);
            calls.push(match[1]);
        }
        
        // Function-style calls: name(args) - exclude keywords
        const talFuncRegex = /\b([a-zA-Z_][a-zA-Z0-9_^]*)\s*\(/g;
        while ((match = talFuncRegex.exec(functionBody)) !== null) {
            const name = match[1];
            const upperName = name.toUpperCase();
            // Skip TAL keywords and current procedure
            if (!TAL_KEYWORDS.has(upperName) && name !== symbol.name) {
                // Check if preceded by CALL/PCAL (already captured)
                const before = functionBody.substring(0, match.index).trim().toUpperCase();
                if (!before.endsWith('CALL') && !before.endsWith('PCAL')) {
                    log('  Found function call:', name);
                    calls.push(name);
                }
            }
        }
        
        log('  Total TAL calls found for', symbol.name, ':', calls.length);
        return [...new Set(calls)]; // Deduplicate
    }
    
    // Non-COBOL/TAL languages - use brace/block detection
    let startLine = symbol.line - 1;
    let braceCount = 0;
    let inFunction = false;
    
    // Language-specific body detection
    const bodyStart = language === 'tal' ? /^/ :
                      language === 'python' ? /:\s*$/ :
                      /\{|BEGIN/i;
    
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        
        if (!inFunction) {
            if (line.match(bodyStart) || line.includes('{') || line.includes('BEGIN')) {
                inFunction = true;
                braceCount = 1;
            }
            continue;
        }
        
        // Count braces/BEGIN-END
        braceCount += (line.match(/\{|BEGIN\b/gi) || []).length;
        braceCount -= (line.match(/\}|END\b/gi) || []).length;
        
        functionBody += line + '\n';
        
        if (braceCount <= 0) break;
        if (i - startLine > 500) break; // Safety limit
    }
    
    // Common keywords to skip
    const keywords = ['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'typeof', 
                      'new', 'delete', 'throw', 'await', 'async', 'yield', 'class', 'interface',
                      'try', 'finally', 'else', 'elif', 'except', 'with', 'as', 'from', 'import'];
    
    // Generic function call pattern
    const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
    let match;
    
    while ((match = callRegex.exec(functionBody)) !== null) {
        const name = match[1];
        if (!keywords.includes(name.toLowerCase()) && name !== symbol.name) {
            calls.push(name);
        }
    }
    
    // TAL-specific: CALL statements
    if (language === 'tal') {
        // Direct CALL
        const talCallRegex = /CALL\s+(\w+)/gi;
        while ((match = talCallRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
        // Procedure calls (name followed by parentheses)
        const talProcRegex = /\b([A-Z_][A-Z0-9_^]*)\s*\(/gi;
        while ((match = talProcRegex.exec(functionBody)) !== null) {
            const name = match[1];
            if (!['IF', 'WHILE', 'FOR', 'CASE', 'SCAN', 'RSCAN'].includes(name.toUpperCase())) {
                calls.push(name);
            }
        }
    }
    
    // SQL-specific: procedure/function calls
    if (language === 'sql') {
        // EXEC/EXECUTE procedure
        const execRegex = /(?:EXEC|EXECUTE)\s+(?:PROCEDURE\s+)?(?:[\w.]+\.)?(\w+)/gi;
        while ((match = execRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
        // CALL procedure
        const sqlCallRegex = /CALL\s+(?:[\w.]+\.)?(\w+)/gi;
        while ((match = sqlCallRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
        // Function calls in SELECT/WHERE
        const sqlFuncRegex = /\b([A-Z_]\w*)\s*\(/gi;
        while ((match = sqlFuncRegex.exec(functionBody)) !== null) {
            const name = match[1].toUpperCase();
            // Skip SQL keywords
            if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'AND', 'OR', 'NOT',
                  'IN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'OVER', 'PARTITION',
                  'ORDER', 'GROUP', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'ON',
                  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CAST', 'CONVERT', 'COALESCE', 'NULLIF',
                  'ISNULL', 'NVL', 'DECODE', 'IF', 'IIF'].includes(name)) {
                calls.push(match[1]);
            }
        }
    }
    
    // C#-specific
    if (language === 'csharp') {
        // Method calls with dot notation
        const csMethodRegex = /\.([A-Z_]\w*)\s*\(/gi;
        while ((match = csMethodRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
        // Static method calls
        const csStaticRegex = /([A-Z]\w*)\.([A-Z_]\w*)\s*\(/g;
        while ((match = csStaticRegex.exec(functionBody)) !== null) {
            calls.push(match[2]);
        }
    }
    
    // Java-specific
    if (language === 'java') {
        // Method calls with dot notation
        const javaMethodRegex = /\.([a-z_]\w*)\s*\(/gi;
        while ((match = javaMethodRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
    }
    
    // Python-specific
    if (language === 'python') {
        // Method calls
        const pyMethodRegex = /\.([a-z_]\w*)\s*\(/gi;
        while ((match = pyMethodRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
    }
    
    // JavaScript/TypeScript-specific
    if (language === 'javascript' || language === 'typescript') {
        // Method calls with dot notation
        const jsMethodRegex = /\.([a-zA-Z_]\w*)\s*\(/g;
        while ((match = jsMethodRegex.exec(functionBody)) !== null) {
            const name = match[1];
            // Skip common built-in methods
            if (!['then', 'catch', 'finally', 'map', 'filter', 'reduce', 'forEach', 'find', 
                  'some', 'every', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice',
                  'join', 'split', 'replace', 'match', 'test', 'exec', 'toString', 'valueOf',
                  'log', 'error', 'warn', 'info', 'debug', 'trace'].includes(name)) {
                calls.push(name);
            }
        }
        
        // Await calls
        const awaitRegex = /await\s+(\w+)\s*\(/g;
        while ((match = awaitRegex.exec(functionBody)) !== null) {
            calls.push(match[1]);
        }
        
        // Destructured imports that are called
        const destructuredCallRegex = /\b([A-Z][a-zA-Z0-9]*)\s*\(/g;
        while ((match = destructuredCallRegex.exec(functionBody)) !== null) {
            const name = match[1];
            // Skip common React/built-in
            if (!['Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
                  'Promise', 'Error', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet'].includes(name)) {
                calls.push(name);
            }
        }
    }
    
    return [...new Set(calls)]; // Remove duplicates
}

/**
 * Track variable accesses and modifications throughout the code
 */
function trackVariableAccesses(filePath, content, language) {
    const lines = content.split('\n');
    
    // Get all known variable names from this file
    const fileVars = new Map();
    for (const [key, varInfo] of codeIndex.variables) {
        if (varInfo.file === filePath) {
            fileVars.set(varInfo.name, key);
        }
    }
    
    if (fileVars.size === 0) return;
    
    // Build regex to find variable names
    const varNames = [...fileVars.keys()];
    if (varNames.length === 0) return;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        
        for (const varName of varNames) {
            // Skip if variable name is too short (likely false positives)
            if (varName.length < 2) continue;
            
            // Create word-boundary regex for this variable (no 'g' flag needed for test)
            const varRegex = new RegExp(`\\b${escapeRegex(varName)}\\b`);
            
            if (varRegex.test(line)) {
                const varKey = fileVars.get(varName);
                const varInfo = codeIndex.variables.get(varKey);
                
                if (varInfo && lineNum + 1 !== varInfo.declarationLine) {
                    // Determine if this is a read or write
                    const isModification = isVariableModified(line, varName, language);
                    
                    varInfo.accesses.push({
                        file: filePath,
                        line: lineNum + 1,
                        type: isModification ? 'write' : 'read',
                        context: line.trim().substring(0, 80)
                    });
                }
            }
        }
    }
}

/**
 * Determine if a variable is being modified on a given line
 */
function isVariableModified(line, varName, language) {
    const escapedName = escapeRegex(varName);
    
    // Common assignment patterns
    const patterns = [
        new RegExp(`\\b${escapedName}\\s*=(?!=)`),              // x = 
        new RegExp(`\\b${escapedName}\\s*:=`),                  // x := (Pascal, TAL)
        new RegExp(`\\b${escapedName}\\s*\\+=`),                // x +=
        new RegExp(`\\b${escapedName}\\s*-=`),                  // x -=
        new RegExp(`\\b${escapedName}\\s*\\*=`),                // x *=
        new RegExp(`\\b${escapedName}\\s*/=`),                  // x /=
        new RegExp(`\\b${escapedName}\\s*%=`),                  // x %=
        new RegExp(`\\b${escapedName}\\s*&=`),                  // x &=
        new RegExp(`\\b${escapedName}\\s*\\|=`),                // x |=
        new RegExp(`\\b${escapedName}\\s*\\^=`),                // x ^=
        new RegExp(`\\b${escapedName}\\s*<<=`),                 // x <<=
        new RegExp(`\\b${escapedName}\\s*>>=`),                 // x >>=
        new RegExp(`\\+\\+\\s*${escapedName}\\b`),              // ++x
        new RegExp(`\\b${escapedName}\\s*\\+\\+`),              // x++
        new RegExp(`--\\s*${escapedName}\\b`),                  // --x
        new RegExp(`\\b${escapedName}\\s*--`),                  // x--
    ];
    
    // Language-specific patterns
    if (language === 'cobol') {
        patterns.push(
            new RegExp(`MOVE\\s+.*\\s+TO\\s+${escapedName}`, 'i'),       // MOVE x TO var
            new RegExp(`ADD\\s+.*\\s+TO\\s+${escapedName}`, 'i'),        // ADD x TO var
            new RegExp(`SUBTRACT\\s+.*\\s+FROM\\s+${escapedName}`, 'i'), // SUBTRACT x FROM var
            new RegExp(`MULTIPLY\\s+.*\\s+GIVING\\s+${escapedName}`, 'i'),
            new RegExp(`DIVIDE\\s+.*\\s+GIVING\\s+${escapedName}`, 'i'),
            new RegExp(`COMPUTE\\s+${escapedName}\\s*=`, 'i'),          // COMPUTE var = 
            new RegExp(`INTO\\s+${escapedName}\\b`, 'i'),               // READ INTO var
            new RegExp(`ACCEPT\\s+${escapedName}\\b`, 'i'),             // ACCEPT var
            new RegExp(`STRING\\s+.*\\s+INTO\\s+${escapedName}`, 'i'),
            new RegExp(`UNSTRING\\s+.*\\s+INTO\\s+${escapedName}`, 'i'),
        );
    }
    
    if (language === 'tal') {
        patterns.push(
            new RegExp(`\\b${escapedName}\\s*:=`),              // TAL assignment
            new RegExp(`@\\s*${escapedName}\\s*:=`),            // Indirect assignment
        );
    }
    
    if (language === 'sql') {
        patterns.push(
            new RegExp(`SET\\s+${escapedName}\\s*=`, 'i'),      // SET var = 
            new RegExp(`INTO\\s+${escapedName}\\b`, 'i'),       // SELECT INTO var
            new RegExp(`FETCH.*INTO.*${escapedName}`, 'i'),     // FETCH INTO var
        );
    }
    
    if (language === 'python') {
        patterns.push(
            new RegExp(`\\b${escapedName}\\s*=(?!=)`),          // Python assignment
            new RegExp(`for\\s+${escapedName}\\s+in\\b`),       // for var in
        );
    }
    
    for (const pattern of patterns) {
        if (pattern.test(line)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Grep all context files for a symbol/keyword
 * Returns all occurrences with file, line number, and context
 */
function grepCodeForSymbol(symbolName, options = {}) {
    const results = {
        definition: null,
        calls: [],
        references: [],
        variables: [],
        all: []
    };
    
    if (!symbolName) return results;
    
    const escapedSymbol = escapeRegex(symbolName);
    const wordBoundaryRegex = new RegExp(`\\b${escapedSymbol}\\b`, 'g');
    const definitionRegex = new RegExp(
        `^[\\s]*((?:static\\s+)?(?:inline\\s+)?(?:const\\s+)?\\w+[\\s*]+)?${escapedSymbol}\\s*\\(`,
        'gm'
    );
    const callRegex = new RegExp(`\\b${escapedSymbol}\\s*\\(`, 'g');
    
    for (const [filePath, file] of contextFiles) {
        const content = file.content;
        const lines = content.split('\n');
        const fileName = pathUtils.getFileName(filePath);
        
        // Find definition (function declaration with body)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Check if this line defines the function
            if (definitionRegex.test(line) || 
                (line.includes(symbolName) && line.match(/^\s*(?:\w+\s+)+\w+\s*\(/))) {
                
                // Extract the full function including body
                let funcCode = line;
                let braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
                let j = i + 1;
                
                // If no opening brace yet, look for it
                if (braceCount === 0 && !line.includes('{')) {
                    while (j < lines.length && !lines[j].includes('{')) {
                        funcCode += '\n' + lines[j];
                        j++;
                    }
                    if (j < lines.length) {
                        funcCode += '\n' + lines[j];
                        braceCount = 1;
                        j++;
                    }
                }
                
                // Find the closing brace
                while (j < lines.length && braceCount > 0) {
                    funcCode += '\n' + lines[j];
                    braceCount += (lines[j].match(/\{/g) || []).length;
                    braceCount -= (lines[j].match(/\}/g) || []).length;
                    j++;
                }
                
                // Only consider it a definition if it's at the start of a line (not inside another function)
                const beforeLine = lines.slice(Math.max(0, i - 5), i).join('\n');
                const openBraces = (beforeLine.match(/\{/g) || []).length;
                const closeBraces = (beforeLine.match(/\}/g) || []).length;
                
                if (openBraces <= closeBraces) {
                    results.definition = {
                        file: filePath,
                        fileName,
                        line: i + 1,
                        endLine: j,
                        code: funcCode,
                        context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, j + 1)).join('\n')
                    };
                }
            }
            
            // Check for function calls
            if (line.includes(symbolName + '(') && !definitionRegex.test(line)) {
                results.calls.push({
                    file: filePath,
                    fileName,
                    line: i + 1,
                    code: line.trim(),
                    context: lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join('\n')
                });
            }
            
            // Check for any reference
            if (wordBoundaryRegex.test(line)) {
                wordBoundaryRegex.lastIndex = 0; // Reset regex
                results.all.push({
                    file: filePath,
                    fileName,
                    line: i + 1,
                    code: line.trim()
                });
            }
        }
    }
    
    return results;
}

/**
 * Build a top-down call graph starting from a function
 */
function buildCallGraphFromSymbol(symbolName, maxDepth = 5) {
    const graph = {
        root: symbolName,
        nodes: new Map(),
        edges: []
    };
    
    const visited = new Set();
    
    function traverse(funcName, depth) {
        if (depth > maxDepth || visited.has(funcName)) return;
        visited.add(funcName);
        
        const calls = codeIndex.callGraph.get(funcName);
        if (!calls) return;
        
        for (const callee of calls) {
            graph.edges.push({ from: funcName, to: callee, depth });
            if (!graph.nodes.has(callee)) {
                const symbol = codeIndex.symbols.get(callee);
                graph.nodes.set(callee, {
                    name: callee,
                    file: symbol?.file?.split('/').pop(),
                    line: symbol?.line,
                    type: symbol?.type
                });
            }
            traverse(callee, depth + 1);
        }
    }
    
    // Add root node
    const rootSymbol = codeIndex.symbols.get(symbolName);
    graph.nodes.set(symbolName, {
        name: symbolName,
        file: rootSymbol?.file?.split('/').pop(),
        line: rootSymbol?.line,
        type: rootSymbol?.type
    });
    
    traverse(symbolName, 0);
    
    return graph;
}

/**
 * Format call graph as text for prompt
 */
function formatCallGraphAsText(graph) {
    if (graph.edges.length === 0) {
        return `${graph.root} (no outgoing calls found in index)`;
    }
    
    let text = `## Call Graph (top-down from ${graph.root}):\n\n`;
    text += '```\n';
    
    // Build tree structure
    const children = new Map();
    for (const edge of graph.edges) {
        if (!children.has(edge.from)) {
            children.set(edge.from, []);
        }
        children.get(edge.from).push(edge.to);
    }
    
    function printTree(node, prefix = '', isLast = true) {
        const nodeInfo = graph.nodes.get(node);
        const location = nodeInfo?.file ? ` (${nodeInfo.file}:${nodeInfo.line})` : '';
        text += prefix + (isLast ? '└── ' : '├── ') + node + location + '\n';
        
        const nodeChildren = children.get(node) || [];
        for (let i = 0; i < nodeChildren.length; i++) {
            const child = nodeChildren[i];
            const childIsLast = i === nodeChildren.length - 1;
            printTree(child, prefix + (isLast ? '    ' : '│   '), childIsLast);
        }
    }
    
    const rootInfo = graph.nodes.get(graph.root);
    const rootLocation = rootInfo?.file ? ` (${rootInfo.file}:${rootInfo.line})` : '';
    text += graph.root + rootLocation + '\n';
    
    const rootChildren = children.get(graph.root) || [];
    for (let i = 0; i < rootChildren.length; i++) {
        printTree(rootChildren[i], '', i === rootChildren.length - 1);
    }
    
    text += '```\n';
    return text;
}

/**
 * Find file dependencies (imports, includes)
 */
function findDependencies(content, language) {
    const deps = [];
    let match;
    
    // C/C++ includes
    const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
    while ((match = includeRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    // Python imports
    const importRegex = /(?:from\s+(\S+)\s+)?import\s+(\S+)/g;
    while ((match = importRegex.exec(content)) !== null) {
        deps.push(match[1] || match[2]);
    }
    
    // JavaScript imports
    const jsImportRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
    while ((match = jsImportRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    // Java imports
    const javaImportRegex = /import\s+(?:static\s+)?([a-zA-Z0-9_.]+)(?:\.\*)?;/g;
    while ((match = javaImportRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    // Go imports
    const goImportRegex = /import\s+(?:\w+\s+)?["']([^"']+)["']/g;
    while ((match = goImportRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    // C# using statements
    const csUsingRegex = /using\s+(?:static\s+)?([a-zA-Z0-9_.]+)\s*;/g;
    while ((match = csUsingRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    // COBOL COPY statements
    const cobolCopyRegex = /COPY\s+([A-Z0-9][A-Z0-9-]*)/gi;
    while ((match = cobolCopyRegex.exec(content)) !== null) {
        deps.push(match[1].toUpperCase());
    }
    
    // TAL SOURCE directives
    const talSourceRegex = /\?SOURCE\s+([A-Z0-9_^]+)/gi;
    while ((match = talSourceRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    // SQL - referenced tables, procedures, functions
    const sqlFromRegex = /(?:FROM|JOIN|INTO|UPDATE)\s+(?:[\w.]+\.)?(\w+)/gi;
    while ((match = sqlFromRegex.exec(content)) !== null) {
        deps.push(match[1]);
    }
    
    return [...new Set(deps)]; // Remove duplicates
}

/**
 * Get index summary for LLM context
 */
function getIndexSummary() {
    if (codeIndex.files.size === 0) {
        return '';
    }
    
    let summary = '\n\n=== CODE INDEX ===\n';
    summary += `Files: ${codeIndex.files.size} | Symbols: ${codeIndex.symbols.size} | Variables: ${codeIndex.variables.size} | Call Edges: ${Array.from(codeIndex.callGraph.values()).reduce((sum, calls) => sum + calls.size, 0)}\n\n`;
    
    // Group symbols by type
    const symbolsByType = new Map();
    for (const [name, symbol] of codeIndex.symbols) {
        // Skip duplicate entries (we have both "name" and "name@path" entries)
        if (name.includes('@')) continue;
        
        const type = symbol.type || 'unknown';
        if (!symbolsByType.has(type)) {
            symbolsByType.set(type, []);
        }
        symbolsByType.get(type).push(symbol);
    }
    
    // Functions/Procedures/Methods with call graph
    summary += '## Callable Symbols & Call Graph:\n';
    const callableTypes = ['function', 'procedure', 'method', 'subproc', 'section', 'paragraph', 'program'];
    for (const [funcName, calls] of codeIndex.callGraph) {
        const symbol = codeIndex.symbols.get(funcName);
        if (symbol) {
            const callers = codeIndex.reverseCallGraph.get(funcName);
            const callerCount = callers ? callers.size : 0;
            const callList = calls.size > 0 ? ` → calls: ${[...calls].slice(0, 5).join(', ')}${calls.size > 5 ? '...' : ''}` : '';
            const callerInfo = callerCount > 0 ? ` [called by ${callerCount}]` : ' [entry point]';
            summary += `- ${funcName} (${symbol.type}, ${symbol.file?.split('/').pop() || 'unknown'}:${symbol.line})${callerInfo}${callList}\n`;
        }
    }
    
    // Classes/Interfaces/Structs
    const structTypes = ['class', 'interface', 'struct', 'enum', 'record', 'namespace', 'type'];
    const structs = [];
    for (const type of structTypes) {
        const symbols = symbolsByType.get(type) || [];
        for (const s of symbols) {
            structs.push(`- ${s.name} (${type}, ${s.file?.split('/').pop() || ''}:${s.line})`);
        }
    }
    if (structs.length > 0) {
        summary += '\n## Classes/Structs/Types:\n';
        summary += structs.slice(0, 30).join('\n') + '\n';
    }
    
    // Variables with data types and access info
    if (codeIndex.variables.size > 0) {
        summary += '\n## Variables & Data Flow:\n';
        
        // Group by scope
        const globalVars = [];
        const memberVars = [];
        const localVars = [];
        const paramVars = [];
        
        for (const [key, varInfo] of codeIndex.variables) {
            const fileName = varInfo.file?.split('/').pop() || 'unknown';
            const accessCount = varInfo.accesses?.length || 0;
            const readCount = varInfo.accesses?.filter(a => a.type === 'read').length || 0;
            const writeCount = varInfo.accesses?.filter(a => a.type === 'write').length || 0;
            
            const entry = `- ${varInfo.name}: ${varInfo.dataType} (${fileName}:${varInfo.declarationLine}${varInfo.initializationLine ? ', init:' + varInfo.initializationLine : ''}) [R:${readCount} W:${writeCount}]`;
            
            switch (varInfo.scope) {
                case 'global': globalVars.push(entry); break;
                case 'member': memberVars.push(entry); break;
                case 'local': localVars.push(entry); break;
                case 'parameter': paramVars.push(entry); break;
                default: localVars.push(entry);
            }
        }
        
        if (globalVars.length > 0) {
            summary += '### Global Variables:\n';
            summary += globalVars.slice(0, 15).join('\n') + '\n';
        }
        if (memberVars.length > 0) {
            summary += '### Member Variables:\n';
            summary += memberVars.slice(0, 15).join('\n') + '\n';
        }
        if (paramVars.length > 0) {
            summary += '### Parameters:\n';
            summary += paramVars.slice(0, 15).join('\n') + '\n';
        }
        if (localVars.length > 0) {
            summary += '### Local Variables:\n';
            summary += localVars.slice(0, 15).join('\n') + '\n';
        }
    }
    
    // SQL objects
    const sqlTypes = ['table', 'view', 'trigger', 'index', 'package', 'cte'];
    const sqlObjects = [];
    for (const type of sqlTypes) {
        const symbols = symbolsByType.get(type) || [];
        for (const s of symbols) {
            sqlObjects.push(`- ${s.name} (${type}, ${s.file?.split('/').pop() || ''}:${s.line})`);
        }
    }
    if (sqlObjects.length > 0) {
        summary += '\n## SQL Objects:\n';
        summary += sqlObjects.slice(0, 20).join('\n') + '\n';
    }
    
    // Dependencies (copybooks, includes, imports)
    const allDeps = new Set();
    for (const [file, deps] of codeIndex.dependencies) {
        for (const dep of deps) {
            allDeps.add(dep);
        }
    }
    if (allDeps.size > 0) {
        summary += '\n## Dependencies:\n';
        summary += [...allDeps].slice(0, 20).map(d => `- ${d}`).join('\n') + '\n';
    }
    
    summary += '=== END INDEX ===\n\n';
    
    return summary;
}

/**
 * Generate hierarchical codebase summary for overview queries
 * Instead of including all file contents, summarizes by:
 * 1. File/module organization
 * 2. Function summaries grouped by file
 * 3. Key data structures
 * 4. Entry points and main flows
 */
function generateHierarchicalSummary() {
    const fileCount = contextFiles.size;
    const totalLines = Array.from(contextFiles.values()).reduce((sum, f) => sum + (f.content?.split('\n').length || 0), 0);
    
    let summary = `# CODEBASE OVERVIEW\n\n`;
    summary += `**${fileCount} files** | **${totalLines.toLocaleString()} lines** | **${codeIndex.symbols.size} symbols**\n\n`;
    
    // Group files by directory/module
    const filesByDir = new Map();
    for (const [path, file] of contextFiles) {
        const parts = path.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '/';
        if (!filesByDir.has(dir)) {
            filesByDir.set(dir, []);
        }
        filesByDir.get(dir).push({ path, file, name: parts[parts.length - 1] });
    }
    
    // Sort directories by file count
    const sortedDirs = [...filesByDir.entries()].sort((a, b) => b[1].length - a[1].length);
    
    summary += `## File Organization\n\n`;
    for (const [dir, files] of sortedDirs.slice(0, 15)) {
        const dirName = dir || '(root)';
        summary += `**${dirName}/** (${files.length} files)\n`;
        // List first few files
        for (const f of files.slice(0, 5)) {
            summary += `  - ${f.name}\n`;
        }
        if (files.length > 5) {
            summary += `  - ... and ${files.length - 5} more\n`;
        }
        summary += '\n';
    }
    
    // Group functions by file with summaries
    summary += `## Functions by Module\n\n`;
    const funcsByFile = new Map();
    
    for (const [key, symbol] of codeIndex.symbols) {
        if (['function', 'procedure', 'method', 'subproc', 'paragraph', 'section'].includes(symbol.type)) {
            const file = symbol.file || 'unknown';
            const fileName = pathUtils.getFileName(file);
            if (!funcsByFile.has(fileName)) {
                funcsByFile.set(fileName, []);
            }
            funcsByFile.get(fileName).push(symbol);
        }
    }
    
    // Sort by function count and show top modules
    const sortedFiles = [...funcsByFile.entries()].sort((a, b) => b[1].length - a[1].length);
    
    for (const [fileName, funcs] of sortedFiles.slice(0, 20)) {
        summary += `### ${fileName} (${funcs.length} functions)\n\n`;
        
        // Show each function with its summary
        for (const func of funcs.slice(0, 15)) {
            const funcSummary = func.summary || generateSummaryFromName(func.name);
            const callers = codeIndex.reverseCallGraph.get(func.name)?.size || 0;
            const callees = codeIndex.callGraph.get(func.name)?.size || 0;
            
            summary += `- **${func.name}**: ${funcSummary}`;
            if (callers > 0 || callees > 0) {
                summary += ` [↓${callers} ↑${callees}]`;
            }
            summary += '\n';
        }
        
        if (funcs.length > 15) {
            summary += `- ... and ${funcs.length - 15} more functions\n`;
        }
        summary += '\n';
    }
    
    // Entry points (functions not called by others)
    const entryPoints = [];
    for (const [funcName, callees] of codeIndex.callGraph) {
        const callers = codeIndex.reverseCallGraph.get(funcName);
        if (!callers || callers.size === 0) {
            const symbol = codeIndex.symbols.get(funcName);
            if (symbol) {
                entryPoints.push(symbol);
            }
        }
    }
    
    if (entryPoints.length > 0) {
        summary += `## Entry Points (${entryPoints.length} functions not called by others)\n\n`;
        for (const ep of entryPoints.slice(0, 20)) {
            const epSummary = ep.summary || generateSummaryFromName(ep.name);
            const file = ep.file?.split('/').pop() || '';
            summary += `- **${ep.name}** (${file}): ${epSummary}\n`;
        }
        if (entryPoints.length > 20) {
            summary += `- ... and ${entryPoints.length - 20} more entry points\n`;
        }
        summary += '\n';
    }
    
    // Key data structures (structs, classes, records)
    const dataStructures = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (['class', 'struct', 'record', 'type', 'interface'].includes(symbol.type)) {
            dataStructures.push(symbol);
        }
    }
    
    if (dataStructures.length > 0) {
        summary += `## Data Structures (${dataStructures.length})\n\n`;
        for (const ds of dataStructures.slice(0, 30)) {
            const file = ds.file?.split('/').pop() || '';
            summary += `- **${ds.name}** (${ds.type}, ${file})\n`;
        }
        if (dataStructures.length > 30) {
            summary += `- ... and ${dataStructures.length - 30} more\n`;
        }
        summary += '\n';
    }
    
    // Key constants/literals
    const constants = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (['constant', 'literal', 'define'].includes(symbol.type)) {
            constants.push(symbol);
        }
    }
    
    if (constants.length > 0 && constants.length < 100) {
        summary += `## Constants & Defines (${constants.length})\n\n`;
        for (const c of constants.slice(0, 20)) {
            const value = c.value ? ` = ${String(c.value).substring(0, 50)}` : '';
            summary += `- ${c.name}${value}\n`;
        }
        if (constants.length > 20) {
            summary += `- ... and ${constants.length - 20} more\n`;
        }
        summary += '\n';
    }
    
    return summary;
}

/**
 * Use LLM to classify the query type for large codebases
 * Returns: 'overview' | 'domain' | 'specific' | 'general'
 */
async function classifyQueryWithLLM(query, fileCount) {
    debugLog('CLASSIFY', `Classifying query with LLM`, {
        query: query.substring(0, 100),
        fileCount
    });
    
    // Use prompt library for classification - extended version with more categories
    const classificationPrompt = `You are a query classifier for a code assistant. The user has ${fileCount} files attached.

Classify this query into ONE of these categories:

1. **overview** - User wants a high-level understanding of the entire codebase
   Examples: "explain the code", "what does this project do", "describe the architecture", "high level functionality", "summarize the attached files"

2. **domain** - User asks about a specific feature/functionality that may span multiple files
   Examples: "how is ABA validation handled", "describe the payment processing flow", "where is authentication implemented", "how does wire transfer work"

3. **specific** - User asks about a specific function, file, or code element
   Examples: "what does processPayment do", "explain the User class", "how does function X work", "find the bug in Y"

4. **general** - General programming question not specifically about the attached code
   Examples: "what is a REST API", "how do I use async/await", "best practices for error handling"

USER QUERY: "${query}"

Respond with ONLY the category name (overview, domain, specific, or general), nothing else.`;

    try {
        // Use a quick, low-cost LLM call
        const response = await callLanguageModelQuick(classificationPrompt);
        
        if (!response) {
            debugLog('CLASSIFY', 'LLM returned no response, using regex fallback');
            return classifyQueryFallback(query);
        }
        
        const classification = response.trim().toLowerCase();
        
        // Validate response
        const validTypes = ['overview', 'domain', 'specific', 'general'];
        if (validTypes.includes(classification)) {
            debugLog('CLASSIFY', `LLM classification result: ${classification}`, {
                rawResponse: response.substring(0, 50)
            });
            return classification;
        }
        
        // Try to extract from longer response
        for (const type of validTypes) {
            if (response.toLowerCase().includes(type)) {
                debugLog('CLASSIFY', `Extracted type from response: ${type}`, {
                    rawResponse: response.substring(0, 100)
                });
                return type;
            }
        }
        
        debugLog('CLASSIFY', `Could not parse LLM response, using fallback`, {
            rawResponse: response.substring(0, 100)
        });
        return classifyQueryFallback(query);
        
    } catch (error) {
        debugLog('CLASSIFY', `LLM error: ${error.message}, using fallback`);
        // Fall back to regex-based classification
        return classifyQueryFallback(query);
    }
}

/**
 * Quick LLM call for classification (shorter response, no streaming)
 * Uses the configured lightweight model via LLMConfig
 * to save tokens/cost on simple classification tasks
 */
async function callLanguageModelQuick(prompt) {
    try {
        if (!vscode.lm || !vscode.lm.selectChatModels) {
            log('callLanguageModelQuick: VS Code LM API not available');
            return null;
        }
        
        // Get the classification model from centralized config
        const preferredModel = LLMConfig.getModelForTask(LLMConfig.TASKS.CLASSIFICATION);
        log('callLanguageModelQuick: Preferred classification model:', preferredModel);
        
        // Get available models
        let models = await vscode.lm.selectChatModels({});
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        }
        
        if (models.length === 0) {
            log('callLanguageModelQuick: No models available');
            return null;
        }
        
        log('callLanguageModelQuick: Available models:', models.map(m => m.name || m.id).join(', '));
        
        // Use centralized model search order from LLMConfig
        let model = null;
        const modelSearchOrder = LLMConfig.getModelSearchOrder(preferredModel);
        
        // Try each search pattern
        for (const searchFn of modelSearchOrder) {
            model = models.find(searchFn);
            if (model) {
                log('callLanguageModelQuick: Found model:', model.name || model.id);
                break;
            }
        }
        
        // Fallback to first available model if no match found
        if (!model) {
            model = models[0];
            log('callLanguageModelQuick: Using fallback model:', model.name || model.id);
        }
        
        log('callLanguageModelQuick: Using model:', model.name || model.id, '(preferred was:', preferredModel + ')');
        
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const cancellation = new vscode.CancellationTokenSource();
        
        // Set a timeout for quick responses
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Classification timeout')), 10000)
        );
        
        const responsePromise = (async () => {
            let result = '';
            const chatResponse = await model.sendRequest(messages, {}, cancellation.token);
            
            for await (const chunk of chatResponse.text) {
                result += chunk;
                // For classification, we only need a short response
                if (result.length > 100) {
                    cancellation.cancel();
                    break;
                }
            }
            return result;
        })();
        
        const result = await Promise.race([responsePromise, timeoutPromise]);
        log('callLanguageModelQuick: Response:', result);
        return result;
        
    } catch (error) {
        log('callLanguageModelQuick: Error:', error.message);
        return null;
    }
}

/**
 * Fallback regex-based classification when LLM is unavailable
 */
function classifyQueryFallback(text) {
    debugLog('CLASSIFY', `Using regex fallback classification`, {
        query: text.substring(0, 80)
    });
    
    const isOverview = isOverviewQuery(text);
    const isDomain = isDomainQuery(text);
    
    let result;
    let matchedPattern = null;
    
    if (isOverview) {
        result = 'overview';
        // Find which pattern matched
        const normalizedText = text.trim().replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+|would\s+you\s+)/i, '').trim();
        const overviewPatterns = [
            { name: 'explain/describe codebase', regex: /^(?:explain|describe|summarize|overview|analyze)\s+(?:the\s+)?(?:high[\s-]?level\s+)?(?:code|codebase|project|files?|attached|this)/i },
            { name: 'functionality/structure', regex: /^(?:explain|describe|summarize)\s+(?:the\s+)?(?:high[\s-]?level\s+)?(?:functionality|structure|architecture|purpose)/i },
            { name: 'what does/is', regex: /^(?:what\s+(?:does|is)\s+(?:this|the)\s+(?:code|codebase|project)|give\s+(?:me\s+)?(?:an?\s+)?overview)/i },
            { name: 'how does work', regex: /^(?:how\s+does\s+(?:this|the)\s+(?:code|codebase|project)\s+work)/i },
            { name: 'tell me about', regex: /^(?:tell\s+me\s+about\s+(?:this|the)\s+(?:code|codebase|project))/i },
            { name: 'overall/general', regex: /(?:overall|general|main|high[\s-]?level)\s+(?:purpose|functionality|structure|design)/i }
        ];
        for (const p of overviewPatterns) {
            if (p.regex.test(normalizedText)) {
                matchedPattern = p.name;
                break;
            }
        }
    } else if (isDomain) {
        result = 'domain';
        // Find which pattern matched
        const domainPatterns = [
            { name: 'describe/explain functionality', regex: /(?:describe|explain|how\s+(?:is|does|do|are))\s+(?:the\s+)?(\w+)\s+(?:functionality|feature|work|handled|implemented|processed)/i },
            { name: 'how is X implemented', regex: /how\s+(?:is|are)\s+(\w+)\s+implemented/i },
            { name: 'where/how handling', regex: /(?:where|how)\s+(?:is|does|are)\s+(\w+)\s+(?:validation|processing|handling|logic|implemented)/i },
            { name: 'show/find flow', regex: /(?:show|find|trace)\s+(?:me\s+)?(?:the\s+)?(\w+)\s+(?:flow|logic|code|implementation)/i },
            { name: 'ACRONYM validation/processing', regex: /\b([A-Z]{2,5})\s+(?:validation|processing|handling|workflow|flow|logic)\b/i }
        ];
        for (const p of domainPatterns) {
            if (p.regex.test(text.trim())) {
                matchedPattern = p.name;
                break;
            }
        }
    } else {
        result = 'specific';
        matchedPattern = 'no overview/domain patterns matched';
    }
    
    debugLog('CLASSIFY', `Fallback result: ${result}`, {
        isOverview,
        isDomain,
        matchedPattern
    });
    
    return result;
}

/**
 * LLM call specifically for summarization (allows longer responses than classification)
 * Uses lightweight model but doesn't truncate aggressively
 */
async function callLanguageModelForSummary(prompt, maxLength = 2000) {
    try {
        if (!vscode.lm || !vscode.lm.selectChatModels) {
            log('callLanguageModelForSummary: VS Code LM API not available - will use name-based summaries');
            return null;
        }
        
        // Get the summary model from centralized config
        const preferredModel = LLMConfig.getModelForTask(LLMConfig.TASKS.SUMMARY);
        log('callLanguageModelForSummary: Preferred model:', preferredModel);
        
        // Get available models
        let models = await vscode.lm.selectChatModels({});
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        }
        
        if (models.length === 0) {
            log('callLanguageModelForSummary: No models available - will use name-based summaries');
            return null;
        }
        
        // Use centralized model search order from LLMConfig
        let model = null;
        const modelSearchOrder = LLMConfig.getModelSearchOrder(preferredModel);
        
        for (const searchFn of modelSearchOrder) {
            model = models.find(searchFn);
            if (model) {
                break;
            }
        }
        
        // Fallback to first available
        if (!model) {
            model = models[0];
        }
        
        log('callLanguageModelForSummary: Using model:', model.name || model.id);
        
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const cancellation = new vscode.CancellationTokenSource();
        
        // Longer timeout for summaries
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Summary timeout')), 30000)
        );
        
        const responsePromise = (async () => {
            let result = '';
            const chatResponse = await model.sendRequest(messages, {}, cancellation.token);
            
            for await (const chunk of chatResponse.text) {
                result += chunk;
                // Allow longer responses for summaries
                if (result.length > maxLength) {
                    cancellation.cancel();
                    break;
                }
            }
            return result;
        })();
        
        return await Promise.race([responsePromise, timeoutPromise]);
        
    } catch (error) {
        log('callLanguageModelForSummary: Error:', error.message);
        // Update status to show LLM issues
        if (chatWebviewView) {
            chatWebviewView.webview.postMessage({
                type: 'indexProgress',
                progress: IndexingState.progress,
                message: `⚠️ LLM error: ${error.message.substring(0, 50)}... Using fallback summaries`
            });
        }
        return null;
    }
}

/**
 * Detect if query is asking for a high-level codebase overview (regex fallback)
 */
function isOverviewQuery(text) {
    const normalizedText = text.trim()
        .replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+|would\s+you\s+)/i, '') // Remove polite prefixes
        .trim();
    
    const overviewPatterns = [
        /^(?:explain|describe|summarize|overview|analyze)\s+(?:the\s+)?(?:high[\s-]?level\s+)?(?:code|codebase|project|files?|attached|this)/i,
        /^(?:explain|describe|summarize)\s+(?:the\s+)?(?:high[\s-]?level\s+)?(?:functionality|structure|architecture|purpose)/i,
        /^(?:what\s+(?:does|is)\s+(?:this|the)\s+(?:code|codebase|project)|give\s+(?:me\s+)?(?:an?\s+)?overview)/i,
        /^(?:how\s+does\s+(?:this|the)\s+(?:code|codebase|project)\s+work)/i,
        /^(?:tell\s+me\s+about\s+(?:this|the)\s+(?:code|codebase|project))/i,
        /^(?:understand|walk\s+(?:me\s+)?through)\s+(?:this|the)\s+(?:code|codebase)/i,
        /^(?:architecture|structure|design)\s+(?:of\s+)?(?:this|the)/i,
        /^(?:summarize|summary\s+of)\s+(?:all\s+)?(?:the\s+)?(?:attached|files?|code)/i,
        /(?:overall|general|main|high[\s-]?level)\s+(?:purpose|functionality|structure|design)/i,
        /what\s+(?:does|is)\s+(?:this|the)\s+(?:code|project|codebase)\s+(?:do|about|for)/i
    ];
    
    return overviewPatterns.some(p => p.test(normalizedText));
}

/**
 * Detect if query is asking about a specific domain/functionality
 * (not overview, but about a specific feature/concept that may span multiple files)
 */
function isDomainQuery(text) {
    // Don't match if it's an overview query
    if (isOverviewQuery(text)) return false;
    
    // Generic/overview terms that should NOT trigger domain search
    const overviewTerms = /\b(high[\s-]?level|overall|general|main|basic|entire|whole|all|complete|full)\b/i;
    if (overviewTerms.test(text)) return false;
    
    // Must have a specific domain term (acronyms, technical terms, feature names)
    const hasSpecificTerm = /\b([A-Z]{2,5}|payment|wire|transfer|routing|validation|account|transaction|auth|login|user|session|database|api|endpoint|join|joins|partition|partitions|partitioning|index|indexes|indexing|query|queries|scan|scans|parse|parsing|execute|execution|plan|planner|optimizer|buffer|cache|lock|locks|locking|wal|log|logging|replication|vacuum|toast|tuple|heap|btree|hash|gist|gin|brin|catalog|schema|table|tables|column|columns|constraint|trigger|function|procedure|view|sequence|cursor)\b/i.test(text);
    if (!hasSpecificTerm) return false;
    
    // Domain/functionality patterns
    const domainPatterns = [
        /(?:describe|explain|how\s+(?:is|does|do|are))\s+(?:the\s+)?(\w+)\s+(?:functionality|feature|work|handled|implemented|processed)/i,
        /(?:describe|explain)\s+(?:how\s+)?(\w+)\s+(?:is|are)\s+(?:implemented|handled|done|processed)/i,
        /(?:how\s+(?:is|does|do|are))\s+(?:the\s+)?(?:code|system)\s+(?:handle|process|validate|manage|implement)\s+(\w+)/i,
        /(?:where|how)\s+(?:is|does|are)\s+(\w+)\s+(?:validation|processing|handling|logic|implemented)/i,
        /(?:show|find|trace)\s+(?:me\s+)?(?:the\s+)?(\w+)\s+(?:flow|logic|code|implementation)/i,
        /(?:what|which)\s+(?:files?|functions?|code)\s+(?:handle|process|implement)\s+(\w+)/i,
        /\b([A-Z]{2,5})\s+(?:validation|processing|handling|workflow|flow|logic)\b/i,
        // Match "how is X implemented" or "how are Xs implemented"
        /how\s+(?:is|are)\s+(\w+)\s+implemented/i,
        // Match "describe how X works"
        /describe\s+how\s+(\w+)\s+(?:works?|is\s+done|function)/i
    ];
    
    return domainPatterns.some(p => p.test(text.trim()));
}

/**
 * Extract domain keywords from a query for focused search
 */
function extractDomainKeywords(text) {
    const keywords = [];
    
    // Common stop words to filter out
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
        'how', 'where', 'when', 'why', 'if', 'then', 'else', 'for', 'from',
        'to', 'in', 'on', 'at', 'by', 'with', 'about', 'into', 'through',
        'and', 'or', 'but', 'not', 'all', 'any', 'some', 'each', 'every',
        'describe', 'explain', 'show', 'find', 'trace', 'tell', 'me', 'please',
        'code', 'files', 'function', 'functions', 'method', 'methods', 'work',
        'handled', 'implemented', 'processed', 'functionality', 'feature'
    ]);
    
    // Extract potential domain terms
    // Look for specific patterns first
    
    // Pattern: "ABA validation" or "wire transfer"
    const compoundMatch = text.match(/\b([A-Z]{2,}(?:\s+[a-z]+)?)\b/g);
    if (compoundMatch) {
        keywords.push(...compoundMatch.map(m => m.trim()));
    }
    
    // Pattern: acronyms like ABA, ACH, SWIFT
    const acronyms = text.match(/\b[A-Z]{2,5}\b/g);
    if (acronyms) {
        keywords.push(...acronyms);
    }
    
    // Split and filter remaining words
    const words = text.toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    
    keywords.push(...words);
    
    // Deduplicate and return
    return [...new Set(keywords.map(k => k.toLowerCase()))];
}

/**
 * Find relevant context for a domain-specific query
 * Searches symbols, file contents, and returns focused context
 */
function findRelevantContext(text, maxFiles = 30, maxChars = 100000) {
    const keywords = extractDomainKeywords(text);
    log('findRelevantContext: Keywords extracted:', keywords);
    
    if (keywords.length === 0) {
        return { files: [], summary: '', keywords: [] };
    }
    
    const relevantFiles = new Map(); // path -> { score, matches, content }
    const matchedSymbols = [];
    
    // 1. Search symbols in code index
    for (const [key, symbol] of codeIndex.symbols) {
        const symbolNameLower = symbol.name.toLowerCase();
        const summaryLower = (symbol.summary || '').toLowerCase();
        
        let score = 0;
        const matches = [];
        
        for (const keyword of keywords) {
            if (symbolNameLower.includes(keyword)) {
                score += 10;
                matches.push(`name:${keyword}`);
            }
            if (summaryLower.includes(keyword)) {
                score += 5;
                matches.push(`summary:${keyword}`);
            }
        }
        
        if (score > 0 && symbol.file) {
            matchedSymbols.push({ symbol, score, matches });
            
            // Track file relevance
            if (!relevantFiles.has(symbol.file)) {
                relevantFiles.set(symbol.file, { score: 0, matches: [], symbols: [] });
            }
            const fileInfo = relevantFiles.get(symbol.file);
            fileInfo.score += score;
            fileInfo.matches.push(...matches);
            fileInfo.symbols.push(symbol);
        }
    }
    
    // 2. Search file contents directly
    for (const [path, file] of contextFiles) {
        const contentLower = file.content.toLowerCase();
        let contentScore = 0;
        const contentMatches = [];
        
        for (const keyword of keywords) {
            // Count occurrences
            const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
            const occurrences = (file.content.match(regex) || []).length;
            
            if (occurrences > 0) {
                contentScore += occurrences * 2;
                contentMatches.push(`content:${keyword}(${occurrences})`);
            }
        }
        
        if (contentScore > 0) {
            if (!relevantFiles.has(path)) {
                relevantFiles.set(path, { score: 0, matches: [], symbols: [] });
            }
            const fileInfo = relevantFiles.get(path);
            fileInfo.score += contentScore;
            fileInfo.matches.push(...contentMatches);
        }
    }
    
    // 3. Sort files by relevance score
    const sortedFiles = [...relevantFiles.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, maxFiles);
    
    log('findRelevantContext: Found', sortedFiles.length, 'relevant files');
    
    // 4. Build focused context from top files
    let contextContent = '';
    let totalChars = 0;
    const includedFiles = [];
    
    for (const [filePath, info] of sortedFiles) {
        const file = contextFiles.get(filePath);
        if (!file) continue;
        
        const fileName = pathUtils.getFileName(filePath);
        const fileContent = file.content;
        
        // Check if adding this file would exceed limit
        if (totalChars + fileContent.length > maxChars) {
            // Try to include just the relevant functions
            if (info.symbols.length > 0) {
                let symbolContent = `\n=== ${fileName} (${file.language}) [PARTIAL - relevant functions] ===\n`;
                for (const sym of info.symbols.slice(0, 10)) {
                    const funcCode = extractFunctionCode(fileContent, sym);
                    if (funcCode) {
                        symbolContent += `\n// ${sym.name} (line ${sym.line})\n${funcCode}\n`;
                    }
                }
                if (totalChars + symbolContent.length <= maxChars) {
                    contextContent += symbolContent;
                    totalChars += symbolContent.length;
                    includedFiles.push({ name: fileName, path, score: info.score, partial: true });
                }
            }
            continue;
        }
        
        contextContent += `\n=== ${fileName} (${file.language}) [score: ${info.score}] ===\n`;
        contextContent += fileContent + '\n';
        totalChars += fileContent.length + fileName.length + 50;
        includedFiles.push({ name: fileName, path, score: info.score, partial: false });
    }
    
    // 5. Generate summary of what was found
    let summary = `## Focused Context for: "${keywords.slice(0, 5).join(', ')}"\n\n`;
    summary += `Found **${sortedFiles.length} relevant files** from ${contextFiles.size} total files.\n\n`;
    summary += `### Matched Files (by relevance):\n`;
    for (const f of includedFiles.slice(0, 15)) {
        summary += `- **${f.name}** (score: ${f.score}${f.partial ? ', partial' : ''})\n`;
    }
    if (sortedFiles.length > 15) {
        summary += `- ... and ${sortedFiles.length - 15} more files\n`;
    }
    
    // Add matched symbols
    if (matchedSymbols.length > 0) {
        summary += `\n### Key Functions/Symbols:\n`;
        const topSymbols = matchedSymbols.sort((a, b) => b.score - a.score).slice(0, 20);
        for (const { symbol, score } of topSymbols) {
            const file = symbol.file?.split('/').pop() || '';
            const desc = symbol.summary || generateSummaryFromName(symbol.name);
            summary += `- **${symbol.name}** (${file}): ${desc}\n`;
        }
    }
    
    return {
        files: includedFiles,
        content: contextContent,
        summary: summary,
        keywords: keywords,
        symbolCount: matchedSymbols.length,
        totalFiles: sortedFiles.length
    };
}

/**
 * Extract function/procedure code from file content
 */
function extractFunctionCode(content, symbol) {
    if (!symbol.line) return null;
    
    const lines = content.split('\n');
    const startLine = symbol.line - 1;
    
    if (startLine >= lines.length) return null;
    
    // Try to find the end of the function
    let depth = 0;
    let endLine = startLine;
    let foundStart = false;
    
    for (let i = startLine; i < Math.min(lines.length, startLine + 200); i++) {
        const line = lines[i];
        
        // Track brace/BEGIN depth
        const opens = (line.match(/\{|\bBEGIN\b/gi) || []).length;
        const closes = (line.match(/\}|\bEND\b/gi) || []).length;
        
        if (opens > 0) foundStart = true;
        depth += opens - closes;
        
        endLine = i;
        
        if (foundStart && depth <= 0) break;
    }
    
    // Extract the function
    const funcLines = lines.slice(startLine, endLine + 1);
    
    // Limit to reasonable size
    if (funcLines.length > 100) {
        return funcLines.slice(0, 50).join('\n') + '\n... [truncated] ...\n' + funcLines.slice(-10).join('\n');
    }
    
    return funcLines.join('\n');
}

/**
 * Find symbol and its callers/callees
 */
function traceSymbol(symbolName) {
    const result = {
        symbol: null,
        callers: [],
        callees: [],
        relatedFiles: new Set()
    };
    
    // Find the symbol
    const symbol = codeIndex.symbols.get(symbolName);
    if (symbol) {
        result.symbol = symbol;
        result.relatedFiles.add(symbol.file);
    }
    
    // Find what calls this symbol
    const callers = codeIndex.reverseCallGraph.get(symbolName);
    if (callers) {
        for (const caller of callers) {
            const callerSymbol = codeIndex.symbols.get(caller);
            if (callerSymbol) {
                result.callers.push(callerSymbol);
                result.relatedFiles.add(callerSymbol.file);
            }
        }
    }
    
    // Find what this symbol calls
    const callees = codeIndex.callGraph.get(symbolName);
    if (callees) {
        for (const callee of callees) {
            const calleeSymbol = codeIndex.symbols.get(callee);
            if (calleeSymbol) {
                result.callees.push(calleeSymbol);
                result.relatedFiles.add(calleeSymbol.file);
            }
        }
    }
    
    return result;
}

/**
 * Trace a variable - find its declaration, initialization, and all accesses
 */
function traceVariable(varName) {
    const result = {
        variable: null,
        declaration: null,
        initialization: null,
        reads: [],
        writes: [],
        relatedFiles: new Set()
    };
    
    // Find all variables with this name (could be in multiple files)
    for (const [key, varInfo] of codeIndex.variables) {
        if (varInfo.name === varName) {
            result.variable = varInfo;
            result.declaration = {
                file: varInfo.file,
                line: varInfo.declarationLine,
                dataType: varInfo.dataType,
                scope: varInfo.scope
            };
            
            if (varInfo.initializationLine) {
                result.initialization = {
                    file: varInfo.file,
                    line: varInfo.initializationLine
                };
            }
            
            result.relatedFiles.add(varInfo.file);
            
            // Categorize accesses
            if (varInfo.accesses) {
                for (const access of varInfo.accesses) {
                    if (access.type === 'read') {
                        result.reads.push(access);
                    } else if (access.type === 'write') {
                        result.writes.push(access);
                    }
                    result.relatedFiles.add(access.file);
                }
            }
            
            break; // Found the variable
        }
    }
    
    return result;
}


/**
 * Generate HTML page with interactive call graph visualization
 */
function generateCallGraphHtml() {
    log('=== GENERATING CALL GRAPH HTML ===');
    log('callGraph size:', codeIndex.callGraph.size);
    log('symbols size:', codeIndex.symbols.size);
    log('reverseCallGraph size:', codeIndex.reverseCallGraph.size);
    
    // Debug: show all callGraph entries
    for (const [funcName, callees] of codeIndex.callGraph) {
        log('  callGraph:', funcName, '→', [...callees].join(', ') || '(none)');
    }
    
    // Debug: show all symbols
    log('All symbols:');
    for (const [key, sym] of codeIndex.symbols) {
        log('  symbol:', key, 'type:', sym.type);
    }
    
    // Build graph data
    const nodes = [];
    const links = [];
    const nodeMap = new Map();
    
    // Collect all nodes
    let nodeId = 0;
    for (const [funcName, callees] of codeIndex.callGraph) {
        log('Processing:', funcName, 'with', callees.size, 'callees');
        if (!nodeMap.has(funcName)) {
            const symbol = codeIndex.symbols.get(funcName);
            const callerCount = codeIndex.reverseCallGraph.get(funcName)?.size || 0;
            nodeMap.set(funcName, nodeId);
            nodes.push({
                id: nodeId++,
                name: funcName,
                file: symbol?.file?.split('/').pop() || 'unknown',
                line: symbol?.line || 0,
                type: symbol?.type || 'function',
                callers: callerCount,
                calls: callees.size,
                calleeNames: [...callees],
                callerNames: []
            });
            log('  Added node:', funcName);
        }
        
        for (const callee of callees) {
            log('  Checking callee:', callee, 'exists in symbols?', codeIndex.symbols.has(callee));
            if (codeIndex.symbols.has(callee)) {
                if (!nodeMap.has(callee)) {
                    const symbol = codeIndex.symbols.get(callee);
                    const callerCount = codeIndex.reverseCallGraph.get(callee)?.size || 0;
                    const calleeCallees = codeIndex.callGraph.get(callee) || new Set();
                    nodeMap.set(callee, nodeId);
                    nodes.push({
                        id: nodeId++,
                        name: callee,
                        file: symbol?.file?.split('/').pop() || 'unknown',
                        line: symbol?.line || 0,
                        type: symbol?.type || 'function',
                        callers: callerCount,
                        calls: calleeCallees.size,
                        calleeNames: [...calleeCallees],
                        callerNames: []
                    });
                    log('  Added callee node:', callee);
                }
                links.push({
                    source: nodeMap.get(funcName),
                    target: nodeMap.get(callee)
                });
                log('  Added link:', funcName, '→', callee);
            } else {
                log('  SKIPPED callee (not in symbols):', callee);
            }
        }
    }
    
    log('Final: nodes:', nodes.length, 'links:', links.length);
    
    // Build caller names
    for (const node of nodes) {
        const callers = codeIndex.reverseCallGraph.get(node.name);
        if (callers) {
            node.callerNames = [...callers].filter(c => nodeMap.has(c));
        }
    }
    
    // Group by file for colors
    const files = [...new Set(nodes.map(n => n.file))];
    
    const nodesJson = JSON.stringify(nodes);
    const linksJson = JSON.stringify(links);
    const filesJson = JSON.stringify(files);

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>AstraCode Graph</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            overflow: hidden;
        }
        
        #container {
            display: flex;
            height: 100vh;
        }
        
        #sidebar {
            width: 320px;
            background: #161b22;
            border-right: 1px solid #30363d;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .sidebar-header {
            padding: 16px;
            border-bottom: 1px solid #30363d;
        }
        
        .sidebar-header h1 {
            font-size: 1.3em;
            color: #58a6ff;
            margin-bottom: 8px;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            margin-top: 12px;
        }
        
        .stat {
            background: #21262d;
            padding: 8px;
            border-radius: 6px;
            text-align: center;
        }
        
        .stat-value { font-size: 1.4em; font-weight: 600; color: #58a6ff; }
        .stat-label { font-size: 0.75em; color: #8b949e; }
        
        .search-box {
            margin: 12px 16px;
            padding: 10px 12px;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 6px;
            color: #e6edf3;
            font-size: 0.9em;
            width: calc(100% - 32px);
        }
        
        .search-box:focus { outline: none; border-color: #58a6ff; }
        
        .file-filter {
            padding: 0 16px;
            margin-bottom: 8px;
        }
        
        .file-filter select {
            width: 100%;
            padding: 8px;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 6px;
            color: #e6edf3;
            font-size: 0.85em;
        }
        
        .func-list {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }
        
        .func-item {
            padding: 10px 12px;
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 4px;
            transition: background 0.15s;
        }
        
        .func-item:hover { background: #21262d; }
        .func-item.selected { background: #1f6feb; }
        
        .func-name {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.9em;
            color: #ffa657;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .func-meta {
            display: flex;
            gap: 8px;
            margin-top: 4px;
            font-size: 0.75em;
            color: #8b949e;
        }
        
        .func-meta .file { color: #58a6ff; }
        
        #graph {
            flex: 1;
            position: relative;
        }
        
        #graph svg {
            width: 100%;
            height: 100%;
        }
        
        .node circle {
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .node:hover circle {
            filter: brightness(1.3);
        }
        
        .node.selected circle {
            stroke: #fff;
            stroke-width: 3px;
        }
        
        .node.dimmed circle {
            opacity: 0.15;
        }
        
        .node.dimmed text {
            opacity: 0.15;
        }
        
        .node text {
            font-size: 11px;
            fill: #e6edf3;
            pointer-events: none;
            font-family: 'SF Mono', Monaco, monospace;
        }
        
        .link {
            stroke: #30363d;
            stroke-opacity: 0.6;
            fill: none;
        }
        
        .link.highlighted {
            stroke: #58a6ff;
            stroke-opacity: 1;
            stroke-width: 2px;
        }
        
        .link.caller {
            stroke: #f85149;
            stroke-opacity: 1;
            stroke-width: 2px;
        }
        
        .link.callee {
            stroke: #3fb950;
            stroke-opacity: 1;
            stroke-width: 2px;
        }
        
        .link.dimmed {
            stroke-opacity: 0.05;
        }
        
        #tooltip {
            position: absolute;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 12px 16px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.15s;
            max-width: 300px;
            z-index: 1000;
        }
        
        #tooltip.visible { opacity: 1; }
        
        #tooltip h3 {
            font-family: monospace;
            color: #ffa657;
            font-size: 1em;
            margin-bottom: 8px;
        }
        
        #tooltip .info {
            color: #8b949e;
            font-size: 0.85em;
            margin-bottom: 8px;
        }
        
        #tooltip .connections {
            display: flex;
            gap: 16px;
        }
        
        #tooltip .conn {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 0.85em;
        }
        
        #tooltip .conn.callers { color: #f85149; }
        #tooltip .conn.callees { color: #3fb950; }
        
        #detail-panel {
            position: absolute;
            top: 16px;
            right: 16px;
            width: 300px;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 12px;
            display: none;
            overflow: hidden;
        }
        
        #detail-panel.visible { display: block; }
        
        .detail-header {
            padding: 16px;
            background: #21262d;
            border-bottom: 1px solid #30363d;
        }
        
        .detail-title {
            font-family: monospace;
            color: #ffa657;
            font-size: 1.1em;
            word-break: break-all;
        }
        
        .detail-file {
            color: #58a6ff;
            font-size: 0.85em;
            margin-top: 4px;
        }
        
        .detail-close {
            position: absolute;
            top: 12px;
            right: 12px;
            background: none;
            border: none;
            color: #8b949e;
            font-size: 1.2em;
            cursor: pointer;
        }
        
        .detail-close:hover { color: #e6edf3; }
        
        .detail-section {
            padding: 12px 16px;
            border-bottom: 1px solid #30363d;
        }
        
        .detail-section:last-child { border-bottom: none; }
        
        .detail-section h4 {
            font-size: 0.75em;
            text-transform: uppercase;
            color: #8b949e;
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }
        
        .detail-list {
            max-height: 150px;
            overflow-y: auto;
        }
        
        .detail-item {
            padding: 6px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-family: monospace;
            font-size: 0.85em;
            margin-bottom: 2px;
            transition: background 0.15s;
        }
        
        .detail-item:hover { background: #21262d; }
        .detail-item.caller { color: #f85149; }
        .detail-item.callee { color: #3fb950; }
        
        .controls {
            position: absolute;
            bottom: 16px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 8px;
            background: #161b22;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid #30363d;
        }
        
        .controls button {
            padding: 6px 12px;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 4px;
            color: #e6edf3;
            cursor: pointer;
            font-size: 0.85em;
        }
        
        .controls button:hover { background: #30363d; }
        
        .legend {
            position: absolute;
            bottom: 16px;
            right: 16px;
            background: #161b22;
            padding: 12px 16px;
            border-radius: 8px;
            border: 1px solid #30363d;
            font-size: 0.8em;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
        }
        
        .legend-item:last-child { margin-bottom: 0; }
        
        .legend-circle {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        
        .breadcrumb {
            position: absolute;
            top: 16px;
            left: 16px;
            display: flex;
            gap: 8px;
            align-items: center;
            background: #161b22;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid #30363d;
            font-size: 0.85em;
        }
        
        .breadcrumb-item {
            color: #58a6ff;
            cursor: pointer;
        }
        
        .breadcrumb-item:hover { text-decoration: underline; }
        .breadcrumb-sep { color: #484f58; }
        .breadcrumb-current { color: #ffa657; }
    </style>
</head>
<body>
    <div id="container">
        <div id="sidebar">
            <div class="sidebar-header">
                <h1>🔮 Code Graph</h1>
                <div class="stats">
                    <div class="stat">
                        <div class="stat-value">${nodes.length}</div>
                        <div class="stat-label">Functions</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${links.length}</div>
                        <div class="stat-label">Connections</div>
                    </div>
                </div>
            </div>
            <input type="text" class="search-box" placeholder="@astracode Search functions..." id="search">
            <div class="file-filter">
                <select id="fileFilter">
                    <option value="">All Files</option>
                </select>
            </div>
            <div class="func-list" id="funcList"></div>
        </div>
        <div id="graph">
            <div id="tooltip">
                <h3 id="tooltipTitle"></h3>
                <div class="info" id="tooltipInfo"></div>
                <div class="connections">
                    <div class="conn callers">◀ <span id="tooltipCallers">0</span> callers</div>
                    <div class="conn callees">▶ <span id="tooltipCallees">0</span> calls</div>
                </div>
            </div>
            <div class="breadcrumb" id="breadcrumb" style="display:none;">
                <span class="breadcrumb-item" onclick="resetView()">All</span>
                <span class="breadcrumb-sep">→</span>
                <span class="breadcrumb-current" id="breadcrumbCurrent"></span>
            </div>
            <div id="detail-panel">
                <button class="detail-close" onclick="closeDetail()">×</button>
                <div class="detail-header">
                    <div class="detail-title" id="detailTitle"></div>
                    <div class="detail-file" id="detailFile"></div>
                </div>
                <div class="detail-section">
                    <h4>◀ Called By (<span id="callerCount">0</span>)</h4>
                    <div class="detail-list" id="callerList"></div>
                </div>
                <div class="detail-section">
                    <h4>▶ Calls (<span id="calleeCount">0</span>)</h4>
                    <div class="detail-list" id="calleeList"></div>
                </div>
            </div>
            <div class="controls">
                <button onclick="resetView()">Reset View</button>
                <button onclick="zoomIn()">Zoom +</button>
                <button onclick="zoomOut()">Zoom -</button>
            </div>
            <div class="legend">
                <div class="legend-item"><div class="legend-circle" style="background:#f85149"></div> Callers</div>
                <div class="legend-item"><div class="legend-circle" style="background:#3fb950"></div> Callees</div>
                <div class="legend-item"><div class="legend-circle" style="background:#58a6ff"></div> Selected</div>
            </div>
        </div>
    </div>
    
    <script>
        const nodes = ${nodesJson};
        const links = ${linksJson};
        const files = ${filesJson};
        
        // Color scale for files
        const colorScale = d3.scaleOrdinal()
            .domain(files)
            .range(d3.schemeTableau10);
        
        // Size scale based on connections
        const sizeScale = d3.scaleSqrt()
            .domain([0, d3.max(nodes, d => d.callers + d.calls)])
            .range([8, 40]);
        
        // Setup SVG
        const graphEl = document.getElementById('graph');
        const width = graphEl.clientWidth;
        const height = graphEl.clientHeight;
        
        const svg = d3.select('#graph')
            .append('svg')
            .attr('width', width)
            .attr('height', height);
        
        // Create container for zoom
        const g = svg.append('g');
        
        // Zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);
            });
        
        svg.call(zoom);
        
        // Arrow marker
        svg.append('defs').append('marker')
            .attr('id', 'arrowhead')
            .attr('viewBox', '-0 -5 10 10')
            .attr('refX', 20)
            .attr('refY', 0)
            .attr('orient', 'auto')
            .attr('markerWidth', 6)
            .attr('markerHeight', 6)
            .append('path')
            .attr('d', 'M 0,-5 L 10,0 L 0,5')
            .attr('fill', '#30363d');
        
        // Simulation
        const simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(links).id(d => d.id).distance(100))
            .force('charge', d3.forceManyBody().strength(-300))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide().radius(d => sizeScale(d.callers + d.calls) + 5));
        
        // Links
        const link = g.append('g')
            .selectAll('line')
            .data(links)
            .join('line')
            .attr('class', 'link')
            .attr('marker-end', 'url(#arrowhead)');
        
        // Nodes
        const node = g.append('g')
            .selectAll('g')
            .data(nodes)
            .join('g')
            .attr('class', 'node')
            .call(d3.drag()
                .on('start', dragstarted)
                .on('drag', dragged)
                .on('end', dragended));
        
        node.append('circle')
            .attr('r', d => sizeScale(d.callers + d.calls))
            .attr('fill', d => colorScale(d.file))
            .on('click', (event, d) => selectNode(d))
            .on('dblclick', (event, d) => drillInto(d))
            .on('mouseover', showTooltip)
            .on('mouseout', hideTooltip);
        
        node.append('text')
            .attr('dy', d => sizeScale(d.callers + d.calls) + 12)
            .attr('text-anchor', 'middle')
            .text(d => d.name.length > 20 ? d.name.substring(0, 18) + '...' : d.name);
        
        simulation.on('tick', () => {
            link
                .attr('x1', d => d.source.x)
                .attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x)
                .attr('y2', d => d.target.y);
            
            node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
        });
        
        // Drag functions
        function dragstarted(event) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
        }
        
        function dragged(event) {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
        }
        
        function dragended(event) {
            if (!event.active) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
        }
        
        // Tooltip
        const tooltip = document.getElementById('tooltip');
        
        function showTooltip(event, d) {
            document.getElementById('tooltipTitle').textContent = d.name;
            document.getElementById('tooltipInfo').textContent = d.file + ':' + d.line;
            document.getElementById('tooltipCallers').textContent = d.callers;
            document.getElementById('tooltipCallees').textContent = d.calls;
            
            tooltip.style.left = (event.pageX + 15) + 'px';
            tooltip.style.top = (event.pageY - 10) + 'px';
            tooltip.classList.add('visible');
        }
        
        function hideTooltip() {
            tooltip.classList.remove('visible');
        }
        
        // Selection
        let selectedNode = null;
        
        function selectNode(d) {
            selectedNode = d;
            
            // Update node classes
            node.classed('selected', n => n === d);
            node.classed('dimmed', n => {
                if (n === d) return false;
                if (d.callerNames.includes(n.name)) return false;
                if (d.calleeNames.includes(n.name)) return false;
                return true;
            });
            
            // Update link classes
            link.classed('highlighted', false);
            link.classed('caller', l => l.target.id === d.id);
            link.classed('callee', l => l.source.id === d.id);
            link.classed('dimmed', l => {
                return l.source.id !== d.id && l.target.id !== d.id;
            });
            
            // Show detail panel
            showDetail(d);
            
            // Update sidebar selection
            document.querySelectorAll('.func-item').forEach(el => {
                el.classList.toggle('selected', el.dataset.name === d.name);
            });
        }
        
        function showDetail(d) {
            document.getElementById('detailTitle').textContent = d.name;
            document.getElementById('detailFile').textContent = d.file + ':' + d.line;
            document.getElementById('callerCount').textContent = d.callerNames.length;
            document.getElementById('calleeCount').textContent = d.calleeNames.length;
            
            const callerList = document.getElementById('callerList');
            callerList.innerHTML = d.callerNames.map(name => 
                \`<div class="detail-item caller" onclick="navigateTo('\${name}')">\${name}</div>\`
            ).join('') || '<div style="color:#8b949e;padding:8px;">No callers</div>';
            
            const calleeList = document.getElementById('calleeList');
            calleeList.innerHTML = d.calleeNames.map(name =>
                \`<div class="detail-item callee" onclick="navigateTo('\${name}')">\${name}</div>\`
            ).join('') || '<div style="color:#8b949e;padding:8px;">No calls</div>';
            
            document.getElementById('detail-panel').classList.add('visible');
        }
        
        function closeDetail() {
            document.getElementById('detail-panel').classList.remove('visible');
            resetHighlights();
        }
        
        function resetHighlights() {
            selectedNode = null;
            node.classed('selected', false);
            node.classed('dimmed', false);
            link.classed('highlighted', false);
            link.classed('caller', false);
            link.classed('callee', false);
            link.classed('dimmed', false);
            document.querySelectorAll('.func-item').forEach(el => el.classList.remove('selected'));
        }
        
        function navigateTo(name) {
            const n = nodes.find(n => n.name === name);
            if (n) {
                selectNode(n);
                // Center on node
                const transform = d3.zoomIdentity
                    .translate(width / 2 - n.x, height / 2 - n.y)
                    .scale(1.5);
                svg.transition().duration(500).call(zoom.transform, transform);
            }
        }
        
        function drillInto(d) {
            // Show only this node and its direct connections
            const connectedNames = new Set([d.name, ...d.callerNames, ...d.calleeNames]);
            
            node.style('display', n => connectedNames.has(n.name) ? null : 'none');
            link.style('display', l => {
                return (l.source.name === d.name || l.target.name === d.name) ? null : 'none';
            });
            
            // Show breadcrumb
            document.getElementById('breadcrumb').style.display = 'flex';
            document.getElementById('breadcrumbCurrent').textContent = d.name;
            
            // Recenter
            simulation.alpha(0.3).restart();
        }
        
        function resetView() {
            node.style('display', null);
            link.style('display', null);
            document.getElementById('breadcrumb').style.display = 'none';
            resetHighlights();
            closeDetail();
            
            // Reset zoom
            svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
            simulation.alpha(0.3).restart();
        }
        
        function zoomIn() {
            svg.transition().call(zoom.scaleBy, 1.5);
        }
        
        function zoomOut() {
            svg.transition().call(zoom.scaleBy, 0.67);
        }
        
        // Populate sidebar
        const funcList = document.getElementById('funcList');
        const fileFilter = document.getElementById('fileFilter');
        
        files.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            fileFilter.appendChild(opt);
        });
        
        function renderFuncList(filter = '', fileFilterVal = '') {
            const filtered = nodes.filter(n => {
                const matchesSearch = n.name.toLowerCase().includes(filter.toLowerCase());
                const matchesFile = !fileFilterVal || n.file === fileFilterVal;
                return matchesSearch && matchesFile;
            }).sort((a, b) => (b.callers + b.calls) - (a.callers + a.calls));
            
            funcList.innerHTML = filtered.slice(0, 100).map(n => \`
                <div class="func-item" data-name="\${n.name}" onclick="navigateTo('\${n.name}')">
                    <div class="func-name">\${n.name}</div>
                    <div class="func-meta">
                        <span class="file">\${n.file}</span>
                        <span>◀\${n.callers} ▶\${n.calls}</span>
                    </div>
                </div>
            \`).join('');
        }
        
        renderFuncList();
        
        document.getElementById('search').addEventListener('input', e => {
            renderFuncList(e.target.value, fileFilter.value);
        });
        
        fileFilter.addEventListener('change', e => {
            renderFuncList(document.getElementById('search').value, e.target.value);
        });
        
        // Initial zoom to fit
        setTimeout(() => {
            const bounds = g.node().getBBox();
            const fullWidth = bounds.width;
            const fullHeight = bounds.height;
            const midX = bounds.x + fullWidth / 2;
            const midY = bounds.y + fullHeight / 2;
            const scale = 0.8 / Math.max(fullWidth / width, fullHeight / height);
            const translate = [width / 2 - scale * midX, height / 2 - scale * midY];
            
            svg.transition().duration(750).call(
                zoom.transform,
                d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
            );
        }, 1000);
    </script>
</body>
</html>`;
}

// ============================================================
// Vector Indexing (Semantic Search)
// ============================================================

/**
 * Simple hash-based embedding (fast, no dependencies)
 * Uses character n-grams and word frequencies to create a fixed-size vector
 * Not as good as neural embeddings but works offline with zero setup
 */
function simpleHashEmbedding(text, dimensions = 384) {
    const embedding = new Float32Array(dimensions);
    
    // Normalize text
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words = normalized.split(/\s+/).filter(w => w.length > 1);
    
    // Word-level features (TF-like)
    for (const word of words) {
        const hash = simpleHash(word);
        const idx = Math.abs(hash) % dimensions;
        embedding[idx] += 1;
        
        // Also add character trigrams for partial matching
        for (let i = 0; i < word.length - 2; i++) {
            const trigram = word.substring(i, i + 3);
            const trigramHash = simpleHash(trigram);
            const trigramIdx = Math.abs(trigramHash) % dimensions;
            embedding[trigramIdx] += 0.5;
        }
    }
    
    // Add bigrams for phrase matching
    for (let i = 0; i < words.length - 1; i++) {
        const bigram = words[i] + '_' + words[i + 1];
        const hash = simpleHash(bigram);
        const idx = Math.abs(hash) % dimensions;
        embedding[idx] += 0.7;
    }
    
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            embedding[i] /= norm;
        }
    }
    
    return embedding;
}

/**
 * Simple string hash function (djb2)
 */
function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

// ============================================================
// TRIGRAM INDEX (Zoekt-style) - Fast Exact/Partial Text Search
// ============================================================

/**
 * Extract trigrams from text
 * @param {string} text - Text to extract trigrams from
 * @param {boolean} caseSensitive - Whether to preserve case
 * @returns {string[]} Array of trigrams
 */
function extractTrigrams(text, caseSensitive = false) {
    const normalized = caseSensitive ? text : text.toLowerCase();
    const trigrams = [];
    
    for (let i = 0; i <= normalized.length - 3; i++) {
        const trigram = normalized.substring(i, i + 3);
        // Skip trigrams that are all whitespace
        if (!/^\s+$/.test(trigram)) {
            trigrams.push(trigram);
        }
    }
    
    return trigrams;
}

/**
 * Build trigram index for a single file
 * @param {string} filePath - File path
 * @param {string} content - File content
 */
function indexFileWithTrigrams(filePath, content) {
    if (!content || content.length > TRIGRAM_CONFIG.MAX_FILE_SIZE) {
        return;
    }
    
    const caseSensitive = TRIGRAM_CONFIG.CASE_SENSITIVE;
    const normalized = caseSensitive ? content : content.toLowerCase();
    
    // Store content for verification
    trigramIndex.fileContent.set(filePath, content);
    
    // Track unique trigrams for this file
    const fileTrigramPositions = new Map(); // trigram → positions[]
    
    for (let i = 0; i <= normalized.length - 3; i++) {
        const trigram = normalized.substring(i, i + 3);
        
        // Skip whitespace-only trigrams
        if (/^\s+$/.test(trigram)) continue;
        
        if (!fileTrigramPositions.has(trigram)) {
            fileTrigramPositions.set(trigram, []);
        }
        
        const positions = fileTrigramPositions.get(trigram);
        if (positions.length < TRIGRAM_CONFIG.MAX_POSITIONS_PER_FILE) {
            positions.push(i);
        }
    }
    
    // Add to global index
    for (const [trigram, positions] of fileTrigramPositions) {
        if (!trigramIndex.index.has(trigram)) {
            trigramIndex.index.set(trigram, []);
        }
        trigramIndex.index.get(trigram).push({ file: filePath, positions });
        trigramIndex.stats.totalPositions += positions.length;
    }
    
    trigramIndex.stats.files++;
}

/**
 * Build trigram index for all context files
 */
async function buildTrigramIndex(options = {}) {
    const { showProgressUI = false, onProgress = null } = options;
    
    const startTime = Date.now();
    log('=== BUILDING TRIGRAM INDEX ===');
    
    // Clear existing
    trigramIndex.index.clear();
    trigramIndex.fileContent.clear();
    trigramIndex.stats = { trigrams: 0, files: 0, totalPositions: 0 };
    
    let fileCount = 0;
    const totalFiles = contextFiles.size;
    
    for (const [filePath, fileInfo] of contextFiles) {
        indexFileWithTrigrams(filePath, fileInfo.content);
        fileCount++;
        
        if (onProgress && fileCount % 10 === 0) {
            const pct = Math.round((fileCount / totalFiles) * 100);
            onProgress(pct, `Indexing trigrams: ${fileCount}/${totalFiles} files`);
        }
        
        // Yield to UI
        if (fileCount % 20 === 0) {
            await new Promise(r => setTimeout(r, 1));
        }
    }
    
    trigramIndex.stats.trigrams = trigramIndex.index.size;
    trigramIndex.lastUpdated = new Date();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Trigram index built: ${trigramIndex.stats.trigrams} unique trigrams, ${trigramIndex.stats.files} files, ${trigramIndex.stats.totalPositions} positions in ${elapsed}s`);
    
    if (showProgressUI) {
        showProgress(`Trigram index: ${trigramIndex.stats.trigrams} trigrams from ${trigramIndex.stats.files} files`, 'index');
    }
}

/**
 * Lightweight trigram index builder for initial indexing
 * Limits files and sizes for faster startup
 */
async function buildTrigramIndexLightweight(options = {}) {
    const { 
        maxFilesToIndex = 300,
        maxFileSize = 50000,
        prioritizeByExtension = true
    } = options;
    
    const startTime = Date.now();
    log('=== BUILDING LIGHTWEIGHT TRIGRAM INDEX ===');
    
    // Clear existing
    trigramIndex.index.clear();
    trigramIndex.fileContent.clear();
    trigramIndex.stats = { trigrams: 0, files: 0, totalPositions: 0 };
    
    // Prioritize code files over headers/configs
    const codeExtensions = new Set(['.c', '.cpp', '.java', '.py', '.js', '.ts', '.go', '.rs', '.tal', '.cob', '.sql']);
    const files = Array.from(contextFiles.entries());
    
    // Sort: code files first, then by size (smaller first for speed)
    if (prioritizeByExtension) {
        files.sort((a, b) => {
            const extA = a[0].substring(a[0].lastIndexOf('.')).toLowerCase();
            const extB = b[0].substring(b[0].lastIndexOf('.')).toLowerCase();
            const isCodeA = codeExtensions.has(extA) ? 0 : 1;
            const isCodeB = codeExtensions.has(extB) ? 0 : 1;
            if (isCodeA !== isCodeB) return isCodeA - isCodeB;
            return (a[1].content?.length || 0) - (b[1].content?.length || 0);
        });
    }
    
    let fileCount = 0;
    
    for (const [filePath, fileInfo] of files) {
        if (fileCount >= maxFilesToIndex) break;
        
        const content = fileInfo.content || '';
        if (content.length > maxFileSize) {
            // Index just the first portion of large files
            indexFileWithTrigrams(filePath, content.substring(0, maxFileSize));
        } else {
            indexFileWithTrigrams(filePath, content);
        }
        fileCount++;
        
        // Yield occasionally
        if (fileCount % 50 === 0) {
            await new Promise(r => setTimeout(r, 1));
        }
    }
    
    trigramIndex.stats.trigrams = trigramIndex.index.size;
    trigramIndex.lastUpdated = new Date();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Lightweight trigram index: ${trigramIndex.stats.trigrams} trigrams from ${fileCount} files in ${elapsed}s`);
}

/**
 * Search trigram index for exact/partial matches
 * @param {string} query - Search query (min 3 chars)
 * @param {Object} options - Search options
 * @returns {Array<{file: string, matches: Array<{position: number, line: number, context: string}>}>}
 */
function searchTrigramIndex(query, options = {}) {
    const {
        caseSensitive = TRIGRAM_CONFIG.CASE_SENSITIVE,
        maxResults = TRIGRAM_CONFIG.MAX_RESULTS,
        contextChars = 100
    } = options;
    
    if (query.length < TRIGRAM_CONFIG.MIN_QUERY_LENGTH) {
        log('Trigram search: Query too short (min 3 chars)');
        return [];
    }
    
    const queryTrigrams = extractTrigrams(query, caseSensitive);
    if (queryTrigrams.length === 0) {
        return [];
    }
    
    log(`Trigram search: "${query}" → ${queryTrigrams.length} trigrams`);
    
    // Find candidate files by intersecting trigram posting lists
    // Start with files containing the first trigram, then filter
    let candidateFiles = null;
    
    for (const trigram of queryTrigrams) {
        const postings = trigramIndex.index.get(trigram);
        if (!postings || postings.length === 0) {
            // Trigram not found - no matches possible
            log(`Trigram search: trigram "${trigram}" not found, no results`);
            return [];
        }
        
        const filesWithTrigram = new Set(postings.map(p => p.file));
        
        if (candidateFiles === null) {
            candidateFiles = filesWithTrigram;
        } else {
            // Intersect
            candidateFiles = new Set([...candidateFiles].filter(f => filesWithTrigram.has(f)));
        }
        
        if (candidateFiles.size === 0) {
            return [];
        }
    }
    
    log(`Trigram search: ${candidateFiles.size} candidate files`);
    
    // Verify actual matches in candidate files
    const results = [];
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();
    
    for (const filePath of candidateFiles) {
        const content = trigramIndex.fileContent.get(filePath);
        if (!content) continue;
        
        const normalizedContent = caseSensitive ? content : content.toLowerCase();
        const matches = [];
        
        let pos = 0;
        while (pos < normalizedContent.length && matches.length < 50) {
            const matchPos = normalizedContent.indexOf(normalizedQuery, pos);
            if (matchPos === -1) break;
            
            // Calculate line number
            const lineNum = content.substring(0, matchPos).split('\n').length;
            
            // Extract context
            const contextStart = Math.max(0, matchPos - contextChars);
            const contextEnd = Math.min(content.length, matchPos + query.length + contextChars);
            let context = content.substring(contextStart, contextEnd);
            
            // Clean up context
            if (contextStart > 0) context = '...' + context;
            if (contextEnd < content.length) context = context + '...';
            
            matches.push({
                position: matchPos,
                line: lineNum,
                context: context.replace(/\n/g, ' ').trim()
            });
            
            pos = matchPos + 1;
        }
        
        if (matches.length > 0) {
            results.push({
                file: filePath,
                fileName: filePath.split('/').pop(),
                matchCount: matches.length,
                matches
            });
        }
        
        if (results.length >= maxResults) break;
    }
    
    // Sort by match count
    results.sort((a, b) => b.matchCount - a.matchCount);
    
    log(`Trigram search: found ${results.length} files with matches`);
    return results;
}

// ============================================================
// TF-IDF EMBEDDINGS - Better Semantic Search
// ============================================================

/**
 * Tokenize text for TF-IDF
 * Handles code-specific patterns (camelCase, snake_case, etc.)
 */
function tokenizeForTfidf(text) {
    // Split camelCase and snake_case
    const expanded = text
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
        .replace(/_/g, ' ')                    // snake_case → snake case
        .toLowerCase();
    
    // Extract words and meaningful tokens
    const tokens = expanded
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && t.length <= 30);
    
    return tokens;
}

/**
 * Build TF-IDF vocabulary from all chunks
 */
function buildTfidfVocabulary(chunks) {
    const startTime = Date.now();
    log('Building TF-IDF vocabulary...');
    
    // Clear existing
    tfidfVocabulary.terms.clear();
    tfidfVocabulary.numDocs = chunks.length;
    
    // Count document frequency for each term
    const docFreq = new Map(); // term → number of docs containing it
    
    for (const chunk of chunks) {
        const tokens = tokenizeForTfidf(chunk.text);
        const uniqueTokens = new Set(tokens);
        
        for (const token of uniqueTokens) {
            docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
    }
    
    // Filter vocabulary - keep terms that appear in at least 2 docs but not more than 80% of docs
    const minDf = 2;
    const maxDf = Math.floor(chunks.length * 0.8);
    
    let termIndex = 0;
    for (const [term, df] of docFreq) {
        if (df >= minDf && df <= maxDf) {
            tfidfVocabulary.terms.set(term, { index: termIndex, df });
            termIndex++;
        }
    }
    
    // Compute IDF values
    const numTerms = tfidfVocabulary.terms.size;
    tfidfVocabulary.idf = new Float32Array(numTerms);
    
    for (const [term, info] of tfidfVocabulary.terms) {
        // IDF = log(N / df) with smoothing
        tfidfVocabulary.idf[info.index] = Math.log((chunks.length + 1) / (info.df + 1)) + 1;
    }
    
    tfidfVocabulary.built = true;
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`TF-IDF vocabulary: ${numTerms} terms from ${docFreq.size} unique tokens in ${elapsed}s`);
}

/**
 * Generate TF-IDF embedding for text
 * @param {string} text - Text to embed
 * @param {number} dimensions - Target dimensions (uses hashing for fixed size)
 * @returns {Float32Array} Embedding vector
 */
function tfidfEmbedding(text, dimensions = 384) {
    const embedding = new Float32Array(dimensions);
    
    if (!tfidfVocabulary.built) {
        // Fallback to simple hash if vocabulary not built
        return simpleHashEmbedding(text, dimensions);
    }
    
    const tokens = tokenizeForTfidf(text);
    
    // Count term frequencies
    const tf = new Map();
    for (const token of tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
    }
    
    // Compute TF-IDF weighted embedding
    for (const [token, count] of tf) {
        const termInfo = tfidfVocabulary.terms.get(token);
        if (!termInfo) continue;
        
        // TF-IDF weight
        const tfWeight = 1 + Math.log(count); // log-normalized TF
        const tfidfWeight = tfWeight * tfidfVocabulary.idf[termInfo.index];
        
        // Hash to dimension (multiple hashes for better distribution)
        const hash1 = simpleHash(token);
        const hash2 = simpleHash(token + '_2');
        const idx1 = Math.abs(hash1) % dimensions;
        const idx2 = Math.abs(hash2) % dimensions;
        
        embedding[idx1] += tfidfWeight;
        embedding[idx2] += tfidfWeight * 0.5;
        
        // Add character trigrams for partial matching
        for (let i = 0; i < token.length - 2; i++) {
            const trigram = token.substring(i, i + 3);
            const trigramHash = simpleHash(trigram);
            const trigramIdx = Math.abs(trigramHash) % dimensions;
            embedding[trigramIdx] += tfidfWeight * 0.3;
        }
    }
    
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            embedding[i] /= norm;
        }
    }
    
    return embedding;
}

/**
 * Generate embedding using configured method
 */
function generateEmbedding(text, dimensions = 384) {
    if (vectorIndex.model === 'tfidf' && tfidfVocabulary.built) {
        return tfidfEmbedding(text, dimensions);
    } else {
        return simpleHashEmbedding(text, dimensions);
    }
}

/**
 * Chunk code into semantic units (functions, classes, blocks)
 */
function chunkCodeForEmbedding(filePath, content, language) {
    const chunks = [];
    
    if (!content) {
        log('chunkCodeForEmbedding: No content for', filePath);
        return chunks;
    }
    
    const lines = content.split('\n');
    const fileName = filePath.split('/').pop();
    
    log('chunkCodeForEmbedding:', fileName, '-', lines.length, 'lines,', content.length, 'chars');
    
    // Get symbols from code index if available
    const fileInfo = codeIndex.files.get(filePath);
    const symbols = fileInfo?.symbols || [];
    
    log('  Symbols from codeIndex:', symbols.length);
    
    // Strategy 1: Chunk by symbols (functions, classes)
    const functionSymbols = symbols.filter(s => 
        ['function', 'method', 'procedure', 'subproc', 'class', 'struct'].includes(s.type)
    );
    
    log('  Function symbols:', functionSymbols.length);
    
    if (functionSymbols.length > 0) {
        // Sort by line number
        functionSymbols.sort((a, b) => a.line - b.line);
        
        for (let i = 0; i < functionSymbols.length && chunks.length < VECTOR_CONFIG.MAX_CHUNKS_PER_FILE; i++) {
            const sym = functionSymbols[i];
            const startLine = Math.max(0, sym.line - 1);
            const nextSym = functionSymbols[i + 1];
            const endLine = nextSym ? Math.min(nextSym.line - 2, startLine + 100) : Math.min(startLine + 100, lines.length - 1);
            
            const chunkText = lines.slice(startLine, endLine + 1).join('\n');
            
            if (chunkText.length >= VECTOR_CONFIG.MIN_CHUNK_SIZE) {
                chunks.push({
                    id: `${filePath}:${sym.name}`,
                    text: chunkText,
                    file: filePath,
                    fileName: fileName,
                    startLine: startLine + 1,
                    endLine: endLine + 1,
                    type: sym.type,
                    symbolName: sym.name,
                    embedding: null
                });
            }
        }
    }
    
    // Strategy 2: If no symbols or file is small, chunk by lines
    if (chunks.length === 0) {
        const chunkSize = 30; // lines per chunk
        const overlap = 5;
        
        for (let i = 0; i < lines.length && chunks.length < VECTOR_CONFIG.MAX_CHUNKS_PER_FILE; i += chunkSize - overlap) {
            const startLine = i;
            const endLine = Math.min(i + chunkSize, lines.length);
            const chunkText = lines.slice(startLine, endLine).join('\n');
            
            if (chunkText.length >= VECTOR_CONFIG.MIN_CHUNK_SIZE) {
                chunks.push({
                    id: `${filePath}:L${startLine + 1}-${endLine}`,
                    text: chunkText,
                    file: filePath,
                    fileName: fileName,
                    startLine: startLine + 1,
                    endLine: endLine,
                    type: 'block',
                    symbolName: null,
                    embedding: null
                });
            }
        }
    }
    
    // Also add file-level summary chunk (first ~50 lines with comments)
    const headerLines = lines.slice(0, Math.min(50, lines.length));
    const headerText = headerLines.join('\n');
    if (headerText.length >= VECTOR_CONFIG.MIN_CHUNK_SIZE && !chunks.some(c => c.startLine === 1)) {
        chunks.unshift({
            id: `${filePath}:header`,
            text: headerText,
            file: filePath,
            fileName: fileName,
            startLine: 1,
            endLine: Math.min(50, lines.length),
            type: 'header',
            symbolName: null,
            embedding: null
        });
    }
    
    log('  Final chunks for', fileName, ':', chunks.length);
    return chunks;
}

/**
 * Build vector index for all context files
 */
async function buildVectorIndex(options = {}) {
    const { showProgress = true, onProgress = null } = options;
    
    if (vectorIndex.isBuilding) {
        log('Vector index build already in progress');
        return;
    }
    
    vectorIndex.isBuilding = true;
    log('=== BUILDING VECTOR INDEX ===');
    log('contextFiles count:', contextFiles.size);
    
    const startTime = Date.now();
    
    try {
        // Clear existing
        vectorIndex.chunks = [];
        vectorIndex.embeddings = null;
        
        // PHASE 1: Build Trigram Index (for exact text search)
        log('Phase 1: Building trigram index...');
        if (onProgress) {
            onProgress(5, 'Building trigram index...');
        }
        await buildTrigramIndex({ showProgressUI: false });
        
        // PHASE 2: Collect all chunks from context files
        log('Phase 2: Chunking files...');
        const allChunks = [];
        let fileCount = 0;
        const totalFiles = contextFiles.size;
        
        for (const [filePath, fileInfo] of contextFiles) {
            log('Chunking file:', filePath, '(', fileInfo.content?.length || 0, 'chars)');
            const chunks = chunkCodeForEmbedding(filePath, fileInfo.content, fileInfo.language);
            log('  Created', chunks.length, 'chunks for', filePath.split('/').pop());
            allChunks.push(...chunks);
            fileCount++;
            
            if (showProgress && onProgress) {
                const pct = 10 + Math.round((fileCount / totalFiles) * 30); // 10-40% is chunking
                onProgress(pct, `Chunking ${fileCount}/${totalFiles} files...`);
            }
            
            // Yield to UI periodically
            if (fileCount % 10 === 0) {
                await new Promise(r => setTimeout(r, 1));
            }
        }
        
        log(`Total chunks created: ${allChunks.length} from ${totalFiles} files`);
        
        if (allChunks.length === 0) {
            log('WARNING: No chunks created!');
            vectorIndex.isBuilding = false;
            return;
        }
        
        // PHASE 3: Build TF-IDF vocabulary
        log('Phase 3: Building TF-IDF vocabulary...');
        if (onProgress) {
            onProgress(45, 'Building TF-IDF vocabulary...');
        }
        buildTfidfVocabulary(allChunks);
        
        // PHASE 4: Generate embeddings using TF-IDF
        log('Phase 4: Generating embeddings...');
        const dimensions = vectorIndex.dimensions;
        const embeddings = new Float32Array(allChunks.length * dimensions);
        
        for (let i = 0; i < allChunks.length; i++) {
            const chunk = allChunks[i];
            const embedding = generateEmbedding(chunk.text, dimensions);
            
            // Store in flat array
            embeddings.set(embedding, i * dimensions);
            
            // Also store reference in chunk (for convenience)
            chunk.embedding = embedding;
            
            if (showProgress && onProgress && i % 50 === 0) {
                const pct = 50 + Math.round((i / allChunks.length) * 45); // 50-95% is embedding
                onProgress(pct, `Embedding ${i}/${allChunks.length} chunks...`);
            }
            
            // Yield periodically
            if (i % 100 === 0) {
                await new Promise(r => setTimeout(r, 1));
            }
        }
        
        vectorIndex.chunks = allChunks;
        vectorIndex.embeddings = embeddings;
        vectorIndex.lastUpdated = new Date();
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`Vector index built: ${allChunks.length} chunks, ${trigramIndex.stats.trigrams} trigrams in ${elapsed}s`);
        
        if (onProgress) {
            onProgress(100, `✓ ${allChunks.length} chunks + ${trigramIndex.stats.trigrams} trigrams indexed`);
        }
        
        // Persist to disk
        await saveVectorIndex();
        
    } catch (error) {
        log('Error building vector index:', error.message);
    } finally {
        vectorIndex.isBuilding = false;
    }
}

/**
 * Search vector index for similar chunks
 */
function searchVectorIndex(query, topK = VECTOR_CONFIG.TOP_K_RESULTS) {
    log('searchVectorIndex called - chunks:', vectorIndex.chunks.length, 'query:', query.substring(0, 50));
    
    if (vectorIndex.chunks.length === 0) {
        log('Vector index is empty');
        return [];
    }
    
    // Embed the query using same method as index
    const queryEmbedding = generateEmbedding(query, vectorIndex.dimensions);
    log('Query embedded, dimensions:', queryEmbedding.length, 'model:', vectorIndex.model);
    
    // Calculate similarities
    const results = [];
    const dimensions = vectorIndex.dimensions;
    let maxSimilarity = 0;
    let minSimilarity = 1;
    
    for (let i = 0; i < vectorIndex.chunks.length; i++) {
        const chunk = vectorIndex.chunks[i];
        
        // Get embedding from flat array
        const chunkEmbedding = vectorIndex.embeddings 
            ? vectorIndex.embeddings.slice(i * dimensions, (i + 1) * dimensions)
            : chunk.embedding;
        
        if (!chunkEmbedding) continue;
        
        const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
        maxSimilarity = Math.max(maxSimilarity, similarity);
        minSimilarity = Math.min(minSimilarity, similarity);
        
        if (similarity >= VECTOR_CONFIG.SIMILARITY_THRESHOLD) {
            results.push({
                ...chunk,
                similarity,
                source: 'vector'
            });
        }
    }
    
    log('Vector similarity range:', minSimilarity.toFixed(3), '-', maxSimilarity.toFixed(3), 
        'threshold:', VECTOR_CONFIG.SIMILARITY_THRESHOLD, 'matches above threshold:', results.length);
    
    // Sort by similarity and return top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
}

/**
 * Hybrid Search - Clean 3-Layer Architecture
 * 
 * Layer 1: SYMBOL INDEX - Structured lookups (functions, classes, variables)
 * Layer 2: TRIGRAM INDEX - Exact/partial text search (replaces grep)
 * Layer 3: VECTOR INDEX - Semantic similarity search (TF-IDF)
 * 
 * Results are merged and boosted when found by multiple methods.
 */
async function hybridSearch(query, options = {}) {
    const { maxResults = 20, includeVector = true } = options;
    
    log('=== HYBRID SEARCH (3-Layer) ===');
    log('Query:', query);
    log('Index state - symbols:', codeIndex.symbols.size, 
        'trigrams:', trigramIndex.index.size, 
        'vectors:', vectorIndex.chunks.length);
    
    const results = new Map(); // key: file:line -> result data
    
    // ================================================================
    // LAYER 1: SYMBOL INDEX (Structured - functions, classes, variables)
    // ================================================================
    try {
        const symbolMatches = fuzzySearchSymbols(query, null, 25, 20);
        log('L1 Symbol: found', symbolMatches.length, 'matches');
        
        for (const match of symbolMatches) {
            const key = `${match.file}:${match.line}`;
            if (!results.has(key)) {
                results.set(key, {
                    file: match.file,
                    fileName: match.file?.split('/').pop() || 'unknown',
                    line: match.line || 1,
                    symbol: match.name,
                    type: match.type,
                    score: (match.matchScore || 50) / 100,
                    sources: new Set(['symbol']),
                    preview: match.signature || match.name
                });
            } else {
                results.get(key).sources.add('symbol');
                results.get(key).score = Math.max(results.get(key).score, (match.matchScore || 50) / 100);
            }
        }
    } catch (err) {
        log('L1 Symbol error:', err.message);
    }
    
    // ================================================================
    // LAYER 2: TRIGRAM INDEX (Exact text - replaces grep)
    // ================================================================
    if (trigramIndex.index.size > 0) {
        try {
            // Extract search terms from query
            const searchTerms = query
                .replace(/[^a-zA-Z0-9_]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 3);
            
            log('L2 Trigram: searching for', searchTerms.slice(0, 5));
            
            for (const term of searchTerms.slice(0, 5)) {
                const trigramResults = searchTrigramIndex(term, { maxResults: 15 });
                
                for (const fileResult of trigramResults) {
                    for (const match of fileResult.matches.slice(0, 5)) {
                        const key = `${fileResult.file}:${match.line}`;
                        if (!results.has(key)) {
                            results.set(key, {
                                file: fileResult.file,
                                fileName: fileResult.fileName,
                                line: match.line,
                                symbol: null,
                                type: 'text',
                                score: 0.8, // High score for exact matches
                                sources: new Set(['trigram']),
                                preview: match.context?.substring(0, 100)
                            });
                        } else {
                            results.get(key).sources.add('trigram');
                            results.get(key).score += 0.15; // Boost for exact match
                        }
                    }
                }
            }
            log('L2 Trigram: total results now', results.size);
        } catch (err) {
            log('L2 Trigram error:', err.message);
        }
    }
    
    // ================================================================
    // LAYER 3: VECTOR INDEX (Semantic - TF-IDF similarity)
    // ================================================================
    if (includeVector && vectorIndex.chunks.length > 0) {
        try {
            const vectorResults = searchVectorIndex(query, 15);
            log('L3 Vector: found', vectorResults.length, 'semantic matches');
            
            for (const match of vectorResults) {
                const key = `${match.file}:${match.startLine}`;
                if (!results.has(key)) {
                    results.set(key, {
                        file: match.file,
                        fileName: match.fileName,
                        line: match.startLine,
                        endLine: match.endLine,
                        symbol: match.symbolName,
                        type: match.type || 'semantic',
                        score: match.similarity * 0.85,
                        sources: new Set(['vector']),
                        preview: match.text?.substring(0, 100)
                    });
                } else {
                    results.get(key).sources.add('vector');
                    results.get(key).score += match.similarity * 0.25;
                }
            }
        } catch (err) {
            log('L3 Vector error:', err.message);
        }
    }
    
    // ================================================================
    // MERGE & RANK: Boost items found by multiple methods
    // ================================================================
    for (const [key, data] of results) {
        const sourceCount = data.sources.size;
        if (sourceCount > 1) {
            // Significant boost for multi-source matches
            data.score *= 1.0 + (sourceCount * 0.3);
            log(`Multi-source boost: ${key} (${Array.from(data.sources).join('+')})`);
        }
    }
    
    // Sort by score and return
    const sortedResults = Array.from(results.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
    
    log(`Hybrid search: ${sortedResults.length} results from ${results.size} candidates`);
    log('=== HYBRID SEARCH END ===');
    
    return sortedResults;
}

/**
 * Save vector index to disk
 */
async function saveVectorIndex() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    
    try {
        const astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'vectors');
        await vscode.workspace.fs.createDirectory(astraDir);
        
        // Save chunks metadata (without embeddings)
        const chunksData = vectorIndex.chunks.map(c => ({
            id: c.id,
            file: c.file,
            fileName: c.fileName,
            startLine: c.startLine,
            endLine: c.endLine,
            type: c.type,
            symbolName: c.symbolName,
            textLength: c.text.length
            // Note: text not saved to reduce size, can be reloaded from files
        }));
        
        const metadata = {
            version: 1,
            model: vectorIndex.model,
            dimensions: vectorIndex.dimensions,
            chunkCount: vectorIndex.chunks.length,
            lastUpdated: vectorIndex.lastUpdated?.toISOString(),
            chunks: chunksData
        };
        
        const metadataUri = vscode.Uri.joinPath(astraDir, 'index.json');
        await vscode.workspace.fs.writeFile(metadataUri, Buffer.from(JSON.stringify(metadata, null, 2)));
        
        // Save embeddings as binary
        if (vectorIndex.embeddings) {
            const embeddingsUri = vscode.Uri.joinPath(astraDir, 'embeddings.bin');
            const buffer = Buffer.from(vectorIndex.embeddings.buffer);
            await vscode.workspace.fs.writeFile(embeddingsUri, buffer);
        }
        
        log(`Vector index saved: ${vectorIndex.chunks.length} chunks`);
        
    } catch (error) {
        log('Error saving vector index:', error.message);
    }
}

/**
 * Load vector index from disk
 */
async function loadVectorIndex() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return false;
    
    try {
        const astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'vectors');
        
        // Load metadata
        const metadataUri = vscode.Uri.joinPath(astraDir, 'index.json');
        const metadataBytes = await vscode.workspace.fs.readFile(metadataUri);
        const metadata = JSON.parse(Buffer.from(metadataBytes).toString('utf8'));
        
        // Load embeddings
        const embeddingsUri = vscode.Uri.joinPath(astraDir, 'embeddings.bin');
        const embeddingsBytes = await vscode.workspace.fs.readFile(embeddingsUri);
        const embeddings = new Float32Array(embeddingsBytes.buffer.slice(
            embeddingsBytes.byteOffset,
            embeddingsBytes.byteOffset + embeddingsBytes.byteLength
        ));
        
        // Reconstruct chunks (text will be reloaded on demand)
        vectorIndex.chunks = metadata.chunks.map((c, i) => ({
            ...c,
            text: '', // Will be populated if needed
            embedding: embeddings.slice(i * metadata.dimensions, (i + 1) * metadata.dimensions)
        }));
        
        vectorIndex.embeddings = embeddings;
        vectorIndex.dimensions = metadata.dimensions;
        vectorIndex.model = metadata.model;
        vectorIndex.lastUpdated = metadata.lastUpdated ? new Date(metadata.lastUpdated) : null;
        
        log(`Vector index loaded: ${vectorIndex.chunks.length} chunks`);
        return true;
        
    } catch (error) {
        // Index doesn't exist or is corrupted
        log('No vector index found or error loading:', error.message);
        return false;
    }
}

/**
 * Clear vector index (in memory and on disk)
 */
async function clearVectorIndex() {
    vectorIndex.chunks = [];
    vectorIndex.embeddings = null;
    vectorIndex.lastUpdated = null;
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        try {
            const vectorsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'vectors');
            await vscode.workspace.fs.delete(vectorsDir, { recursive: true });
            log('Vector index directory deleted');
        } catch (e) {
            // Directory may not exist
        }
    }
    
    log('Vector index cleared');
}

/**
 * Get vector index statistics
 */
function getVectorIndexStats() {
    if (vectorIndex.chunks.length === 0) {
        return null;
    }
    
    const files = new Set(vectorIndex.chunks.map(c => c.file));
    const types = {};
    for (const chunk of vectorIndex.chunks) {
        types[chunk.type] = (types[chunk.type] || 0) + 1;
    }
    
    return {
        chunks: vectorIndex.chunks.length,
        files: files.size,
        types,
        dimensions: vectorIndex.dimensions,
        model: vectorIndex.model,
        lastUpdated: vectorIndex.lastUpdated,
        memorySizeMB: vectorIndex.embeddings 
            ? (vectorIndex.embeddings.byteLength / (1024 * 1024)).toFixed(2)
            : 0
    };
}

// ============================================================
// Context File Tree Provider
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
        
        for (const [path, file] of contextFiles) {
            const item = new vscode.TreeItem(
                file.uri.path.split('/').pop(),
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
        
        return items;
    }
}

// ============================================================
// Chat Webview Provider
// ============================================================

class ChatViewProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.context = context;
    }

    resolveWebviewView(webviewView) {
        chatWebviewView = webviewView;
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
            retainContextWhenHidden: true  // CRITICAL: Keep webview alive when hidden
        };
        
        webviewView.webview.html = this.getHtmlContent();
        
        // Restore chat history to webview after HTML is set
        this.restoreChatToWebview();
        
        // Handle visibility changes - restore state when becoming visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                log('Webview became visible, restoring state...');
                this.restoreChatToWebview();
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
                        await handleChatMessage(message.text);
                        break;
                    case 'setMode':
                        currentMode = message.mode;
                        updateChatStatus();
                        log('Mode changed to:', currentMode);
                        // Save mode change
                        if (persistenceManager) {
                            persistenceManager.markDirty();
                        }
                        break;
                    case 'clearHistory':
                    chatHistory = [];
                    updateChatUI();
                    // Clear persisted chat history
                    if (persistenceManager) {
                        persistenceManager.clearChatHistory();
                    }
                    break;
                case 'addFiles':
                    // Open file picker - accept files OR folders
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        canSelectFiles: true,
                        canSelectFolders: true,
                        openLabel: 'Add to AstraCode Context'
                        // No filters - accept all file types
                    });
                    if (uris && uris.length > 0) {
                        for (const uri of uris) {
                            await addToContext(uri);
                        }
                    }
                    break;
                case 'clearContext':
                    clearContext();
                    // Clear persisted context files
                    if (persistenceManager) {
                        persistenceManager.clearContextFiles();
                    }
                    log('Context cleared from UI');
                    break;
                case 'removeFile':
                    if (message.path) {
                        removeFileFromContext(message.path);
                        // Remove from persistence
                        if (persistenceManager) {
                            persistenceManager.removeContextFile(message.path);
                        }
                        log('Removed file from UI:', message.path);
                    }
                    break;
                case 'command':
                    // Execute a VS Code command
                    if (message.command === 'showCallGraph') {
                        vscode.commands.executeCommand('astra.showCallGraph');
                    } else if (message.command === 'openCallGraphInBrowser') {
                        vscode.commands.executeCommand('astra.openCallGraphInBrowser');
                    } else if (message.command === 'showIndexStats') {
                        vscode.commands.executeCommand('astra.showIndexStats');
                    } else if (message.command === 'showCallersOf') {
                        vscode.commands.executeCommand('astra.showCallersOf');
                    } else if (message.command === 'clearIndex') {
                        vscode.commands.executeCommand('astra.clearIndex');
                    } else if (message.command === 'rebuildIndex') {
                        vscode.commands.executeCommand('astra.rebuildIndex');
                    } else if (message.command === 'semanticSearch') {
                        vscode.commands.executeCommand('astra.semanticSearch');
                    }
                    break;
                case 'generateDocumentation':
                    // Generate documentation with specified type
                    if (contextFiles.size === 0) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: '⚠️ No files in context. Please add files first using the 📎 button.\n\n'
                        });
                        break;
                    }
                    
                    // Build file list from context - filter to code files only
                    const NON_CODE_FILES = new Set([
                        'makefile', 'gnumakefile', 'readme', 'readme.md', 'readme.txt',
                        'license', 'license.md', 'license.txt', 'changelog', 'changelog.md',
                        'contributing', 'contributing.md', 'authors', 'todo', 'todo.md',
                        '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc',
                        'package-lock.json', 'yarn.lock', 'poetry.lock', 'pipfile.lock'
                    ]);
                    const NON_CODE_EXTENSIONS = new Set([
                        '.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.ini',
                        '.cfg', '.conf', '.xml', '.html', '.css', '.lock', '.sum'
                    ]);
                    const BUILD_FILES = new Set([
                        'meson.build', 'cmakelists.txt', 'configure.ac', 'configure.in',
                        'setup.py', 'setup.cfg', 'pyproject.toml', 'cargo.toml',
                        'build.gradle', 'pom.xml', 'package.json', 'tsconfig.json'
                    ]);
                    
                    const docFileList = [];
                    const buildFiles = [];
                    
                    for (const [filePath, file] of contextFiles) {
                        const fileName = pathUtils.getFileName(filePath);
                        const fileNameLower = fileName.toLowerCase();
                        const ext = pathUtils.getExtension(filePath).toLowerCase();
                        
                        // Categorize files
                        if (NON_CODE_FILES.has(fileNameLower)) {
                            // Skip completely (README, LICENSE, etc.)
                            continue;
                        } else if (BUILD_FILES.has(fileNameLower)) {
                            // Track build files separately
                            buildFiles.push({ name: fileName, path: filePath, content: file.content, language: file.language, size: file.content.length });
                        } else if (NON_CODE_EXTENSIONS.has(ext) && !BUILD_FILES.has(fileNameLower)) {
                            // Skip non-code extensions unless they're build files
                            continue;
                        } else {
                            // Include as code file
                            docFileList.push({
                                name: fileName,
                                path: filePath,
                                content: file.content,
                                language: file.language,
                                size: file.content.length
                            });
                        }
                    }
                    
                    // If we filtered out everything, include build files
                    if (docFileList.length === 0 && buildFiles.length > 0) {
                        docFileList.push(...buildFiles);
                    }
                    
                    const docType = message.docType || 'technical';
                    debugLog('DOCS', `Generating ${docType} documentation`, { files: docFileList.length });
                    
                    chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: true });
                    
                    try {
                        await generateDocumentationFile(docFileList, `Generate ${docType} documentation`, docType);
                    } catch (error) {
                        debugLog('DOCS', `Error generating documentation: ${error.message}`);
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: `❌ Error generating documentation: ${error.message}\n\n`
                        });
                    }
                    
                    chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
                    break;
                case 'cancelTask':
                    // Cancel currently running task
                    taskController.cancel();
                    chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
                    break;
                case 'getSystemPrompt':
                    // Send current system prompt to webview
                    {
                        const config = vscode.workspace.getConfiguration('astra');
                        const customPrompt = config.get('systemPrompt');
                        const isDefault = !customPrompt;
                        chatWebviewView?.webview.postMessage({ 
                            type: 'systemPromptUpdate', 
                            prompt: customPrompt || DEFAULT_SYSTEM_PROMPT,
                            isDefault: isDefault
                        });
                    }
                    break;
                case 'setSystemPrompt':
                    // Save custom system prompt
                    {
                        const newPrompt = message.prompt;
                        await setSystemPrompt(newPrompt);
                        const isDefault = !newPrompt || newPrompt === DEFAULT_SYSTEM_PROMPT;
                        chatWebviewView?.webview.postMessage({ 
                            type: 'systemPromptUpdate', 
                            prompt: newPrompt || DEFAULT_SYSTEM_PROMPT,
                            isDefault: isDefault,
                            saved: true
                        });
                        log('System prompt saved');
                    }
                    break;
                case 'resetSystemPrompt':
                    // Reset to default system prompt
                    {
                        await resetSystemPrompt();
                        chatWebviewView?.webview.postMessage({ 
                            type: 'systemPromptUpdate', 
                            prompt: DEFAULT_SYSTEM_PROMPT,
                            isDefault: true,
                            saved: true
                        });
                        log('System prompt reset to default');
                    }
                    break;
                case 'setSearchMode':
                    {
                        const mode = message.mode;
                        if (mode === 'overview' || mode === 'detailed') {
                            searchModule.searchMode = mode;
                            const config = vscode.workspace.getConfiguration('astra');
                            await config.update('searchMode', mode, vscode.ConfigurationTarget.Global);
                            log('Search mode set to:', mode);
                            chatWebviewView?.webview.postMessage({ type: 'searchModeUpdate', mode });
                        }
                    }
                    break;
                case 'getSearchMode':
                    chatWebviewView?.webview.postMessage({ type: 'searchModeUpdate', mode: searchModule.searchMode });
                    break;
                case 'openFile':
                    // Open a file in the editor
                    if (message.filePath) {
                        try {
                            debugLog('DOCS', 'Opening file from path', message.filePath);
                            const fileUri = vscode.Uri.file(message.filePath);
                            const doc = await vscode.workspace.openTextDocument(fileUri);
                            await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                            log('Opened file:', message.filePath);
                            
                            // If it's a .md file, try to open preview
                            if (message.filePath.toLowerCase().endsWith('.md')) {
                                setTimeout(async () => {
                                    try {
                                        await vscode.commands.executeCommand('markdown.showPreview', fileUri);
                                    } catch (e) {
                                        log('Markdown preview failed:', e.message);
                                    }
                                }, 300);
                            }
                        } catch (err) {
                            debugLog('DOCS', `Error opening file: ${err.message}`);
                            vscode.window.showErrorMessage(`Could not open file: ${message.filePath}`);
                        }
                    }
                    break;
                case 'revealFile':
                    // Reveal file in OS file explorer
                    if (message.filePath) {
                        try {
                            const fileUri = vscode.Uri.file(message.filePath);
                            await vscode.commands.executeCommand('revealFileInOS', fileUri);
                        } catch (err) {
                            log('Error revealing file:', err.message);
                        }
                    }
                    break;
                case 'openFileUri':
                    // Open a file by URI string (used for command: links)
                    if (message.fileUri) {
                        try {
                            debugLog('DOCS', 'Opening file from URI', message.fileUri);
                            const fileUri = vscode.Uri.parse(message.fileUri);
                            const doc = await vscode.workspace.openTextDocument(fileUri);
                            await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                            // Also try to open markdown preview
                            setTimeout(async () => {
                                try {
                                    await vscode.commands.executeCommand('markdown.showPreview', fileUri);
                                } catch (e) {
                                    log('Markdown preview failed:', e.message);
                                }
                            }, 300);
                        } catch (err) {
                            debugLog('DOCS', `Error opening file URI: ${err.message}`);
                            vscode.window.showErrorMessage(`Could not open file: ${err.message}`);
                        }
                    }
                    break;
                case 'executeCommand':
                    // Execute a VS Code command
                    if (message.command) {
                        try {
                            debugLog('DOCS', 'Executing command', { command: message.command, args: message.args });
                            await vscode.commands.executeCommand(message.command, ...(message.args || []));
                        } catch (err) {
                            log('Error executing command:', err.message);
                        }
                    }
                    break;
            }
            } catch (error) {
                log('Error handling message:', error.message);
                vscode.window.showErrorMessage(`AstraCode error: ${error.message}`);
            }
        });
        
        // Initial status update
        updateChatStatus();
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 8px;
        }
        
        /* Indexing Banner */
        .indexing-banner {
            background: var(--vscode-inputValidation-infoBackground, #063b49);
            border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
            border-radius: 4px;
            padding: 10px 12px;
            margin-bottom: 8px;
            display: none;
        }
        .indexing-banner.show {
            display: block;
        }
        .indexing-banner .banner-title {
            font-weight: bold;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .indexing-banner .banner-title .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .indexing-banner .banner-phase {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .indexing-banner .banner-stats {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .indexing-banner .banner-progress {
            height: 4px;
            background: var(--vscode-progressBar-background, #0e639c);
            border-radius: 2px;
            margin-top: 8px;
            width: 0%;
            transition: width 0.3s ease;
        }
        .indexing-banner.complete {
            background: var(--vscode-inputValidation-infoBackground, #063b49);
            border-color: #4ec9b0;
        }
        .indexing-banner.complete .banner-title {
            color: #4ec9b0;
        }
        
        /* Disabled input state */
        .input-container.disabled textarea {
            opacity: 0.5;
            cursor: not-allowed;
            background: var(--vscode-input-background);
        }
        .input-container.disabled button {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }
        .input-container.disabled .input-hint {
            display: none;
        }
        .input-disabled-overlay {
            display: none;
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: transparent;
            cursor: not-allowed;
            z-index: 10;
        }
        .input-container.disabled .input-disabled-overlay {
            display: block;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
        }
        
        .mode-selector {
            display: flex;
            gap: 4px;
        }
        
        .mode-btn {
            padding: 4px 8px;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            font-size: 11px;
            border-radius: 3px;
        }
        
        .mode-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .status {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        
        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 4px;
        }
        
        .status-indicator.local { background: #4ec9b0; }
        .status-indicator.api { background: #569cd6; }
        .status-indicator.auto { background: #dcdcaa; }
        
        .search-mode-toggle {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .search-mode-toggle .toggle-label { font-size: 10px; color: var(--vscode-descriptionForeground); }
        .search-mode-toggle .toggle-options { display: flex; gap: 2px; }
        .search-mode-toggle input[type="radio"] { display: none; }
        .search-mode-toggle .toggle-btn {
            padding: 3px 8px;
            font-size: 11px;
            border-radius: 3px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .search-mode-toggle input:checked + .toggle-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .search-mode-toggle input:not(:checked) + .toggle-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }
        
        .message {
            margin-bottom: 12px;
            padding: 8px 12px;
            border-radius: 6px;
            max-width: 95%;
        }
        
        .message.user {
            background: var(--vscode-input-background);
            margin-left: auto;
        }
        
        .message.assistant {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
        }
        
        .message-divider {
            display: flex;
            align-items: center;
            margin: 12px 0;
            gap: 12px;
        }
        
        .message-divider::before,
        .message-divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: linear-gradient(to right, transparent, var(--vscode-panel-border), transparent);
        }
        
        .message-divider-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--vscode-panel-border);
        }
        
        .message-header {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        
        .message-content pre.code-block {
            position: relative;
            cursor: pointer;
        }
        
        .message-content pre.code-block:hover {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .message-content pre.code-block::after {
            content: 'Click to copy';
            position: absolute;
            top: 4px;
            right: 4px;
            font-size: 10px;
            opacity: 0;
            transition: opacity 0.2s;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        .message-content pre.code-block:hover::after {
            opacity: 1;
        }
        
        .message-content pre.code-block.copied::after {
            content: 'Copied!';
            opacity: 1;
            background: var(--vscode-testing-iconPassed);
        }
        
        .message-content .file-link {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 4px;
            display: inline-block;
        }
        
        .message-content .file-link:hover {
            color: var(--vscode-textLink-activeForeground);
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .message-content .doc-link-btn {
            cursor: pointer;
            color: var(--vscode-button-foreground);
            background-color: var(--vscode-button-background);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            margin: 4px 0;
            display: inline-block;
        }
        
        .message-content .doc-link-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .message-content .external-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
        }
        
        .message-content .external-link:hover {
            color: var(--vscode-textLink-activeForeground);
        }
        
        .message-content h1, .message-content h2, .message-content h3 {
            margin: 12px 0 8px 0;
            font-weight: 600;
        }
        
        .message-content h1 { font-size: 1.3em; }
        .message-content h2 { font-size: 1.15em; }
        .message-content h3 { font-size: 1.05em; }
        
        .message-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 12px 0;
        }
        
        .message-content blockquote {
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding-left: 10px;
            margin: 8px 0;
            color: var(--vscode-textBlockQuote-foreground);
        }
        
        .input-container {
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        .input-row {
            display: flex;
            gap: 8px;
        }
        
        .input-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 8px;
            gap: 8px;
        }
        
        .action-right {
            display: flex;
            gap: 8px;
        }
        
        .input-hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            opacity: 0.8;
        }
        
        #addFilesBtn {
            padding: 6px 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        #addFilesBtn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        #chatInput {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            resize: none;
            min-height: 60px;
        }
        
        #chatInput:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        #sendBtn {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            align-self: flex-end;
        }
        
        #sendBtn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        #sendBtn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        #cancelBtn {
            padding: 8px 12px;
            background: linear-gradient(135deg, #f44336, #c62828) !important;
            color: white !important;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            align-self: flex-end;
            font-weight: 600;
            animation: pulse 1.5s infinite;
        }
        
        #cancelBtn:hover {
            background: linear-gradient(135deg, #ef5350, #e53935) !important;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        
        .context-summary {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 0;
        }
        
        .loading {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-descriptionForeground);
        }
        
        .loading-dots::after {
            content: '';
            animation: dots 1.5s steps(4, end) infinite;
        }
        
        @keyframes dots {
            0%, 20% { content: ''; }
            40% { content: '.'; }
            60% { content: '..'; }
            80%, 100% { content: '...'; }
        }
        
        .empty-state {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 40px 20px;
        }
        
        .empty-state h3 {
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        
        .quick-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-top: 12px;
            justify-content: center;
        }
        
        .quick-action {
            padding: 4px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
        }
        
        .quick-action:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .quick-actions-bar {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 8px;
            justify-content: center;
        }
        
        .quick-action-btn {
            padding: 4px 10px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
        }
        
        .quick-action-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        /* Code Docs dropdown container */
        .docs-dropdown {
            position: relative;
            display: inline-block;
        }
        
        .docs-dropdown-btn {
            padding: 4px 10px;
            background: rgba(33, 150, 243, 0.2) !important;
            color: #64B5F6 !important;
            border: 1px solid rgba(33, 150, 243, 0.4) !important;
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 500;
        }
        
        .docs-dropdown-btn:hover {
            background: rgba(33, 150, 243, 0.35) !important;
            border-color: rgba(33, 150, 243, 0.6) !important;
        }
        
        .docs-dropdown-panel {
            display: none;
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 8px;
            min-width: 280px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 100;
        }
        
        .docs-dropdown-panel.show {
            display: block;
        }
        
        .docs-dropdown-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 10px;
            text-align: center;
        }
        
        .docs-option {
            display: flex;
            align-items: flex-start;
            padding: 8px;
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 6px;
            border: 1px solid transparent;
            transition: all 0.15s ease;
        }
        
        .docs-option:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .docs-option.selected {
            background: var(--vscode-list-activeSelectionBackground);
            border-color: var(--vscode-focusBorder);
        }
        
        .docs-option input[type="radio"] {
            margin-right: 10px;
            margin-top: 2px;
            accent-color: var(--vscode-button-background);
        }
        
        .docs-option-content {
            flex: 1;
        }
        
        .docs-option-label {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .docs-option-desc {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            line-height: 1.4;
        }
        
        .docs-generate-btn {
            width: 100%;
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            margin-top: 8px;
        }
        
        .docs-generate-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        /* Graph button - subtle green */
        .graph-btn {
            background: rgba(76, 175, 80, 0.2) !important;
            color: #81C784 !important;
            border: 1px solid rgba(76, 175, 80, 0.4) !important;
            font-weight: 500;
        }
        
        .graph-btn:hover {
            background: rgba(76, 175, 80, 0.35) !important;
            border-color: rgba(76, 175, 80, 0.6) !important;
        }
        
        /* Semantic Search button - subtle purple */
        .search-btn {
            background: rgba(124, 77, 255, 0.2) !important;
            color: #B39DDB !important;
            border: 1px solid rgba(124, 77, 255, 0.4) !important;
            font-weight: 500;
        }
        
        .search-btn:hover {
            background: rgba(124, 77, 255, 0.35) !important;
            border-color: rgba(124, 77, 255, 0.6) !important;
        }
        
        /* System Prompt Section */
        .system-prompt-section {
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
        }
        
        .system-prompt-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            cursor: pointer;
            user-select: none;
        }
        
        .system-prompt-header:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .system-prompt-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .system-prompt-toggle {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.2s ease;
        }
        
        .system-prompt-toggle.expanded {
            transform: rotate(180deg);
        }
        
        .system-prompt-content {
            display: none;
            padding: 8px 0;
        }
        
        .system-prompt-content.show {
            display: block;
        }
        
        .system-prompt-textarea {
            width: 100%;
            min-height: 120px;
            max-height: 300px;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 11px;
            line-height: 1.4;
            resize: vertical;
        }
        
        .system-prompt-textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .system-prompt-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 8px;
            gap: 8px;
        }
        
        .system-prompt-btn {
            padding: 4px 10px;
            font-size: 11px;
            border-radius: 4px;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border);
        }
        
        .system-prompt-save {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .system-prompt-save:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .system-prompt-reset {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .system-prompt-reset:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .system-prompt-status {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            flex: 1;
        }
        
        .system-prompt-status.saved {
            color: #4CAF50;
        }
        
        .system-prompt-indicator {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 8px;
            background: rgba(255, 193, 7, 0.2);
            color: #FFC107;
        }
        
        .system-prompt-indicator.default {
            background: rgba(76, 175, 80, 0.2);
            color: #81C784;
        }
        
        .system-prompt-indicator.custom {
            background: rgba(255, 193, 7, 0.2);
            color: #FFC107;
        }
        
        .add-files-big {
            padding: 12px 24px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin: 16px 0;
        }
        
        .add-files-big:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .context-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 4px;
        }
        
        .context-files-list {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            flex: 1;
            max-height: 60px;
            overflow: hidden;
            transition: max-height 0.3s ease;
        }
        
        .context-files-list.expanded {
            max-height: 200px;
            overflow-y: auto;
        }
        
        .context-summary {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-size: 11px;
            cursor: pointer;
        }
        
        .context-summary:hover {
            opacity: 0.9;
        }
        
        .context-summary .expand-icon {
            font-size: 10px;
            transition: transform 0.2s;
        }
        
        .context-summary.expanded .expand-icon {
            transform: rotate(180deg);
        }
        
        .context-file-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 6px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-size: 11px;
        }
        
        .context-file-chip .remove-file {
            cursor: pointer;
            opacity: 0.7;
            font-size: 10px;
        }
        
        .context-file-chip .remove-file:hover {
            opacity: 1;
        }
        
        .clear-context-btn {
            padding: 2px 6px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: nowrap;
        }
        
        .clear-context-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-foreground);
        }
        
        .context-actions {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        
        .index-btn {
            padding: 2px 6px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: nowrap;
        }
        
        .index-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-foreground);
        }
        
        /* Index Progress - Inline version (no layout shift) */
        .index-progress-inline {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            font-size: 11px;
        }
        
        .index-progress-text-inline {
            color: var(--vscode-descriptionForeground);
            min-width: 80px;
        }
        
        /* Summary Progress - distinct styling */
        #summaryProgressInline {
            background: linear-gradient(135deg, var(--vscode-editor-background), rgba(100, 149, 237, 0.1));
            border-color: rgba(100, 149, 237, 0.3);
        }
        
        #summaryProgressText {
            min-width: 140px;
            color: var(--vscode-textLink-foreground);
        }
        
        /* Flashing Indexing Indicator */
        .indexing-indicator {
            font-size: 14px;
            animation: flash-bulb 0.8s ease-in-out infinite;
        }
        
        @keyframes flash-bulb {
            0%, 100% { 
                opacity: 1; 
                filter: brightness(1) drop-shadow(0 0 4px #ffd700);
            }
            50% { 
                opacity: 0.4; 
                filter: brightness(0.6) drop-shadow(0 0 0px #ffd700);
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="mode-selector">
            <button class="mode-btn" data-mode="auto" title="Smart detection">Auto</button>
            <button class="mode-btn" data-mode="local" title="Use context files only">Local</button>
            <button class="mode-btn" data-mode="api" title="Search API server">API</button>
        </div>
        <div class="status">
            <span class="status-indicator auto"></span>
            <span id="statusText">Auto Mode</span>
        </div>
    </div>
    
    <div class="search-mode-toggle">
        <span class="toggle-label">Search:</span>
        <div class="toggle-options">
            <label title="Search summaries only"><input type="radio" name="searchMode" value="overview"/><span class="toggle-btn">📋 Overview</span></label>
            <label title="Search source code"><input type="radio" name="searchMode" value="detailed" checked/><span class="toggle-btn">💻 Code</span></label>
        </div>
    </div>
    
    <div class="system-prompt-section">
        <div class="system-prompt-header" id="systemPromptHeader">
            <div class="system-prompt-title">
                <span>⚙️ System Prompt</span>
                <span class="system-prompt-indicator default" id="systemPromptIndicator">Default</span>
            </div>
            <span class="system-prompt-toggle" id="systemPromptToggle">▼</span>
        </div>
        <div class="system-prompt-content" id="systemPromptContent">
            <textarea class="system-prompt-textarea" id="systemPromptTextarea" placeholder="Customize how AstraCode responds. This prompt is prepended to every query.

Example:
- Focus on payment processing domain
- Always provide code examples
- Use formal technical language
- Reference specific frameworks"></textarea>
            <div class="system-prompt-actions">
                <span class="system-prompt-status" id="systemPromptStatus">Prepended to every query</span>
                <button class="system-prompt-btn system-prompt-reset" id="resetSystemPromptBtn">Reset to Default</button>
                <button class="system-prompt-btn system-prompt-save" id="saveSystemPromptBtn">Save</button>
            </div>
        </div>
    </div>
    
    <!-- Indexing Status Banner -->
    <div id="indexingBanner" class="indexing-banner">
        <div class="banner-title">
            <span class="spinner"></span>
            <span id="bannerTitle">Indexing in progress...</span>
        </div>
        <div id="bannerPhase" class="banner-phase">📂 Parsing files...</div>
        <div id="bannerStats" class="banner-stats">0 files | 0 symbols</div>
        <div id="bannerProgress" class="banner-progress"></div>
    </div>
    
    <div id="contextBar" class="context-bar" style="display: none;">
        <div id="contextFilesList" class="context-files-list"></div>
        <div class="context-actions">
            <div id="indexProgressInline" class="index-progress-inline" style="display: none;">
                <span id="indexingIndicator" class="indexing-indicator">💡</span>
                <span id="indexProgressText" class="index-progress-text-inline">0%</span>
            </div>
            <div id="summaryProgressInline" class="index-progress-inline" style="display: none;">
                <span class="indexing-indicator">📚</span>
                <span id="summaryProgressText" class="index-progress-text-inline">Summaries...</span>
            </div>
            <button id="rebuildIndexBtn" class="index-btn" title="Rebuild code index">🔄 Rebuild</button>
            <button id="clearContextBtn" class="clear-context-btn" title="Clear all files and index">🗑️ Clear All</button>
        </div>
    </div>
    
    <div id="chatContainer" class="chat-container">
        <div class="empty-state">
            <h3><span style="color: #FFD700;">★</span> AstraCode Assistant</h3>
            <p>Add files to context, then ask questions</p>
            <button class="add-files-big" id="addFilesBigBtn">📎 Add Files to Context</button>
        </div>
    </div>
    
    <div class="input-container" id="inputContainer">
        <div class="input-disabled-overlay" id="inputDisabledOverlay"></div>
        <div id="quickActionsBar" class="quick-actions-bar">
            <button class="quick-action-btn" data-prompt="Find bugs and issues">🐛 Debug</button>
            <button class="quick-action-btn graph-btn" data-command="openCallGraphInBrowser">⬡ Graph</button>
            <button class="quick-action-btn search-btn" data-command="semanticSearch">🧠 Search</button>
            <div class="docs-dropdown">
                <button class="docs-dropdown-btn" id="docsDropdownBtn">📄 Code Docs ▾</button>
                <div class="docs-dropdown-panel" id="docsDropdownPanel">
                    <div class="docs-dropdown-title">Choose Documentation Type</div>
                    <label class="docs-option selected" data-type="technical">
                        <input type="radio" name="docType" value="technical" checked>
                        <div class="docs-option-content">
                            <div class="docs-option-label">🔧 Technical Documentation</div>
                            <div class="docs-option-desc">For developers. Detailed code structure, function signatures, data flows, and implementation details.</div>
                        </div>
                    </label>
                    <label class="docs-option" data-type="business">
                        <input type="radio" name="docType" value="business">
                        <div class="docs-option-content">
                            <div class="docs-option-label">📊 Business Documentation</div>
                            <div class="docs-option-desc">For product owners & stakeholders. Focus on WHAT the code does, WHY it matters, and customer value.</div>
                        </div>
                    </label>
                    <button class="docs-generate-btn" id="generateDocsBtn">Generate Documentation</button>
                </div>
            </div>
        </div>
        <div class="input-row">
            <textarea id="chatInput" placeholder="Ask a question... (Ctrl+Enter to send)" rows="2"></textarea>
        </div>
        <div class="input-actions">
            <button id="addFilesBtn" title="Add files to context">📎 Add Files</button>
            <div class="action-right">
                <button id="cancelBtn" style="display:none" title="Cancel current task">⏹️ Cancel</button>
                <button id="sendBtn">Send</button>
            </div>
        </div>
        <div class="input-hint">
            💡 Right-click file in Explorer → "AstraCode: Add File to Context"
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Elements
        const chatContainer = document.getElementById('chatContainer');
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const addFilesBtn = document.getElementById('addFilesBtn');
        const statusText = document.getElementById('statusText');
        const contextBar = document.getElementById('contextBar');
        const contextFilesList = document.getElementById('contextFilesList');
        const clearContextBtn = document.getElementById('clearContextBtn');
        const modeBtns = document.querySelectorAll('.mode-btn');
        const quickActions = document.querySelectorAll('.quick-action');
        
        let currentMode = 'auto';
        let isProcessing = false;
        let contextFilesData = []; // Store file paths for removal
        
        // System Prompt Elements
        const systemPromptHeader = document.getElementById('systemPromptHeader');
        const systemPromptToggle = document.getElementById('systemPromptToggle');
        const systemPromptContent = document.getElementById('systemPromptContent');
        const systemPromptTextarea = document.getElementById('systemPromptTextarea');
        const systemPromptIndicator = document.getElementById('systemPromptIndicator');
        const systemPromptStatus = document.getElementById('systemPromptStatus');
        const saveSystemPromptBtn = document.getElementById('saveSystemPromptBtn');
        const resetSystemPromptBtn = document.getElementById('resetSystemPromptBtn');
        
        // Toggle system prompt panel
        systemPromptHeader.addEventListener('click', () => {
            const isExpanded = systemPromptContent.classList.toggle('show');
            systemPromptToggle.classList.toggle('expanded', isExpanded);
            
            // Request current system prompt when opening
            if (isExpanded) {
                vscode.postMessage({ type: 'getSystemPrompt' });
            }
        });
        
        // Save system prompt
        saveSystemPromptBtn.addEventListener('click', () => {
            const newPrompt = systemPromptTextarea.value.trim();
            vscode.postMessage({ type: 'setSystemPrompt', prompt: newPrompt });
            
            systemPromptStatus.textContent = 'Saving...';
            systemPromptStatus.classList.remove('saved');
        });
        
        // Reset to default
        resetSystemPromptBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'resetSystemPrompt' });
            systemPromptStatus.textContent = 'Resetting...';
        });
        
        // Add files button (small)
        addFilesBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'addFiles' });
        });
        
        // Add files button (big - in empty state)
        const addFilesBigBtn = document.getElementById('addFilesBigBtn');
        if (addFilesBigBtn) {
            addFilesBigBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'addFiles' });
            });
        }
        
        // Clear context button
        clearContextBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearContext' });
        });
        
        // Rebuild index button
        const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
        
        if (rebuildIndexBtn) {
            rebuildIndexBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'command', command: 'rebuildIndex' });
            });
        }
        
        // Mode selection
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                currentMode = btn.dataset.mode;
                modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                document.querySelector('.status-indicator').className = 'status-indicator ' + currentMode;
                
                vscode.postMessage({ type: 'setMode', mode: currentMode });
            });
        });
        
        // Quick actions (in empty state)
        quickActions.forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.command) {
                    vscode.postMessage({ type: 'command', command: btn.dataset.command });
                } else if (btn.dataset.prompt) {
                    chatInput.value = btn.dataset.prompt;
                    chatInput.focus();
                }
            });
        });
        
        // Persistent quick action buttons (always visible above input)
        document.querySelectorAll('.quick-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.command) {
                    vscode.postMessage({ type: 'command', command: btn.dataset.command });
                } else if (btn.dataset.prompt) {
                    chatInput.value = btn.dataset.prompt;
                    chatInput.focus();
                    // Optionally auto-send
                    // sendMessage();
                }
            });
        });
        
        // Documentation dropdown handlers
        const docsDropdownBtn = document.getElementById('docsDropdownBtn');
        const docsDropdownPanel = document.getElementById('docsDropdownPanel');
        const generateDocsBtn = document.getElementById('generateDocsBtn');
        const docOptions = document.querySelectorAll('.docs-option');
        
        // Toggle dropdown
        docsDropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            docsDropdownPanel.classList.toggle('show');
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.docs-dropdown')) {
                docsDropdownPanel.classList.remove('show');
            }
        });
        
        // Handle option selection
        docOptions.forEach(option => {
            option.addEventListener('click', () => {
                docOptions.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                option.querySelector('input[type="radio"]').checked = true;
            });
        });
        
        // Generate documentation button
        generateDocsBtn.addEventListener('click', () => {
            const selectedType = document.querySelector('input[name="docType"]:checked').value;
            docsDropdownPanel.classList.remove('show');
            
            // Send message to generate documentation with selected type
            vscode.postMessage({ 
                type: 'generateDocumentation', 
                docType: selectedType 
            });
        });
        
        // Send message
        function sendMessage() {
            const text = chatInput.value.trim();
            if (!text || isProcessing) return;
            
            chatInput.value = '';
            vscode.postMessage({ type: 'chat', text });
        }
        
        sendBtn.addEventListener('click', sendMessage);
        
        // Search mode toggle
        document.querySelectorAll('input[name="searchMode"]').forEach(r => {
            r.addEventListener('change', e => vscode.postMessage({ type: 'setSearchMode', mode: e.target.value }));
        });
        vscode.postMessage({ type: 'getSearchMode' });
        
        // Cancel button
        document.getElementById('cancelBtn')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'cancelTask' });
        });
        
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                sendMessage();
            }
        });
        
        // Receive messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateChat':
                    renderChat(message.history);
                    break;
                case 'updateStatus':
                    updateStatus(message);
                    break;
                case 'setProcessing':
                    isProcessing = message.processing;
                    sendBtn.disabled = isProcessing;
                    
                    // Show/hide cancel button
                    const cancelBtn = document.getElementById('cancelBtn');
                    if (cancelBtn) {
                        cancelBtn.style.display = isProcessing ? 'inline-block' : 'none';
                    }
                    
                    if (isProcessing) {
                        addLoadingIndicator();
                        sendBtn.textContent = '⏳';
                    } else {
                        removeLoadingIndicator();
                        sendBtn.textContent = 'Send';
                    }
                    break;
                case 'appendResponse':
                    appendToLastMessage(message.text);
                    break;
                case 'replaceLastResponse':
                    replaceLastResponse(message.text);
                    break;
                case 'finalizeResponse':
                    finalizeLastMessage();
                    break;
                case 'indexProgress':
                    showIndexProgress(message.progress, message.message);
                    break;
                case 'indexingStatus':
                    updateIndexingBanner(message);
                    break;
                case 'summaryProgress':
                    showSummaryProgress(message.progress, message.message, message.count);
                    break;
                case 'systemPromptUpdate':
                    // Update the system prompt textarea and indicator
                    systemPromptTextarea.value = message.prompt || '';
                    
                    if (message.isDefault) {
                        systemPromptIndicator.textContent = 'Default';
                        systemPromptIndicator.classList.add('default');
                        systemPromptIndicator.classList.remove('custom');
                    } else {
                        systemPromptIndicator.textContent = 'Custom';
                        systemPromptIndicator.classList.remove('default');
                        systemPromptIndicator.classList.add('custom');
                    }
                    
                    if (message.saved) {
                        systemPromptStatus.textContent = '✓ Saved';
                        systemPromptStatus.classList.add('saved');
                        setTimeout(() => {
                            systemPromptStatus.textContent = 'Prepended to every query';
                            systemPromptStatus.classList.remove('saved');
                        }, 2000);
                    }
                    break;
                case 'searchModeUpdate':
                    const modeRadio = document.querySelector(\`input[name="searchMode"][value="\${message.mode}"]\`);
                    if (modeRadio) modeRadio.checked = true;
                    break;
                case 'restoreHistory':
                    // Restore chat history from persistence
                    if (message.history && message.history.length > 0) {
                        renderChat(message.history);
                        console.log('Restored', message.history.length, 'messages from persistence');
                    }
                    break;
            }
        });
        
        // Index progress indicator - uses inline element (no layout shift)
        function showIndexProgress(progress, message) {
            const progressContainer = document.getElementById('indexProgressInline');
            const progressText = document.getElementById('indexProgressText');
            
            if (!progressContainer || !progressText) return;
            
            if (progress < 100) {
                // Show progress
                progressContainer.style.display = 'flex';
                progressText.textContent = message;
            } else {
                // Complete - show briefly then hide
                progressText.textContent = '✓ Done';
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                }, 1500);
            }
            
            // Also update the banner
            updateIndexingBannerFromProgress(progress, message);
        }
        
        // Update indexing banner from progress messages
        function updateIndexingBannerFromProgress(progress, message) {
            const banner = document.getElementById('indexingBanner');
            const bannerTitle = document.getElementById('bannerTitle');
            const bannerPhase = document.getElementById('bannerPhase');
            const bannerStats = document.getElementById('bannerStats');
            const bannerProgress = document.getElementById('bannerProgress');
            const inputContainer = document.getElementById('inputContainer');
            
            if (!banner) return;
            
            if (progress < 100) {
                // Show banner and disable input
                banner.classList.add('show');
                banner.classList.remove('complete');
                inputContainer?.classList.add('disabled');
                chatInput.placeholder = '⏳ Please wait for indexing to complete...';
                chatInput.disabled = true;
                
                bannerTitle.textContent = 'Indexing in progress...';
                bannerPhase.textContent = message || 'Processing...';
                bannerProgress.style.width = progress + '%';
                
                // Extract stats from message
                const statsMatch = message?.match(/(\d+)\s*files.*?(\d+)\s*symbols/i);
                if (statsMatch) {
                    bannerStats.textContent = statsMatch[1] + ' files | ' + statsMatch[2] + ' symbols';
                }
            } else {
                // Complete - show success briefly then hide
                banner.classList.add('complete');
                bannerTitle.innerHTML = '✅ Index ready';
                bannerPhase.textContent = message || 'Ready for queries';
                bannerProgress.style.width = '100%';
                
                // Enable input
                inputContainer?.classList.remove('disabled');
                chatInput.placeholder = 'Ask a question... (Ctrl+Enter to send)';
                chatInput.disabled = false;
                
                // Hide banner after delay
                setTimeout(() => {
                    banner.classList.remove('show');
                    banner.classList.remove('complete');
                }, 3000);
            }
        }
        
        // Update indexing banner from IndexingState
        function updateIndexingBanner(state) {
            const banner = document.getElementById('indexingBanner');
            const bannerTitle = document.getElementById('bannerTitle');
            const bannerPhase = document.getElementById('bannerPhase');
            const bannerStats = document.getElementById('bannerStats');
            const bannerProgress = document.getElementById('bannerProgress');
            const inputContainer = document.getElementById('inputContainer');
            
            if (!banner) return;
            
            const phaseMessages = {
                'idle': '',
                'parsing': '📂 Parsing files...',
                'symbols': '🔍 Extracting symbols...',
                'trigrams': '📊 Building trigram index...',
                'search': '🔎 Building search indexes...',
                'summaries': '🤖 Generating summaries...',
                'inverted': '📚 Adding summaries to inverted index...',
                'ready': '✅ Ready'
            };
            
            if (state.isIndexing || state.isSummarizing) {
                // Show banner and disable input
                banner.classList.add('show');
                banner.classList.remove('complete');
                inputContainer?.classList.add('disabled');
                chatInput.placeholder = '⏳ Please wait for indexing to complete...';
                chatInput.disabled = true;
                
                if (state.isSummarizing && !state.isIndexing) {
                    bannerTitle.textContent = 'Generating summaries...';
                } else {
                    bannerTitle.textContent = 'Indexing in progress...';
                }
                
                bannerPhase.textContent = phaseMessages[state.phase] || state.phaseName || 'Processing...';
                bannerProgress.style.width = state.progress + '%';
                
                // Build stats line
                const statsParts = [];
                if (state.stats?.files > 0) statsParts.push(state.stats.files + ' files');
                if (state.stats?.symbols > 0) statsParts.push(state.stats.symbols + ' symbols');
                if (state.stats?.summaries > 0) statsParts.push(state.stats.summaries + ' summaries');
                if (state.stats?.terms > 0) statsParts.push(state.stats.terms + ' search terms');
                bannerStats.textContent = statsParts.join(' | ') || 'Starting...';
                
            } else if (state.isReady) {
                // Complete - show success
                banner.classList.add('show');
                banner.classList.add('complete');
                bannerTitle.innerHTML = '✅ Index ready - summaries added to search';
                bannerPhase.textContent = 'All indexes built. Ready for queries.';
                bannerProgress.style.width = '100%';
                
                // Build final stats
                const statsParts = [];
                if (state.stats?.files > 0) statsParts.push(state.stats.files + ' files');
                if (state.stats?.symbols > 0) statsParts.push(state.stats.symbols + ' symbols');
                if (state.stats?.summaries > 0) statsParts.push(state.stats.summaries + ' summaries');
                if (state.stats?.terms > 0) statsParts.push(state.stats.terms + ' search terms');
                bannerStats.textContent = statsParts.join(' | ');
                
                // Enable input
                inputContainer?.classList.remove('disabled');
                chatInput.placeholder = 'Ask a question... (Ctrl+Enter to send)';
                chatInput.disabled = false;
                
                // Hide banner after delay
                setTimeout(() => {
                    banner.classList.remove('show');
                    banner.classList.remove('complete');
                }, 5000);
            } else {
                // Not indexing, hide banner
                banner.classList.remove('show');
                inputContainer?.classList.remove('disabled');
                chatInput.placeholder = 'Ask a question... (Ctrl+Enter to send)';
                chatInput.disabled = false;
            }
        }
        
        // Summary progress indicator
        function showSummaryProgress(progress, message, count) {
            const progressContainer = document.getElementById('summaryProgressInline');
            const progressText = document.getElementById('summaryProgressText');
            
            if (!progressContainer || !progressText) return;
            
            if (progress < 100) {
                // Show progress
                progressContainer.style.display = 'flex';
                progressText.textContent = message || 'Summarizing...';
            } else {
                // Complete - show count briefly then hide
                progressText.textContent = count ? '✓ ' + count + ' summaries' : '✓ Done';
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                }, 3000);
            }
        }
        
        function renderChat(history) {
            if (!history || history.length === 0) {
                chatContainer.innerHTML = \`
                    <div class="empty-state">
                        <h3><span style="color: #FFD700;">★</span> AstraCode Assistant</h3>
                        <p>Add files to context, then ask questions</p>
                        <button class="add-files-big" id="addFilesBigBtnDynamic">📎 Add Files to Context</button>
                    </div>
                \`;
                
                // Attach add files button listener
                const addBtn = document.getElementById('addFilesBigBtnDynamic');
                if (addBtn) {
                    addBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'addFiles' });
                    });
                }
                return;
            }
            
            chatContainer.innerHTML = history.map((msg, index) => {
                const messageHtml = \`
                    <div class="message \${msg.role}">
                        <div class="message-header">\${msg.role === 'user' ? 'You' : 'AstraCode'}</div>
                        <div class="message-content">\${escapeHtml(msg.content)}</div>
                    </div>
                \`;
                // Add divider after user message (before assistant response)
                const divider = (msg.role === 'user' && index < history.length - 1) ? 
                    '<div class="message-divider"><div class="message-divider-dot"></div></div>' : '';
                return messageHtml + divider;
            }).join('');
            
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        function updateStatus(status) {
            statusText.textContent = status.text;
            
            // Update mode buttons
            modeBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === status.mode);
            });
            
            document.querySelector('.status-indicator').className = 'status-indicator ' + status.mode;
            
            // Update context files bar
            if (status.files && status.files.length > 0) {
                contextBar.style.display = 'flex';
                contextFilesData = status.files;
                
                const fileCount = status.files.length;
                const COLLAPSE_THRESHOLD = 10; // Show summary if more than this many files
                
                if (fileCount > COLLAPSE_THRESHOLD) {
                    // Show collapsed summary view for large file counts
                    contextFilesList.innerHTML = 
                        '<div class="context-summary" id="contextSummary">' +
                            '<span>📁 ' + fileCount + ' files in context</span>' +
                            '<span class="expand-icon">▼</span>' +
                        '</div>' +
                        '<div id="contextFilesExpanded" class="context-files-expanded" style="display:none; flex-wrap:wrap; gap:4px; margin-top:4px; max-height:150px; overflow-y:auto;">' +
                            status.files.map((file, index) => 
                                '<span class="context-file-chip">' +
                                    file.name +
                                    '<span class="remove-file" data-index="' + index + '" title="Remove">✕</span>' +
                                '</span>'
                            ).join('') +
                        '</div>';
                    
                    // Toggle expand/collapse
                    const summary = document.getElementById('contextSummary');
                    const expanded = document.getElementById('contextFilesExpanded');
                    if (summary && expanded) {
                        summary.addEventListener('click', () => {
                            const isExpanded = expanded.style.display !== 'none';
                            expanded.style.display = isExpanded ? 'none' : 'flex';
                            summary.classList.toggle('expanded', !isExpanded);
                        });
                    }
                    
                    // Add click handlers for remove buttons
                    contextFilesList.querySelectorAll('.remove-file').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const index = parseInt(e.target.dataset.index);
                            const file = contextFilesData[index];
                            if (file) {
                                vscode.postMessage({ type: 'removeFile', path: file.path });
                            }
                        });
                    });
                } else {
                    // Show all files as chips for small counts
                    contextFilesList.innerHTML = status.files.map((file, index) => 
                        '<span class="context-file-chip">' +
                            file.name +
                            '<span class="remove-file" data-index="' + index + '" title="Remove">✕</span>' +
                        '</span>'
                    ).join('');
                    
                    // Add click handlers for remove buttons
                    contextFilesList.querySelectorAll('.remove-file').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const index = parseInt(e.target.dataset.index);
                            const file = contextFilesData[index];
                            if (file) {
                                vscode.postMessage({ type: 'removeFile', path: file.path });
                            }
                        });
                    });
                }
            } else {
                contextBar.style.display = 'none';
                contextFilesList.innerHTML = '';
            }
        }
        
        function addLoadingIndicator() {
            const existing = document.querySelector('.loading');
            if (existing) return;
            
            // Add divider before assistant response
            const existingDivider = chatContainer.querySelector('.message-divider:last-child');
            if (!existingDivider) {
                const divider = document.createElement('div');
                divider.className = 'message-divider';
                divider.innerHTML = '<div class="message-divider-dot"></div>';
                chatContainer.appendChild(divider);
            }
            
            const loading = document.createElement('div');
            loading.className = 'message assistant loading';
            loading.innerHTML = '<div class="loading-dots">Thinking</div>';
            chatContainer.appendChild(loading);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        function removeLoadingIndicator() {
            const loading = document.querySelector('.loading');
            if (loading) loading.remove();
        }
        
        function appendToLastMessage(text) {
            removeLoadingIndicator();
            
            let lastMsg = chatContainer.querySelector('.message.assistant:last-child');
            if (!lastMsg || lastMsg.classList.contains('loading')) {
                lastMsg = document.createElement('div');
                lastMsg.className = 'message assistant';
                lastMsg.innerHTML = '<div class="message-header">AstraCode</div><div class="message-content"></div>';
                chatContainer.appendChild(lastMsg);
            }
            
            const content = lastMsg.querySelector('.message-content');
            content.textContent += text;
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        function replaceLastResponse(text) {
            const lastMsg = chatContainer.querySelector('.message.assistant:last-child');
            if (lastMsg && !lastMsg.classList.contains('loading')) {
                const content = lastMsg.querySelector('.message-content');
                if (content) {
                    content.textContent = text;
                }
            }
        }
        
        // Called when response is complete - converts plain text to rendered markdown with clickable links
        function finalizeLastMessage() {
            const lastMsg = chatContainer.querySelector('.message.assistant:last-child');
            if (lastMsg && !lastMsg.classList.contains('loading')) {
                const content = lastMsg.querySelector('.message-content');
                if (content && content.textContent) {
                    // Convert plain text to rendered markdown
                    content.innerHTML = renderMarkdown(content.textContent);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            }
        }
        
        // Simple markdown renderer for code blocks and file links
        // Simple markdown renderer for code blocks and formatting
        function renderMarkdown(text) {
            // Escape HTML first
            let html = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            // Render fenced code blocks (using String.fromCharCode to avoid template issues)
            const tick = String.fromCharCode(96); // backtick character
            // More forgiving regex - newline before closing backticks is optional
            const codeBlockRegex = new RegExp(tick + tick + tick + '(\\\\w*)\\\\n?([\\\\s\\\\S]*?)\\\\n?' + tick + tick + tick, 'g');
            
            // Track code block positions to protect them from further processing
            const codeBlocks = [];
            html = html.replace(codeBlockRegex, function(match, lang, code) {
                const placeholder = '___CODEBLOCK_' + codeBlocks.length + '___';
                codeBlocks.push('<pre class="code-block" data-lang="' + lang + '"><code>' + code + '</code></pre>');
                return placeholder;
            });
            
            // Render inline code and protect from further processing
            const inlineCodeRegex = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
            const inlineCodes = [];
            html = html.replace(inlineCodeRegex, function(match, code) {
                const placeholder = '___INLINECODE_' + inlineCodes.length + '___';
                inlineCodes.push('<code class="inline-code">' + code + '</code>');
                return placeholder;
            });
            
            // Render headers
            html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
            
            // Render bold
            html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            
            // Render italic - but NOT if it looks like a comment (/* or */)
            // Only match standalone *text* not part of /* */
            html = html.replace(/(?<![\\/*])\\*([^\\*\\n]+)\\*(?![\\/*])/g, '<em>$1</em>');
            
            // Render horizontal rules
            html = html.replace(/^---$/gm, '<hr>');
            
            // Render blockquotes
            html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
            
            // Render markdown links [text](url)
            // Handle command: links specially - convert to clickable buttons
            html = html.replace(/\\[([^\\]]+)\\]\\(command:([^)]+)\\)/g, function(match, text, command) {
                // Decode the command URL and extract the file URI
                try {
                    const decoded = decodeURIComponent(command);
                    // Extract the command name and args
                    const parts = decoded.split('?');
                    const cmdName = parts[0];
                    const args = parts[1] ? JSON.parse(parts[1]) : [];
                    // Store as data attributes for click handler
                    return '<button class="doc-link-btn" data-command="' + cmdName + '" data-args="' + encodeURIComponent(JSON.stringify(args)) + '">' + text + '</button>';
                } catch (e) {
                    return '<button class="doc-link-btn" data-command="' + command + '">' + text + '</button>';
                }
            });
            
            // Render regular markdown links
            html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" class="external-link">$1</a>');
            
            // Preserve line breaks
            html = html.replace(/\\n/g, '<br>');
            
            // Restore code blocks
            for (let i = 0; i < codeBlocks.length; i++) {
                html = html.replace('___CODEBLOCK_' + i + '___', codeBlocks[i]);
            }
            
            // Restore inline codes and add file link detection
            for (let i = 0; i < inlineCodes.length; i++) {
                let code = inlineCodes[i];
                // Check if it's a file path
                const pathMatch = code.match(/<code class="inline-code">([^<]+)<\\/code>/);
                if (pathMatch) {
                    const filePath = pathMatch[1];
                    // Check for file extensions (relative or absolute paths)
                    // Match both: myfile.md and C:\\Users\\path\\myfile.md and /tmp/myfile.md
                    const hasFileExt = /\\.(java|py|js|ts|c|cpp|go|rs|rb|cs|kt|swift|php|sql|md|txt|json|xml|html|yaml|yml|tal|cbl|cobol)$/i.test(filePath);
                    // Also check if it looks like a full path (starts with / or drive letter)
                    const isFullPath = /^([A-Za-z]:|[\\/])/.test(filePath);
                    
                    if (hasFileExt) {
                        code = '<code class="inline-code file-link" data-path="' + filePath + '" title="Click to open in VS Code">📄 ' + filePath + '</code>';
                    }
                }
                html = html.replace('___INLINECODE_' + i + '___', code);
            }
            
            return html;
        }
        
        function escapeHtml(text) {
            // Now use the markdown renderer instead
            return renderMarkdown(text);
        }
        
        // Add click handler for file links
        document.addEventListener('click', function(e) {
            if (e.target.classList.contains('file-link')) {
                const filePath = e.target.dataset.path || e.target.textContent;
                if (filePath) {
                    vscode.postMessage({ type: 'openFile', filePath: filePath });
                }
            }
            // Handle doc-link-btn clicks (command links from markdown)
            if (e.target.classList.contains('doc-link-btn')) {
                const command = e.target.dataset.command;
                let args = [];
                try {
                    args = JSON.parse(decodeURIComponent(e.target.dataset.args || '[]'));
                } catch (err) {
                    console.log('Could not parse args:', err);
                }
                if (command) {
                    // For vscode.open command, extract the URI
                    if (command === 'vscode.open' && args.length > 0) {
                        vscode.postMessage({ type: 'openFileUri', fileUri: args[0] });
                    } else {
                        vscode.postMessage({ type: 'executeCommand', command: command, args: args });
                    }
                }
            }
            // Handle code block clicks (copy to clipboard)
            if (e.target.closest('.code-block')) {
                const code = e.target.closest('.code-block').textContent;
                navigator.clipboard.writeText(code).then(function() {
                    // Show brief "copied" feedback
                    const block = e.target.closest('.code-block');
                    block.classList.add('copied');
                    setTimeout(function() { block.classList.remove('copied'); }, 1000);
                });
            }
        });
        
        // Set initial active mode
        document.querySelector('.mode-btn[data-mode="auto"]').classList.add('active');
    </script>
</body>
</html>`;
    }
    
    /**
     * Restore chat history to the webview
     * Called when webview becomes visible or is first created
     */
    restoreChatToWebview() {
        if (!chatWebviewView?.webview) {
            return;
        }
        
        // Send chat history to webview
        if (chatHistory && chatHistory.length > 0) {
            log('Restoring', chatHistory.length, 'chat messages to webview');
            
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
        }
        
        // Update status with current context file count
        updateChatStatus();
    }
}

// ============================================================
// PLAN & EXECUTE AGENTIC ARCHITECTURE
// ============================================================

// ============================================================
// Fuzzy Matching for Code Search
// ============================================================

/**
 * Calculate fuzzy match score between query and symbol name
 * Higher score = better match
 * Returns 0 if no match
 */
function fuzzyMatchScore(query, symbolName) {
    const q = query.toLowerCase();
    const s = symbolName.toLowerCase();
    
    // Exact match - highest priority
    if (s === q) return 100;
    
    // Exact substring match
    if (s.includes(q)) return 80;
    
    // Query is abbreviation of CamelCase (e.g., "rte" matches "RangeTblEntry")
    const camelScore = matchCamelCaseAbbrev(q, symbolName);
    if (camelScore > 0) return 70 + camelScore;
    
    // Query matches word boundaries (e.g., "parse_rel" matches "parse_relation")
    const wordScore = matchWordBoundaries(q, s);
    if (wordScore > 0) return 60 + wordScore;
    
    // All query characters appear in order (subsequence match)
    const subseqScore = matchSubsequence(q, s);
    if (subseqScore > 0) return 40 + subseqScore;
    
    return 0;
}

/**
 * Match CamelCase abbreviation
 * "RTE" matches "RangeTblEntry", "pf" matches "parseFrom"
 */
function matchCamelCaseAbbrev(abbrev, name) {
    // Extract capital letters and first letter
    const capitals = name.match(/^[a-z]|[A-Z]/g);
    if (!capitals) return 0;
    
    const abbrevLower = abbrev.toLowerCase();
    const capitalsLower = capitals.join('').toLowerCase();
    
    // Check if abbrev matches capitals
    if (capitalsLower.startsWith(abbrevLower)) {
        return 20 * (abbrevLower.length / capitalsLower.length);
    }
    
    // Check if abbrev is subsequence of capitals
    let ai = 0;
    for (let ci = 0; ci < capitalsLower.length && ai < abbrevLower.length; ci++) {
        if (capitalsLower[ci] === abbrevLower[ai]) ai++;
    }
    if (ai === abbrevLower.length) {
        return 15 * (abbrevLower.length / capitalsLower.length);
    }
    
    return 0;
}

/**
 * Match word boundaries (underscore or camelCase transitions)
 */
function matchWordBoundaries(query, name) {
    // Split by underscore or camelCase
    const words = name.split(/[_]|(?=[A-Z])/).map(w => w.toLowerCase()).filter(w => w);
    const queryParts = query.split(/[_\s]/).filter(p => p);
    
    let matchedParts = 0;
    for (const qp of queryParts) {
        for (const word of words) {
            if (word.startsWith(qp) || word.includes(qp)) {
                matchedParts++;
                break;
            }
        }
    }
    
    if (matchedParts === queryParts.length) {
        return 20 * (matchedParts / words.length);
    }
    
    return matchedParts > 0 ? 10 * (matchedParts / queryParts.length) : 0;
}

/**
 * Check if query is a subsequence of name
 */
function matchSubsequence(query, name) {
    let qi = 0;
    for (let ni = 0; ni < name.length && qi < query.length; ni++) {
        if (name[ni] === query[qi]) qi++;
    }
    
    if (qi === query.length) {
        // Score based on how compact the match is
        return 20 * (query.length / name.length);
    }
    
    return 0;
}

/**
 * Search symbols with fuzzy matching
 * Handles large repositories with early termination and result limits
 */
function fuzzySearchSymbols(query, type = null, minScore = 30, maxResults = INDEX_CONFIG.SEARCH_RESULT_LIMIT) {
    const results = [];
    let scanned = 0;
    const maxScan = codeIndex.symbols.size > 10000 ? 10000 : codeIndex.symbols.size; // Limit scan for huge repos
    
    for (const [key, symbol] of codeIndex.symbols) {
        if (scanned++ > maxScan) {
            log('fuzzySearchSymbols: Hit scan limit at', maxScan);
            break;
        }
        
        if (type && symbol.type !== type) continue;
        
        const score = fuzzyMatchScore(query, symbol.name);
        if (score >= minScore) {
            results.push({
                ...symbol,
                file: symbol.file?.split('/').pop() || key.split('@')[1]?.split('/').pop(),
                matchScore: score
            });
            
            // Early termination if we have enough high-quality results
            if (results.length >= maxResults * 2 && results.filter(r => r.matchScore > 70).length >= maxResults) {
                log('fuzzySearchSymbols: Early termination with', results.length, 'results');
                break;
            }
        }
    }
    
    // Sort by score descending
    results.sort((a, b) => b.matchScore - a.matchScore);
    
    // Return limited results
    return results.slice(0, maxResults);
}

/**
 * AGENT TOOLS REGISTRY
 * Defines all available tools the agent can use
 */
const AGENT_TOOLS = {
    // === CONTEXT TOOLS (work with attached files) ===
    read_context_file: {
        name: 'read_context_file',
        description: 'Read content of a specific file from the attached context',
        parameters: { fileName: 'string' },
        execute: async (params) => {
            const { fileName } = params;
            for (const [path, file] of contextFiles) {
                const name = path.split('/').pop();
                if (name === fileName || name.toLowerCase() === fileName.toLowerCase()) {
                    return { 
                        success: true, 
                        data: { 
                            fileName: name, 
                            content: file.content, 
                            language: file.language,
                            size: file.content.length 
                        }
                    };
                }
            }
            return { success: false, error: `File "${fileName}" not found in context` };
        }
    },
    
    list_context_files: {
        name: 'list_context_files',
        description: 'List all files currently in context with their sizes and languages',
        parameters: {},
        execute: async () => {
            const files = [];
            for (const [path, file] of contextFiles) {
                files.push({
                    name: path.split('/').pop(),
                    path: path,
                    language: file.language,
                    size: file.content.length,
                    lines: file.content.split('\n').length
                });
            }
            return { success: true, data: { files, count: files.length } };
        }
    },
    
    grep_context: {
        name: 'grep_context',
        description: 'Search for a pattern across all context files using trigram index (fast). Returns matching lines with context.',
        parameters: { pattern: 'string', caseSensitive: 'boolean?', contextLines: 'number?' },
        execute: async (params) => {
            const { pattern, caseSensitive = false, contextLines = 5 } = params;
            log('grep_context: Searching for:', pattern);
            
            // Try fast trigram search first (uses trigramIndex from extension.js, not symbolTrigramIndex)
            if (pattern.length >= 3 && trigramIndex?.index?.size > 0) {
                try {
                    const matches = searchModule.findTextInCode(pattern, { caseSensitive, maxResults: 100 });
                    const results = [];
                    const seen = new Set();
                    
                    for (const m of matches) {
                        const key = `${m.file}:${Math.floor(m.line / contextLines)}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const block = searchModule.getCodeBlockForMatch(m.file, m.line, { contextLines });
                        results.push({ fileName: m.fileName, startLine: block.startLine, endLine: block.endLine, matchCount: 1, content: block.code });
                    }
                    log('grep_context: Trigram found', results.length, 'blocks');
                    return { success: true, data: { results, count: results.length, totalMatches: matches.length, method: 'trigram' } };
                } catch (e) { log('grep_context: Trigram failed, fallback:', e.message); }
            }
            
            // Fallback: linear scan
            const results = [];
            const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
            for (const [path, file] of contextFiles) {
                const fileName = path.split('/').pop();
                const lines = file.content.split('\n');
                const matchedLineNums = new Set();
                lines.forEach((line, idx) => { regex.lastIndex = 0; if (regex.test(line)) matchedLineNums.add(idx); });
                if (matchedLineNums.size > 0) {
                    const sorted = Array.from(matchedLineNums).sort((a, b) => a - b);
                    let ranges = [], cur = null;
                    for (const ln of sorted) {
                        const s = Math.max(0, ln - contextLines), e = Math.min(lines.length - 1, ln + contextLines);
                        if (cur && s <= cur.end + 2) { cur.end = e; cur.matchLines.push(ln); }
                        else { if (cur) ranges.push(cur); cur = { start: s, end: e, matchLines: [ln] }; }
                    }
                    if (cur) ranges.push(cur);
                    for (const r of ranges) {
                        const code = lines.slice(r.start, r.end + 1).map((l, i) => {
                            const n = r.start + i + 1, isM = r.matchLines.includes(r.start + i);
                            return `${n.toString().padStart(4)}: ${isM ? '>>> ' : '    '}${l}`;
                        }).join('\n');
                        results.push({ fileName, startLine: r.start + 1, endLine: r.end + 1, matchCount: r.matchLines.length, content: code });
                    }
                }
            }
            log('grep_context: Linear found', results.length, 'blocks');
            return { success: true, data: { results, count: results.length, totalMatches: results.reduce((s, r) => s + r.matchCount, 0), method: 'linear' } };
        }
    },
    
    // === CALL GRAPH SEARCH ===
    search_calls: {
        name: 'search_calls',
        description: 'Search call relationships - who calls a function or what it calls.',
        parameters: { function: 'string', direction: 'string?' },
        execute: async (params) => {
            const { function: fn, direction = 'both' } = params;
            log('search_calls:', fn, direction);
            try {
                let result = {};
                if (direction === 'callers' || direction === 'both') {
                    const r = searchModule.searchWhoCallsFunction(fn);
                    result.function = r.function; result.callers = r.callers;
                }
                if (direction === 'callees' || direction === 'both') {
                    const r = searchModule.searchWhatFunctionCalls(fn);
                    if (!result.function) result.function = r.function;
                    result.callees = r.callees;
                }
                if (!result.function) return { success: false, error: `Function "${fn}" not found` };
                return { success: true, data: result };
            } catch (e) { return { success: false, error: e.message }; }
        }
    },
    
    // === LOCAL INDEX TOOLS (work with in-memory code index) ===
    search_index: {
        name: 'search_index',
        description: 'Search the local code index for symbols, functions, classes using fuzzy matching. Handles cryptic names like "RTE" matching "RangeTblEntry". Returns symbol definitions with locations and call relationships.',
        parameters: { pattern: 'string', type: 'string?', fuzzy: 'boolean?' },
        execute: async (params) => {
            const { pattern, type, fuzzy = true } = params;
            
            log('search_index: Searching for pattern:', pattern, 'type:', type || 'all', 'fuzzy:', fuzzy);
            showProgress(`Searching index for: "${pattern}"${type ? ` (type: ${type})` : ''}`, 'index');
            
            const results = {
                symbols: [],
                functions: [],
                classes: [],
                callGraph: [],
                calledBy: []
            };
            
            if (fuzzy) {
                // Use fuzzy matching
                const fuzzyResults = fuzzySearchSymbols(pattern, type, 30);
                log('search_index: Fuzzy search found', fuzzyResults.length, 'matches');
                
                for (const symbol of fuzzyResults) {
                    results.symbols.push({
                        name: symbol.name,
                        type: symbol.type,
                        file: symbol.file,
                        line: symbol.line,
                        params: symbol.params,
                        dataType: symbol.dataType,
                        matchScore: symbol.matchScore
                    });
                    
                    // Categorize
                    if (symbol.type === 'function' || symbol.type === 'method' || symbol.type === 'procedure') {
                        results.functions.push(symbol.name);
                    } else if (symbol.type === 'class') {
                        results.classes.push(symbol.name);
                    }
                }
            } else {
                // Use regex matching
                const regex = new RegExp(pattern, 'i');
                
                for (const [key, symbol] of codeIndex.symbols) {
                    if (regex.test(symbol.name)) {
                        if (type && symbol.type !== type) continue;
                        
                        results.symbols.push({
                            name: symbol.name,
                            type: symbol.type,
                            file: symbol.file?.split('/').pop() || key.split('@')[1]?.split('/').pop(),
                            line: symbol.line,
                            params: symbol.params,
                            dataType: symbol.dataType
                        });
                        
                        if (symbol.type === 'function' || symbol.type === 'method' || symbol.type === 'procedure') {
                            results.functions.push(symbol.name);
                        } else if (symbol.type === 'class') {
                            results.classes.push(symbol.name);
                        }
                    }
                }
            }
            
            // Get call graph for matched functions
            for (const funcName of results.functions) {
                const calls = codeIndex.callGraph.get(funcName);
                if (calls && calls.size > 0) {
                    results.callGraph.push({
                        function: funcName,
                        calls: Array.from(calls)
                    });
                }
                
                const callers = codeIndex.reverseCallGraph.get(funcName);
                if (callers && callers.size > 0) {
                    results.calledBy.push({
                        function: funcName,
                        calledBy: Array.from(callers)
                    });
                }
            }
            
            // Show results
            showProgress(`Found ${results.symbols.length} symbols, ${results.functions.length} functions`, 'found');
            if (results.symbols.length > 0) {
                const topMatches = results.symbols.slice(0, 5).map(s => s.name).join(', ');
                showProgress(`Top matches: ${topMatches}`, 'found');
            }
            
            log('search_index: Found', results.symbols.length, 'symbols,', 
                results.functions.length, 'functions,',
                results.classes.length, 'classes');
            
            return { 
                success: true, 
                data: { 
                    ...results,
                    summary: {
                        symbolCount: results.symbols.length,
                        functionCount: results.functions.length,
                        classCount: results.classes.length,
                        hasCallGraph: results.callGraph.length > 0
                    }
                } 
            };
        }
    },
    
    // === TRIGRAM SEARCH (exact/partial text matching - Zoekt-style) ===
    search_trigram: {
        name: 'search_trigram',
        description: 'Fast exact/partial text search using trigram index (like Sourcegraph/Zoekt). Best for finding exact strings, variable names, or partial matches in code.',
        parameters: { query: 'string', caseSensitive: 'boolean?', maxResults: 'number?' },
        execute: async (params) => {
            const { query, caseSensitive = false, maxResults = 20 } = params;
            
            log('search_trigram: Searching for:', query);
            showProgress(`Trigram search: "${query}"`, 'search');
            
            if (trigramIndex.index.size === 0) {
                return { 
                    success: false, 
                    error: 'Trigram index not built. Run "Rebuild Index" first.' 
                };
            }
            
            const results = searchTrigramIndex(query, { caseSensitive, maxResults });
            
            if (results.length === 0) {
                showProgress(`No exact matches for "${query}"`, 'warn');
                return { 
                    success: true, 
                    data: { matches: [], totalMatches: 0, message: 'No exact matches found' }
                };
            }
            
            // Format results
            const formattedResults = results.map(r => ({
                file: r.file,
                fileName: r.fileName,
                matchCount: r.matchCount,
                matches: r.matches.map(m => ({
                    line: m.line,
                    context: m.context
                }))
            }));
            
            const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);
            showProgress(`Trigram: found ${totalMatches} matches in ${results.length} files`, 'found');
            
            return {
                success: true,
                data: {
                    matches: formattedResults,
                    totalMatches,
                    filesSearched: trigramIndex.stats.files,
                    trigramsIndexed: trigramIndex.stats.trigrams
                }
            };
        }
    },
    
    // === VECTOR/SEMANTIC SEARCH ===
    search_semantic: {
        name: 'search_semantic',
        description: 'Semantic code search using TF-IDF embeddings. Finds conceptually similar code even without exact keyword matches.',
        parameters: { query: 'string', topK: 'number?' },
        execute: async (params) => {
            const { query, topK = 10 } = params;
            
            log('search_semantic: Searching for:', query);
            showProgress(`Semantic search: "${query}"`, 'search');
            
            if (vectorIndex.chunks.length === 0) {
                return { 
                    success: false, 
                    error: 'Vector index not built. Run "Rebuild Index" first.' 
                };
            }
            
            const results = searchVectorIndex(query, topK);
            
            if (results.length === 0) {
                showProgress(`No semantic matches for "${query}"`, 'warn');
                return { 
                    success: true, 
                    data: { matches: [], message: 'No semantic matches found' }
                };
            }
            
            // Format results
            const formattedResults = results.map(r => ({
                file: r.file,
                fileName: r.fileName,
                startLine: r.startLine,
                endLine: r.endLine,
                type: r.type,
                symbolName: r.symbolName,
                similarity: r.similarity.toFixed(3),
                preview: r.text?.substring(0, 200)
            }));
            
            showProgress(`Semantic: found ${results.length} matches (best: ${results[0]?.similarity?.toFixed(2)})`, 'found');
            
            return {
                success: true,
                data: {
                    matches: formattedResults,
                    model: vectorIndex.model,
                    vocabulary: tfidfVocabulary.built ? tfidfVocabulary.terms.size : 0
                }
            };
        }
    },
    
    get_function_context: {
        name: 'get_function_context',
        description: 'Get the full source code of a specific function/method and its call relationships',
        parameters: { functionName: 'string' },
        execute: async (params) => {
            const { functionName } = params;
            
            log('get_function_context: Looking for function:', functionName);
            
            // Find the symbol
            let symbol = codeIndex.symbols.get(functionName);
            if (!symbol) {
                // Try to find by partial match
                for (const [key, sym] of codeIndex.symbols) {
                    if (sym.name === functionName || key.startsWith(functionName + '@')) {
                        symbol = sym;
                        break;
                    }
                }
            }
            
            if (!symbol) {
                return { success: false, error: `Function "${functionName}" not found in index` };
            }
            
            // Get the file content
            const file = contextFiles.get(symbol.file);
            if (!file) {
                return { success: false, error: `Source file not in context: ${symbol.file}` };
            }
            
            // Extract function body (heuristic: from definition line to next function or end)
            const lines = file.content.split('\n');
            const startLine = symbol.line - 1;
            let endLine = startLine + 1;
            
            // Find end of function (simple heuristic based on indentation/braces)
            const startIndent = lines[startLine].match(/^\s*/)[0].length;
            for (let i = startLine + 1; i < lines.length; i++) {
                const line = lines[i];
                const indent = line.match(/^\s*/)[0].length;
                // Check for next function at same or lower indentation
                if (line.trim() && indent <= startIndent && 
                    (line.match(/^[\s]*(def |class |function |async function |proc |procedure )/i) ||
                     (indent === 0 && line.match(/^\w/)))) {
                    endLine = i;
                    break;
                }
                endLine = i + 1;
            }
            
            // Limit to 100 lines max
            endLine = Math.min(endLine, startLine + 100);
            
            const functionCode = lines.slice(startLine, endLine)
                .map((line, i) => `${(startLine + i + 1).toString().padStart(4)}: ${line}`)
                .join('\n');
            
            // Get call relationships
            const calls = codeIndex.callGraph.get(functionName);
            const calledBy = codeIndex.reverseCallGraph.get(functionName);
            
            log('get_function_context: Found function at line', symbol.line, 
                'calls:', calls?.size || 0, 'calledBy:', calledBy?.size || 0);
            
            return {
                success: true,
                data: {
                    name: functionName,
                    file: symbol.file?.split('/').pop(),
                    line: symbol.line,
                    type: symbol.type,
                    params: symbol.params,
                    code: functionCode,
                    calls: calls ? Array.from(calls) : [],
                    calledBy: calledBy ? Array.from(calledBy) : []
                }
            };
        }
    },

    // === COMPREHENSIVE SEARCH (combines index + grep) ===
    search_code: {
        name: 'search_code',
        description: 'Comprehensive code search: combines symbol index (fuzzy) + trigram index (exact text) for thorough results. Use this for implementation questions.',
        parameters: { query: 'string', contextLines: 'number?', expandTerms: 'boolean?' },
        execute: async (params) => {
            const { query, contextLines = 5, expandTerms = true } = params;
            
            log('search_code: Comprehensive search for:', query);
            showProgress(`Searching for: "${query}"`, 'search');
            
            // Build search terms from query
            let searchTerms = query.split(/[\s,|]+/).filter(t => t.length >= 2);
            log('search_code: Initial terms:', searchTerms);
            
            // LLM-powered term expansion - find related function/variable names
            if (expandTerms && searchTerms.length < 10) {
                try {
                    showProgress('Expanding search terms with LLM...', 'info');
                    const expansionPrompt = `Given this search query about code: "${query}"

Generate additional search terms that would help find the IMPLEMENTATION code.

Think about:
- Function names that might implement this (e.g., "prepare_", "build_", "create_", "_encode", "_parse")
- Variable names related to this feature
- Common programming patterns for this functionality

Current terms: ${searchTerms.join(', ')}

Return ONLY a comma-separated list of 5-10 additional search terms (single words, no phrases):`;
                    
                    const expandedTermsStr = await callLanguageModel(expansionPrompt);
                    const expandedTerms = expandedTermsStr
                        .split(/[,\n]+/)
                        .map(t => t.trim().toLowerCase())
                        .filter(t => t.length >= 2 && t.length <= 30 && !t.includes(' '));
                    
                    // Add unique expanded terms
                    const existingLower = new Set(searchTerms.map(t => t.toLowerCase()));
                    for (const term of expandedTerms.slice(0, 10)) {
                        if (!existingLower.has(term)) {
                            searchTerms.push(term);
                            existingLower.add(term);
                        }
                    }
                    log('search_code: Expanded terms:', searchTerms);
                    showProgress(`Search terms: ${searchTerms.slice(0, 8).join(', ')}${searchTerms.length > 8 ? '...' : ''}`, 'info');
                } catch (err) {
                    log('search_code: Term expansion failed:', err.message);
                }
            }
            
            const results = {
                indexResults: {
                    symbols: [],
                    functions: [],
                    callGraph: []
                },
                grepResults: [],
                combinedContext: ''
            };
            
            // 0. FILE NAME MATCHING (HIGH PRIORITY)
            // For queries like "explain partitioning", find files with "partition" in name
            // Bidirectional: keyword in filename OR common prefix match
            showProgress('Searching by file name...', 'search');
            const fileMatches = [];
            const seenSymbols = new Set();
            for (const term of searchTerms) {
                if (term.length < 3) continue;
                const termLower = term.toLowerCase();
                
                for (const [filePath, file] of contextFiles) {
                    const fileName = filePath.split('/').pop().toLowerCase();
                    const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
                    
                    // Check BOTH directions:
                    // 1. term in filename: "part" matches "partdesc.c"
                    // 2. common prefix: "partitioning" and "partdesc" both start with "part"
                    const termInFile = fileNameNoExt.includes(termLower) || fileName.includes(termLower);
                    const commonPrefix = fileNameNoExt.length >= 4 && termLower.length >= 4 && 
                                        fileNameNoExt.substring(0, 4) === termLower.substring(0, 4);
                    
                    if (termInFile || commonPrefix) {
                        // Get all symbols from this file
                        const fileSymbols = [];
                        for (const [symKey, symbol] of codeIndex.symbols) {
                            if (symbol.file === filePath && !symKey.includes('@')) {
                                fileSymbols.push(symbol);
                            }
                        }
                        
                        fileMatches.push({
                            file: filePath,
                            fileName: filePath.split('/').pop(),
                            matchedTerm: term,
                            symbolCount: fileSymbols.length,
                            symbols: fileSymbols.slice(0, 20)
                        });
                        log(`search_code: File name match: ${fileName} for term "${term}"`);
                    }
                }
            }
            
            // Add file matches to results with high priority
            if (fileMatches.length > 0) {
                results.indexResults.fileMatches = fileMatches;
                log('search_code: Found', fileMatches.length, 'files matching search terms by name');
                
                // Also add their symbols to the symbol results
                for (const fm of fileMatches.slice(0, 10)) {
                    for (const sym of fm.symbols) {
                        if (!seenSymbols.has(sym.name)) {
                            seenSymbols.add(sym.name);
                            results.indexResults.symbols.push({
                                name: sym.name,
                                type: sym.type,
                                file: sym.file,
                                line: sym.line,
                                matchScore: 100, // High score for file name match
                                source: 'filename-match'
                            });
                        }
                    }
                }
                
                // IMPORTANT: Also include actual code from these files
                // This ensures the LLM has real implementation code to reference
                for (const fm of fileMatches.slice(0, 5)) {
                    const file = contextFiles.get(fm.file);
                    if (!file) continue;
                    
                    const lines = file.content.split('\n');
                    
                    // Include key functions from the file
                    for (const sym of fm.symbols.slice(0, 8)) {
                        if (sym.type === 'function' || sym.type === 'procedure' || sym.type === 'method') {
                            const start = Math.max(0, sym.line - 1);
                            const end = Math.min(lines.length - 1, start + 50); // Up to 50 lines per function
                            
                            const codeBlock = lines.slice(start, end + 1)
                                .map((line, i) => `${(start + i + 1).toString().padStart(4)}: ${line}`)
                                .join('\n');
                            
                            results.grepResults.push({
                                fileName: fm.fileName,
                                startLine: start + 1,
                                endLine: end + 1,
                                matchCount: 1,
                                content: codeBlock,
                                source: 'filename-match',
                                functionName: sym.name
                            });
                        }
                    }
                }
            }
            
            // 1. Search index with fuzzy matching for each term
            showProgress('Searching symbol index...', 'index');
            for (const term of searchTerms) {
                const fuzzyResults = fuzzySearchSymbols(term, null, 40);
                for (const symbol of fuzzyResults.slice(0, 10)) { // Top 10 per term
                    if (!seenSymbols.has(symbol.name)) {
                        seenSymbols.add(symbol.name);
                        results.indexResults.symbols.push({
                            name: symbol.name,
                            type: symbol.type,
                            file: symbol.file,
                            line: symbol.line,
                            matchScore: symbol.matchScore
                        });
                        
                        if (symbol.type === 'function' || symbol.type === 'method' || symbol.type === 'procedure') {
                            results.indexResults.functions.push(symbol.name);
                            
                            // Get call graph
                            const calls = codeIndex.callGraph.get(symbol.name);
                            const calledBy = codeIndex.reverseCallGraph.get(symbol.name);
                            if (calls?.size > 0 || calledBy?.size > 0) {
                                results.indexResults.callGraph.push({
                                    function: symbol.name,
                                    calls: calls ? Array.from(calls) : [],
                                    calledBy: calledBy ? Array.from(calledBy) : []
                                });
                            }
                        }
                    }
                }
            }
            
            log('search_code: Index search found', results.indexResults.symbols.length, 'symbols');
            showProgress(`Symbol index: found ${results.indexResults.symbols.length} symbols, ${results.indexResults.functions.length} functions`, 'found');
            
            // 2. Trigram search for exact text matches (replaces grep - faster and more accurate)
            showProgress(`Trigram searching ${trigramIndex.stats.files} indexed files...`, 'search');
            
            const MAX_TRIGRAM_RESULTS = 50;
            const seenBlocks = new Set();
            
            for (const term of searchTerms.slice(0, 8)) {
                if (term.length < 3) continue; // Trigram needs at least 3 chars
                
                const trigramResults = searchTrigramIndex(term, { maxResults: 15 });
                
                for (const fileResult of trigramResults) {
                    if (results.grepResults.length >= MAX_TRIGRAM_RESULTS) break;
                    
                    const file = contextFiles.get(fileResult.file);
                    if (!file) continue;
                    
                    const lines = file.content.split('\n');
                    
                    // Group matches into code blocks
                    for (const match of fileResult.matches.slice(0, 5)) {
                        const blockKey = `${fileResult.file}:${Math.floor(match.line / 10)}`;
                        if (seenBlocks.has(blockKey)) continue;
                        seenBlocks.add(blockKey);
                        
                        const contextLines = 5;
                        const start = Math.max(0, match.line - 1 - contextLines);
                        const end = Math.min(lines.length - 1, match.line - 1 + contextLines);
                        
                        const codeBlock = lines.slice(start, end + 1)
                            .map((line, i) => {
                                const actualLineNum = start + i + 1;
                                const isMatch = actualLineNum === match.line;
                                return `${actualLineNum.toString().padStart(4)}: ${isMatch ? '>>> ' : '    '}${line}`;
                            })
                            .join('\n');
                        
                        results.grepResults.push({
                            fileName: fileResult.fileName,
                            startLine: start + 1,
                            endLine: end + 1,
                            matchCount: 1,
                            content: codeBlock
                        });
                    }
                }
                
                if (results.grepResults.length >= MAX_TRIGRAM_RESULTS) break;
            }
            
            log('search_code: Trigram found', results.grepResults.length, 'code blocks');
            showProgress(`Trigram: found ${results.grepResults.length} code blocks`, 'found');
            
            // 3. Build combined context for LLM
            let combined = '# SEARCH RESULTS\n\n';
            
            // Check if we found anything
            const foundNothing = results.indexResults.symbols.length === 0 && results.grepResults.length === 0;
            
            if (foundNothing) {
                showProgress('No results found - try different search terms', 'warn');
                combined += `## No Results Found\n`;
                combined += `Search query "${query}" did not match any symbols or code in the attached files.\n\n`;
                combined += `### Files searched:\n`;
                for (const [path] of contextFiles) {
                    combined += `- ${path.split('/').pop()}\n`;
                }
                combined += `\n### Suggestions:\n`;
                combined += `- Try different search terms\n`;
                combined += `- Check if the relevant code is in the attached files\n`;
                combined += `- Use more general terms\n`;
            } else {
                // Show top matches to user
                const topSymbols = results.indexResults.symbols.slice(0, 5).map(s => s.name).join(', ');
                if (topSymbols) {
                    showProgress(`Top matches: ${topSymbols}`, 'found');
                }
                
                // Include file matches (files with search terms in name) - HIGH PRIORITY
                if (results.indexResults.fileMatches?.length > 0) {
                    combined += '## 📁 KEY FILES (name matches search terms)\n';
                    combined += 'These files are highly relevant based on filename matching:\n\n';
                    for (const fm of results.indexResults.fileMatches.slice(0, 10)) {
                        combined += `### ${fm.fileName}\n`;
                        combined += `Matched term: "${fm.matchedTerm}" | ${fm.symbolCount} symbols\n`;
                        if (fm.symbols.length > 0) {
                            combined += 'Key functions/types:\n';
                            for (const sym of fm.symbols.slice(0, 15)) {
                                combined += `- ${sym.name} (${sym.type}) line ${sym.line}\n`;
                            }
                        }
                        combined += '\n';
                    }
                    combined += '\n';
                }
                
                // Include ALL index results - answer_question will handle chunking

                if (results.indexResults.symbols.length > 0) {
                    combined += '## Symbols Found (by relevance)\n\n';
                    
                    // Limit to top symbols to avoid context explosion (configurable)
                    const maxSymbolsInContext = AGENT_CONFIG.maxSymbolsInContext || 30;
                    const codeSnippetLines = AGENT_CONFIG.codeSnippetLines || 25;
                    const topSymbols = results.indexResults.symbols.slice(0, maxSymbolsInContext);
                    
                    for (const sym of topSymbols) {
                        combined += `### ${sym.name} (${sym.type}) - ${sym.file}:${sym.line}\n`;
                        
                        // Get actual code for this symbol
                        const filePath = sym.file;
                        const file = contextFiles.get(filePath);
                        if (file && file.content) {
                            const lines = file.content.split('\n');
                            const startLine = Math.max(0, sym.line - 1);
                            const endLine = Math.min(lines.length, sym.line + codeSnippetLines - 1);
                            const codeSnippet = lines.slice(startLine, endLine).join('\n');
                            // Use detected language for syntax highlighting
                            const lang = file.language || detectLanguage(filePath) || '';
                            combined += '```' + lang + '\n' + codeSnippet + '\n```\n\n';
                        }
                    }
                }
                
                // Include ALL call graph relationships
                if (results.indexResults.callGraph.length > 0) {
                    combined += '## Call Relationships\n';
                    for (const cg of results.indexResults.callGraph) {
                        if (cg.calls.length > 0) {
                            combined += `- ${cg.function} calls: ${cg.calls.join(', ')}\n`;
                        }
                        if (cg.calledBy.length > 0) {
                            combined += `- ${cg.function} called by: ${cg.calledBy.join(', ')}\n`;
                        }
                    }
                    combined += '\n';
                }
                
                // Include ALL grep results - answer_question will chunk if needed
                if (results.grepResults.length > 0) {
                    combined += '## Relevant Code\n\n';
                    
                    for (const block of results.grepResults) {
                        combined += `### ${block.fileName} (lines ${block.startLine}-${block.endLine})\n`;
                        combined += '```\n' + block.content + '\n```\n\n';
                    }
                }
            }
            
            results.combinedContext = combined;
            log('search_code: Final context size:', combined.length, 'chars');
            log('search_code: Will be chunked if > 18KB by answer_question');
            
            // VERBOSE: Show detailed search results summary to user
            if (AGENT_CONFIG.verboseSearch) {
                let verboseOutput = '\n**🔎 search_code Verbose Results:**\n\n';
                
                // Search terms used
                verboseOutput += `**Search Terms:** \`${searchTerms.slice(0, 12).join('`, `')}\`\n\n`;
                
                // File name matches
                if (results.indexResults.fileMatches?.length > 0) {
                    verboseOutput += `**File Name Matches (${results.indexResults.fileMatches.length}):**\n`;
                    verboseOutput += `| File | Matched Term | Symbols |\n`;
                    verboseOutput += `|:-----|:-------------|:--------|\n`;
                    for (const fm of results.indexResults.fileMatches.slice(0, 10)) {
                        const topSyms = fm.symbols.slice(0, 3).map(s => s.name).join(', ');
                        verboseOutput += `| \`${fm.fileName}\` | "${fm.matchedTerm}" | ${topSyms}... |\n`;
                    }
                    verboseOutput += '\n';
                }
                
                // Symbol index hits
                verboseOutput += `**Symbol Index Hits (${results.indexResults.symbols.length}):**\n`;
                verboseOutput += `| Symbol | Type | Location | Score |\n`;
                verboseOutput += `|:-------|:-----|:---------|:------|\n`;
                for (const sym of results.indexResults.symbols.slice(0, 15)) {
                    const fileName = sym.file?.split('/').pop() || 'unknown';
                    verboseOutput += `| \`${sym.name}\` | ${sym.type} | ${fileName}:${sym.line} | ${sym.matchScore || '-'} |\n`;
                }
                if (results.indexResults.symbols.length > 15) {
                    verboseOutput += `| ... | +${results.indexResults.symbols.length - 15} more | | |\n`;
                }
                verboseOutput += '\n';
                
                // Trigram/grep hits
                verboseOutput += `**Code Block Hits (${results.grepResults.length}):**\n`;
                verboseOutput += `| File | Lines | Source |\n`;
                verboseOutput += `|:-----|:------|:-------|\n`;
                for (const block of results.grepResults.slice(0, 15)) {
                    verboseOutput += `| \`${block.fileName}\` | ${block.startLine}-${block.endLine} | ${block.source || 'trigram'} |\n`;
                }
                if (results.grepResults.length > 15) {
                    verboseOutput += `| ... | +${results.grepResults.length - 15} more | |\n`;
                }
                verboseOutput += '\n';
                
                // Call graph relationships
                if (results.indexResults.callGraph.length > 0) {
                    verboseOutput += `**Call Graph (${results.indexResults.callGraph.length} functions):**\n`;
                    for (const cg of results.indexResults.callGraph.slice(0, 8)) {
                        if (cg.calls.length > 0) {
                            verboseOutput += `- \`${cg.function}\` → calls: ${cg.calls.slice(0, 5).join(', ')}${cg.calls.length > 5 ? '...' : ''}\n`;
                        }
                        if (cg.calledBy.length > 0) {
                            verboseOutput += `- \`${cg.function}\` ← called by: ${cg.calledBy.slice(0, 5).join(', ')}${cg.calledBy.length > 5 ? '...' : ''}\n`;
                        }
                    }
                    verboseOutput += '\n';
                }
                
                verboseOutput += `**Total Context Size:** ${Math.round(combined.length/1024)}KB\n`;
                verboseOutput += '\n---\n';
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: verboseOutput
                });
            }
            
            return {
                success: true,
                data: {
                    ...results,
                    summary: {
                        symbolCount: results.indexResults.symbols.length,
                        functionCount: results.indexResults.functions.length,
                        grepBlocks: results.grepResults.length,
                        totalMatches: results.grepResults.reduce((s, r) => s + r.matchCount, 0)
                    }
                }
            };
        }
    },

    // === API SERVER TOOLS (work with indexed codebase) ===
    search_codebase: {
        name: 'search_codebase',
        description: 'Search the API server for code matching a query',
        parameters: { query: 'string', limit: 'number?' },
        execute: async (params) => {
            const { query, limit = 10 } = params;
            const config = vscode.workspace.getConfiguration('astra');
            const apiUrl = config.get('apiUrl') || 'http://localhost:8080';
            
            try {
                const response = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
                if (!response.ok) throw new Error(`API error: ${response.status}`);
                const data = await response.json();
                return { success: true, data };
            } catch (error) {
                return { success: false, error: error.message };
            }
        }
    },
    
    get_file_from_api: {
        name: 'get_file_from_api',
        description: 'Fetch a specific file from the API server by path',
        parameters: { filePath: 'string' },
        execute: async (params) => {
            const { filePath } = params;
            const config = vscode.workspace.getConfiguration('astra');
            const apiUrl = config.get('apiUrl') || 'http://localhost:8080';
            
            try {
                const response = await fetch(`${apiUrl}/api/file?path=${encodeURIComponent(filePath)}`);
                if (!response.ok) throw new Error(`API error: ${response.status}`);
                const data = await response.json();
                return { success: true, data };
            } catch (error) {
                return { success: false, error: error.message };
            }
        }
    },
    
    check_api_available: {
        name: 'check_api_available',
        description: 'Check if the API server is available and get its capabilities',
        parameters: {},
        execute: async () => {
            const config = vscode.workspace.getConfiguration('astra');
            const apiUrl = config.get('apiUrl') || 'http://localhost:8080';
            
            try {
                const response = await fetch(`${apiUrl}/health`, { 
                    method: 'GET',
                    signal: AbortSignal.timeout(3000)
                });
                if (response.ok) {
                    return { success: true, data: { available: true, url: apiUrl } };
                }
                return { success: true, data: { available: false, url: apiUrl } };
            } catch (error) {
                return { success: true, data: { available: false, url: apiUrl, error: error.message } };
            }
        }
    },
    
    // === CODE INDEX TOOLS (use local code index) ===
    get_symbol_info: {
        name: 'get_symbol_info',
        description: 'Get information about a symbol (function, class, variable) from the code index',
        parameters: { symbolName: 'string' },
        execute: async (params) => {
            const { symbolName } = params;
            const symbol = codeIndex.symbols.get(symbolName);
            if (symbol) {
                const calls = codeIndex.callGraph.get(symbolName);
                const callers = codeIndex.reverseCallGraph.get(symbolName);
                return { 
                    success: true, 
                    data: { 
                        ...symbol, 
                        calls: calls ? [...calls] : [],
                        calledBy: callers ? [...callers] : []
                    }
                };
            }
            return { success: false, error: `Symbol "${symbolName}" not found in index` };
        }
    },
    
    get_call_graph: {
        name: 'get_call_graph',
        description: 'Get the call graph for a function (what it calls and what calls it)',
        parameters: { functionName: 'string', depth: 'number?' },
        execute: async (params) => {
            const { functionName, depth = 3 } = params;
            const graph = buildCallGraphFromSymbol(functionName, depth);
            if (graph.nodes.size > 0) {
                return { 
                    success: true, 
                    data: { 
                        root: graph.root,
                        nodes: [...graph.nodes.keys()],
                        edges: graph.edges,
                        text: formatCallGraphAsText(graph)
                    }
                };
            }
            return { success: false, error: `No call graph found for "${functionName}"` };
        }
    },
    
    list_symbols: {
        name: 'list_symbols',
        description: 'List all symbols in the code index, optionally filtered by type or file',
        parameters: { type: 'string?', file: 'string?' },
        execute: async (params) => {
            const { type, file } = params;
            const symbols = [];
            for (const [name, info] of codeIndex.symbols) {
                if (type && info.type !== type) continue;
                if (file && !info.file?.includes(file)) continue;
                symbols.push({ name, type: info.type, file: info.file?.split('/').pop(), line: info.line });
            }
            return { success: true, data: { symbols, count: symbols.length } };
        }
    },
    
    // === ANALYSIS TOOLS ===
    analyze_code_structure: {
        name: 'analyze_code_structure',
        description: 'Analyze the structure of code (functions, classes, imports)',
        parameters: { content: 'string', language: 'string?' },
        execute: async (params) => {
            const { content, language } = params;
            // Use regex patterns to extract structure
            const functions = [];
            const classes = [];
            const imports = [];
            
            // C/Java style functions
            const funcPattern = /(?:(?:public|private|protected|static|async|export)\s+)*(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*(?:\{|;)/g;
            let match;
            while ((match = funcPattern.exec(content)) !== null) {
                functions.push(match[1]);
            }
            
            // Classes/structs
            const classPattern = /(?:class|struct|interface|enum)\s+(\w+)/g;
            while ((match = classPattern.exec(content)) !== null) {
                classes.push(match[1]);
            }
            
            // Imports
            const importPattern = /(?:#include|import|from|require)\s*[<"']?([^>"'\s;]+)/g;
            while ((match = importPattern.exec(content)) !== null) {
                imports.push(match[1]);
            }
            
            return { 
                success: true, 
                data: { 
                    functions: [...new Set(functions)], 
                    classes: [...new Set(classes)], 
                    imports: [...new Set(imports)],
                    lines: content.split('\n').length
                }
            };
        }
    },
    
    // === TRANSFORMATION TOOLS ===
    translate_code: {
        name: 'translate_code',
        description: 'Translate code from one language to another using LLM. Handles large files by chunking.',
        parameters: { content: 'string', sourceLanguage: 'string', targetLanguage: 'string', fileName: 'string?' },
        execute: async (params) => {
            const { content, sourceLanguage, targetLanguage, fileName } = params;
            const lines = content.split('\n');
            const MAX_LINES_PER_CHUNK = 300;
            
            // For small files, translate directly
            if (lines.length <= MAX_LINES_PER_CHUNK) {
                const prompt = `Translate this ${sourceLanguage} code to ${targetLanguage}. 
${fileName ? `File: ${fileName}` : ''}

CRITICAL RULES:
1. Translate EVERY line - no placeholders, no "// TODO", no "// other methods"
2. Preserve ALL logic, ALL branches, ALL error handling
3. Use idiomatic ${targetLanguage} patterns
4. Keep comments (translate if needed)
5. The translation MUST be complete and compilable
6. DO NOT summarize or skip any code

SOURCE CODE:
\`\`\`${sourceLanguage}
${content}
\`\`\`

Output ONLY the translated ${targetLanguage} code (no explanation):`;

                const result = await callLanguageModel(prompt);
                // Extract code from markdown if present
                let translatedCode = result;
                const codeMatch = result.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
                if (codeMatch) {
                    translatedCode = codeMatch[1];
                }
                // Clean up lazy LLM patterns
                translatedCode = cleanupGeneratedCode(translatedCode);
                return { success: true, data: { translatedCode, targetLanguage, chunks: 1 } };
            }
            
            // For large files, chunk and translate
            log(`TRANSLATE: Large file (${lines.length} lines), chunking...`);
            const chunks = [];
            let currentChunk = [];
            let braceDepth = 0;
            
            // Smart chunking - try to break at function boundaries
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                currentChunk.push(line);
                
                // Track brace depth
                braceDepth += (line.match(/\{/g) || []).length;
                braceDepth -= (line.match(/\}/g) || []).length;
                
                // Break at function boundaries when possible
                if (currentChunk.length >= MAX_LINES_PER_CHUNK && braceDepth === 0) {
                    chunks.push(currentChunk.join('\n'));
                    currentChunk = [];
                }
                // Force break if chunk is too large
                else if (currentChunk.length >= MAX_LINES_PER_CHUNK * 1.5) {
                    chunks.push(currentChunk.join('\n'));
                    currentChunk = [];
                }
            }
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.join('\n'));
            }
            
            log(`TRANSLATE: Split into ${chunks.length} chunks`);
            
            // Translate each chunk
            const translatedChunks = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const isFirst = i === 0;
                const isLast = i === chunks.length - 1;
                
                const chunkPrompt = `Translate this ${sourceLanguage} code to ${targetLanguage}.
${fileName ? `File: ${fileName}` : ''} (Part ${i + 1}/${chunks.length})
${isFirst ? 'This is the BEGINNING of the file - include imports/headers.' : ''}
${isLast ? 'This is the END of the file - include closing braces.' : ''}

RULES:
- Translate EVERY line completely
- NO placeholders or TODO comments
- Preserve all logic and comments

SOURCE (Part ${i + 1}):
\`\`\`${sourceLanguage}
${chunk}
\`\`\`

Output ONLY the translated code for this part:`;

                const result = await callLanguageModel(chunkPrompt);
                let translatedChunk = result;
                const codeMatch = result.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
                if (codeMatch) {
                    translatedChunk = codeMatch[1];
                }
                // Clean up lazy LLM patterns
                translatedChunk = cleanupGeneratedCode(translatedChunk);
                translatedChunks.push(translatedChunk);
            }
            
            let fullTranslation = translatedChunks.join('\n\n');
            // Final cleanup of complete translation
            fullTranslation = cleanupGeneratedCode(fullTranslation);
            return { 
                success: true, 
                data: { 
                    translatedCode: fullTranslation, 
                    targetLanguage, 
                    chunks: chunks.length,
                    originalLines: lines.length
                }
            };
        }
    },
    
    translate_file: {
        name: 'translate_file',
        description: 'Translate a specific file from context to another language',
        parameters: { fileName: 'string', targetLanguage: 'string' },
        execute: async (params) => {
            const { fileName, targetLanguage } = params;
            
            // Find the file in context
            let targetFile = null;
            for (const [path, file] of contextFiles) {
                const name = path.split('/').pop();
                if (name === fileName || name.toLowerCase() === fileName.toLowerCase()) {
                    targetFile = { name, content: file.content, language: file.language };
                    break;
                }
            }
            
            if (!targetFile) {
                return { success: false, error: `File "${fileName}" not found in context` };
            }
            
            // Use the translate_code tool
            return await AGENT_TOOLS.translate_code.execute({
                content: targetFile.content,
                sourceLanguage: targetFile.language,
                targetLanguage: targetLanguage,
                fileName: targetFile.name
            });
        }
    },
    
    translate_all_files: {
        name: 'translate_all_files',
        description: 'Translate ALL attached files to a target language. Includes critique loop and compilation. Preserves all symbols, methods, variables, functions, and decimal precision.',
        parameters: { targetLanguage: 'string', outputStyle: 'string?', compile: 'boolean?' },
        execute: async (params) => {
            const { targetLanguage, outputStyle = 'separate', compile = true } = params;
            const MAX_CRITIQUE_ITERATIONS = 10;
            
            if (contextFiles.size === 0) {
                return { success: false, error: 'No files attached. Please attach source files to translate.' };
            }
            
            log(`TRANSLATE_ALL: Translating ${contextFiles.size} files to ${targetLanguage}`);
            
            // First pass: Extract all symbols from all files for context
            const allSymbols = new Map();
            const allFiles = [];
            
            for (const [path, file] of contextFiles) {
                const fileName = path.split('/').pop();
                allFiles.push({ path, fileName, content: file.content, language: file.language });
                
                // Extract symbols from this file
                const fileSymbols = extractSymbolsFromCode(file.content, file.language);
                for (const sym of fileSymbols) {
                    allSymbols.set(sym.name, { ...sym, sourceFile: fileName });
                }
            }
            
            log(`TRANSLATE_ALL: Found ${allSymbols.size} symbols across ${allFiles.length} files`);
            
            // Build symbol reference for translation consistency
            const symbolReference = Array.from(allSymbols.values())
                .slice(0, 100) // Limit to avoid huge prompts
                .map(s => `- ${s.name} (${s.type}) from ${s.sourceFile}`)
                .join('\n');
            
            // Translate each file with critique loop
            const translatedFiles = [];
            
            for (let i = 0; i < allFiles.length; i++) {
                const file = allFiles[i];
                const fileLines = file.content.split('\n').length;
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n*Translating file ${i + 1}/${allFiles.length}: ${file.fileName} (${fileLines} lines)...*\n`
                });
                
                // For large files, use chunked translation
                let translatedCode;
                if (fileLines > 500) {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `*Large file detected - using chunked translation...*\n`
                    });
                    translatedCode = await translateLargeFile(file, targetLanguage, symbolReference);
                } else {
                    translatedCode = await translateSingleFile(file, targetLanguage, symbolReference);
                }
                
                if (!translatedCode) {
                    translatedFiles.push({
                        originalFile: file.fileName,
                        error: 'Translation failed'
                    });
                    continue;
                }
                
                // Critique loop
                let iteration = 0;
                let critiqueResult = { passed: false, issues: [] };
                
                while (iteration < MAX_CRITIQUE_ITERATIONS) {
                    // Check for cancellation
                    if (taskController.isCancelled) {
                        log('Translation critique cancelled by user');
                        throw new Error('Task cancelled by user');
                    }
                    
                    iteration++;
                    
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `*Critique iteration ${iteration}/${MAX_CRITIQUE_ITERATIONS}...*\n`
                    });
                    
                    // Run critique
                    critiqueResult = await critiqueTranslation(
                        file.content, 
                        file.language,
                        translatedCode, 
                        targetLanguage,
                        file.fileName
                    );
                    
                    if (critiqueResult.passed) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: `✅ *Critique passed on iteration ${iteration}*\n`
                        });
                        break;
                    }
                    
                    // Show issues found
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `⚠️ *Found ${critiqueResult.issues.length} issues, fixing...*\n`
                    });
                    
                    // Fix the issues
                    translatedCode = await fixTranslationIssues(
                        file.content,
                        file.language,
                        translatedCode,
                        targetLanguage,
                        critiqueResult.issues
                    );
                    
                    if (!translatedCode) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: `❌ *Fix attempt failed, using previous version*\n`
                        });
                        break;
                    }
                }
                
                if (iteration >= MAX_CRITIQUE_ITERATIONS && !critiqueResult.passed) {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `⚠️ *Max iterations reached, some issues may remain*\n`
                    });
                }
                
                // Generate new filename
                const baseName = file.fileName.replace(/\.\w+$/, '');
                const newExtension = getFileExtension(targetLanguage);
                const newFileName = `${baseName}.${newExtension}`;
                
                translatedFiles.push({
                    originalFile: file.fileName,
                    newFileName,
                    translatedCode,
                    language: targetLanguage,
                    critiqueIterations: iteration,
                    critiquePassed: critiqueResult.passed
                });
            }
            
            // Compile if Java and compile flag is true
            let compilationResult = null;
            if (compile && targetLanguage.toLowerCase() === 'java') {
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n*Compiling Java files...*\n`
                });
                
                compilationResult = await compileJavaFiles(translatedFiles);
                
                if (compilationResult.success) {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `✅ *Compilation successful!*\n`
                    });
                } else {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `❌ *Compilation failed*\n`
                    });
                    
                    // Attempt to fix compilation errors (one more critique cycle)
                    if (compilationResult.errors && compilationResult.errors.length > 0) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: `*Attempting to fix ${compilationResult.errors.length} compilation errors...*\n`
                        });
                        
                        // Fix each file that has errors
                        for (const error of compilationResult.errors) {
                            const fileToFix = translatedFiles.find(f => 
                                f.newFileName === error.file || f.newFileName.endsWith(error.file)
                            );
                            
                            if (fileToFix) {
                                const originalFile = allFiles.find(f => f.fileName === fileToFix.originalFile);
                                if (originalFile) {
                                    const fixedCode = await fixCompilationError(
                                        originalFile.content,
                                        originalFile.language,
                                        fileToFix.translatedCode,
                                        targetLanguage,
                                        error
                                    );
                                    
                                    if (fixedCode) {
                                        fileToFix.translatedCode = fixedCode;
                                        fileToFix.compilationFixed = true;
                                    }
                                }
                            }
                        }
                        
                        // Try compiling again
                        compilationResult = await compileJavaFiles(translatedFiles);
                        if (compilationResult.success) {
                            chatWebviewView?.webview.postMessage({ 
                                type: 'appendResponse', 
                                text: `✅ *Compilation successful after fixes!*\n`
                            });
                        }
                    }
                }
            }
            
            // Format output based on style
            if (outputStyle === 'combined' || allFiles.length === 1) {
                // Single output with all files
                let combinedOutput = `// TRANSLATED PROJECT: ${targetLanguage}\n`;
                combinedOutput += `// Original files: ${allFiles.map(f => f.fileName).join(', ')}\n\n`;
                
                for (const tf of translatedFiles) {
                    if (tf.error) {
                        combinedOutput += `// ERROR translating ${tf.originalFile}: ${tf.error}\n\n`;
                    } else {
                        combinedOutput += `// ========== ${tf.newFileName} ==========\n`;
                        combinedOutput += tf.translatedCode;
                        combinedOutput += '\n\n';
                    }
                }
                
                return {
                    success: true,
                    data: {
                        translatedCode: combinedOutput,
                        targetLanguage,
                        fileCount: translatedFiles.length,
                        files: translatedFiles.map(f => f.newFileName || f.originalFile)
                    }
                };
            } else {
                // Separate files
                return {
                    success: true,
                    data: {
                        translatedFiles,
                        targetLanguage,
                        fileCount: translatedFiles.length,
                        summary: translatedFiles.map(f => 
                            f.error 
                                ? `❌ ${f.originalFile}: ${f.error}`
                                : `✅ ${f.originalFile} → ${f.newFileName}`
                        ).join('\n')
                    }
                };
            }
        }
    },
    
    trace_code: {
        name: 'trace_code',
        description: 'Trace a function, feature, or concept through the codebase',
        parameters: { target: 'string', traceType: 'string?' },
        execute: async (params) => {
            const { target, traceType = 'auto' } = params;
            
            // Determine if target is a function name or concept
            const isFunction = codeIndex.symbols.has(target) || /^[a-zA-Z_]\w+$/.test(target);
            
            let traceInfo = '';
            
            if (isFunction && codeIndex.symbols.has(target)) {
                // Function trace
                const symbol = codeIndex.symbols.get(target);
                const calls = codeIndex.callGraph.get(target);
                const callers = codeIndex.reverseCallGraph.get(target);
                
                traceInfo = `## Function: ${target}\n`;
                traceInfo += `- Type: ${symbol.type}\n`;
                traceInfo += `- File: ${symbol.file?.split('/').pop()}:${symbol.line}\n`;
                if (symbol.signature) traceInfo += `- Signature: ${symbol.signature}\n`;
                
                if (callers && callers.size > 0) {
                    traceInfo += `\n### Called by (${callers.size}):\n`;
                    for (const caller of [...callers].slice(0, 10)) {
                        traceInfo += `- ${caller}\n`;
                    }
                }
                
                if (calls && calls.size > 0) {
                    traceInfo += `\n### Calls (${calls.size}):\n`;
                    for (const callee of [...calls].slice(0, 10)) {
                        traceInfo += `- ${callee}\n`;
                    }
                }
                
                // Get call graph
                const graph = buildCallGraphFromSymbol(target, 3);
                traceInfo += `\n### Call Graph:\n${formatCallGraphAsText(graph)}\n`;
                
            } else {
                // Concept trace - grep for keywords
                const keywords = target.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                const matches = [];
                
                for (const [path, file] of contextFiles) {
                    const fileName = path.split('/').pop();
                    const lines = file.content.split('\n');
                    
                    lines.forEach((line, idx) => {
                        const lineLower = line.toLowerCase();
                        const matchingKeywords = keywords.filter(k => lineLower.includes(k));
                        if (matchingKeywords.length > 0) {
                            matches.push({
                                file: fileName,
                                line: idx + 1,
                                code: line.trim().substring(0, 100),
                                keywords: matchingKeywords
                            });
                        }
                    });
                }
                
                // Sort by number of matching keywords
                matches.sort((a, b) => b.keywords.length - a.keywords.length);
                
                traceInfo = `## Concept Trace: "${target}"\n`;
                traceInfo += `Found ${matches.length} relevant lines\n\n`;
                
                // Group by file
                const byFile = {};
                for (const m of matches.slice(0, 50)) {
                    if (!byFile[m.file]) byFile[m.file] = [];
                    byFile[m.file].push(m);
                }
                
                for (const [file, fileMatches] of Object.entries(byFile)) {
                    traceInfo += `### ${file}\n`;
                    for (const m of fileMatches.slice(0, 10)) {
                        traceInfo += `- Line ${m.line}: ${m.code}\n`;
                    }
                    traceInfo += '\n';
                }
            }
            
            // Use LLM to analyze the trace
            const analysisPrompt = `Analyze this code trace and explain the flow:

${traceInfo}

Provide:
1. What is "${target}"?
2. Entry points
3. Call flow (top to bottom)
4. Key data structures
5. How it works step by step`;

            const analysis = await callLanguageModel(analysisPrompt);
            
            return { 
                success: true, 
                data: { 
                    trace: traceInfo, 
                    analysis,
                    target,
                    isFunction 
                }
            };
        }
    },
    
    review_code: {
        name: 'review_code',
        description: 'Review code for bugs, issues, and improvements',
        parameters: { content: 'string', focus: 'string?' },
        execute: async (params) => {
            const { content, focus = 'general' } = params;
            
            const prompt = `Review this code for ${focus === 'general' ? 'bugs, issues, and improvements' : focus}:

\`\`\`
${content.substring(0, 15000)}
\`\`\`

Provide a structured code review:

## Summary
Brief overview of the code quality

## Issues Found
List specific issues with line numbers if possible:
- 🔴 Critical: [issue]
- 🟡 Warning: [issue]
- 🔵 Info: [suggestion]

## Recommendations
Specific improvements to make

## Good Practices
What the code does well`;

            const review = await callLanguageModel(prompt);
            return { success: true, data: { review, focus } };
        }
    },
    
    review_file: {
        name: 'review_file',
        description: 'Review a specific file for bugs, issues, and improvements. Takes a filename and automatically loads the content.',
        parameters: { fileName: 'string', focus: 'string?' },
        execute: async (params) => {
            const { fileName, focus = 'bugs' } = params;
            
            log('review_file: Reviewing file:', fileName, 'focus:', focus);
            
            // Find the file in context
            let targetFile = null;
            let targetPath = null;
            
            for (const [path, file] of contextFiles) {
                const pathFileName = path.split('/').pop();
                if (pathFileName === fileName || pathFileName.toLowerCase() === fileName.toLowerCase() || path.endsWith(fileName)) {
                    targetFile = file;
                    targetPath = path;
                    break;
                }
            }
            
            if (!targetFile) {
                return { success: false, error: `File "${fileName}" not found in context. Available files: ${Array.from(contextFiles.keys()).map(p => p.split('/').pop()).slice(0, 20).join(', ')}` };
            }
            
            log('review_file: Found file:', targetPath);
            
            // Get symbols from this file for context
            const fileSymbols = [];
            for (const [key, sym] of codeIndex.symbols) {
                if (sym.file === targetPath) {
                    fileSymbols.push(`${sym.type}: ${sym.name} (line ${sym.line})`);
                }
            }
            
            const focusPrompt = focus === 'bugs' 
                ? 'potential bugs, logic errors, edge cases, memory issues, race conditions, and security vulnerabilities'
                : focus === 'security' 
                ? 'security vulnerabilities, injection risks, authentication issues, and data exposure'
                : focus === 'performance'
                ? 'performance issues, inefficient algorithms, unnecessary allocations, and optimization opportunities'
                : 'bugs, issues, and improvements';
            
            const prompt = `Review this file for ${focusPrompt}:

**File:** ${targetPath}
**Language:** ${targetFile.language || 'unknown'}
**Symbols in file:** ${fileSymbols.slice(0, 30).join(', ')}

\`\`\`${targetFile.language || ''}
${targetFile.content.substring(0, 20000)}
\`\`\`

CRITICAL: Find REAL, SPECIFIC bugs - not vague "could be" issues. Look for:
- NULL pointer dereferences without checks
- Buffer overflows / out-of-bounds access
- Memory leaks (allocated but not freed)
- Use-after-free patterns
- Integer overflow/underflow
- Missing error checking after function calls
- Race conditions / thread safety issues
- Logic errors (wrong operators, off-by-one, etc.)
- Uninitialized variables
- Resource leaks (file handles, locks, etc.)

For EACH issue found, you MUST provide:
1. The EXACT line number
2. The SPECIFIC code snippet that's buggy
3. WHY it's a bug (what could go wrong)
4. HOW to fix it (concrete code change)

## 📄 File Overview
Brief description of what this file does

## 🔴 Critical Issues (HIGH SEVERITY)
Bugs that could cause crashes, data corruption, or security vulnerabilities.
Format each as:
**Line [X]:** \`problematic code snippet\`
- **Bug:** [What's wrong]
- **Impact:** [What could happen]
- **Fix:** [Specific code change]

## 🟡 Potential Issues (MEDIUM SEVERITY)
Logic errors, edge cases, or risky patterns.
(Same format as above)

## 🔵 Code Quality (LOW SEVERITY)
Style issues, maintainability concerns, missing error handling.
(Same format as above)

## ✅ Summary
- Total issues found: X critical, Y medium, Z low
- Most important fix: [Brief description]

If you find NO bugs, explain what defensive patterns the code uses that prevent common bugs.`;

            const review = await callLanguageModel(prompt);
            return { success: true, data: { review, fileName: targetPath, focus } };
        }
    },
    
    explain_code: {
        name: 'explain_code',
        description: 'Explain what a piece of code does',
        parameters: { content: 'string', detail: 'string?' },
        execute: async (params) => {
            const { content, detail = 'medium' } = params;
            const detailLevel = detail === 'brief' ? 'briefly' : detail === 'detailed' ? 'in detail' : 'concisely';
            
            const prompt = `Explain ${detailLevel} what this code does:

\`\`\`
${content.substring(0, 10000)}
\`\`\`

Explain the purpose, key functions, and how it works.`;

            const result = await callLanguageModel(prompt);
            return { success: true, data: { explanation: result } };
        }
    },
    
    document_code: {
        name: 'document_code',
        description: 'Generate documentation for code',
        parameters: { content: 'string', format: 'string?' },
        execute: async (params) => {
            const { content, format = 'markdown' } = params;
            
            const prompt = `Generate ${format} documentation for this code:

\`\`\`
${content.substring(0, 12000)}
\`\`\`

Include:
1. Overview
2. Functions/methods with parameters and return types
3. Usage examples
4. Dependencies`;

            const result = await callLanguageModel(prompt);
            return { success: true, data: { documentation: result } };
        }
    },
    
    generate_full_documentation: {
        name: 'generate_full_documentation',
        description: 'Generate comprehensive DeepWiki-style documentation for all files in context',
        parameters: { style: 'string?' },
        execute: async (params) => {
            const { style = 'deepwiki' } = params;
            
            if (contextFiles.size === 0) {
                return { success: false, error: 'No files in context to document' };
            }
            
            const fileList = [];
            for (const [path, file] of contextFiles) {
                fileList.push({ 
                    name: path.split('/').pop(), 
                    path, 
                    language: file.language, 
                    size: file.content.length 
                });
            }
            
            try {
                const documentation = await generateDocumentationFile(fileList, `Generate ${style} documentation`);
                return { success: true, data: { documentation, style, fileCount: fileList.length } };
            } catch (error) {
                return { success: false, error: error.message };
            }
        }
    },
    
    search_api_server: {
        name: 'search_api_server',
        description: 'Search the API server codebase when no local context is available',
        parameters: { query: 'string' },
        execute: async (params) => {
            const { query } = params;
            const config = vscode.workspace.getConfiguration('astra');
            const apiUrl = config.get('apiUrl') || 'http://localhost:8080';
            
            try {
                const searchTerms = query.replace(/[^\w\s]/g, ' ').trim();
                const response = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(searchTerms)}&limit=10`);
                
                if (!response.ok) {
                    return { success: false, error: `API returned ${response.status}` };
                }
                
                const results = await response.json();
                
                if (!results || results.length === 0) {
                    return { success: true, data: { results: [], message: 'No results found' } };
                }
                
                // Build context from results
                let context = '';
                for (const r of results.slice(0, 5)) {
                    context += `=== ${r.procedure_name || r.file_path} ===\n`;
                    context += (r.content_preview || r.content || '').substring(0, 2000);
                    context += '\n\n';
                }
                
                return { success: true, data: { results, context, count: results.length } };
            } catch (error) {
                return { success: false, error: `API server error: ${error.message}` };
            }
        }
    },
    
    // === CODE GENERATION TOOLS ===
    generate_code: {
        name: 'generate_code',
        description: 'Generate new code based on requirements and save to file',
        parameters: { requirements: 'string', language: 'string', fileName: 'string?' },
        execute: async (params) => {
            const { requirements, language, fileName } = params;
            
            const prompt = `Generate ${language} code based on these requirements:

${requirements}

RULES:
1. Write complete, production-ready code
2. Include proper error handling
3. Add comments explaining key sections
4. Follow ${language} best practices and conventions
5. Make the code modular and maintainable

Output ONLY the code (no explanations):`;

            const generatedCode = await callLanguageModel(prompt);
            
            // Extract code from markdown if present
            let cleanCode = generatedCode;
            const codeMatch = generatedCode.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
            if (codeMatch) {
                cleanCode = codeMatch[1];
            }
            // Clean up lazy LLM patterns
            cleanCode = cleanupGeneratedCode(cleanCode);
            
            // Generate a file name if not provided
            const finalFileName = fileName || `generated_${Date.now()}`;
            
            return { 
                success: true, 
                data: { 
                    generatedCode: cleanCode, 
                    language,
                    fileName: finalFileName,
                    shouldSave: true
                }
            };
        }
    },
    
    create_from_example: {
        name: 'create_from_example',
        description: 'Create new code based on an example/template from context',
        parameters: { exampleFile: 'string', modifications: 'string', newFileName: 'string', targetLanguage: 'string?' },
        execute: async (params) => {
            const { exampleFile, modifications, newFileName, targetLanguage } = params;
            
            // Find the example file in context
            let exampleContent = null;
            let exampleLang = null;
            
            for (const [path, file] of contextFiles) {
                const name = path.split('/').pop();
                if (name === exampleFile || name.toLowerCase() === exampleFile.toLowerCase()) {
                    exampleContent = file.content;
                    exampleLang = file.language;
                    break;
                }
            }
            
            if (!exampleContent) {
                return { success: false, error: `Example file "${exampleFile}" not found in context` };
            }
            
            const lang = targetLanguage || exampleLang;
            
            const prompt = `Based on this example code:

\`\`\`${exampleLang}
${exampleContent.substring(0, 10000)}
\`\`\`

Create a new ${lang} file with these modifications:
${modifications}

Output ONLY the new code:`;

            const generatedCode = await callLanguageModel(prompt);
            
            let cleanCode = generatedCode;
            const codeMatch = generatedCode.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
            if (codeMatch) {
                cleanCode = codeMatch[1];
            }
            // Clean up lazy LLM patterns
            cleanCode = cleanupGeneratedCode(cleanCode);
            
            return { 
                success: true, 
                data: { 
                    generatedCode: cleanCode, 
                    language: lang,
                    fileName: newFileName,
                    basedOn: exampleFile,
                    shouldSave: true
                }
            };
        }
    },
    
    // === ANSWER TOOLS ===
    answer_question: {
        name: 'answer_question',
        description: 'Answer a question using ONLY the provided code context. Handles large contexts by chunking and summarizing.',
        parameters: { question: 'string', context: 'string?', domain: 'string?', domain_notes: 'string?', requireCodeCitations: 'boolean?', useProvidedContext: 'boolean?' },
        execute: async (params) => {
            const { question, context, domain, domain_notes, requireCodeCitations = true, useProvidedContext = false } = params;
            
            log('answer_question: Received params');
            log('answer_question: question length:', question?.length || 0);
            log('answer_question: context length:', context?.length || 0);
            log('answer_question: domain:', domain || 'none');
            log('answer_question: useProvidedContext:', useProvidedContext);
            
            // === STEP 1: Decompose compound questions ===
            const subQuestions = decomposeQuestion(question);
            log('answer_question: Decomposed into', subQuestions.length, 'sub-questions:', subQuestions);
            
            // Check if we have meaningful context
            const hasContext = context && context.length > 100;
            
            if (!hasContext && requireCodeCitations) {
                log('answer_question: WARNING - No meaningful context provided');
                return { 
                    success: true, 
                    data: { 
                        answer: `**No relevant code found in the attached files.**\n\nI searched but couldn't find code related to "${question.substring(0, 100)}..."\n\nPlease try:\n1. Attaching more relevant source files\n2. Using a different search pattern\n3. Checking the Output panel (View → Output → AstraCode) for search details`
                    } 
                };
            }
            
            // Size limit for single LLM call (leave room for instructions)
            const CHUNK_SIZE = 18000;
            
            // If context fits in one chunk, process directly
            if (!context || context.length <= CHUNK_SIZE) {
                log('answer_question: Context fits in single chunk');
                return await processAnswerDirect(question, context, domain, domain_notes);
            }
            
            // ================================================================
            // LARGE CONTEXT HANDLING
            // Check if context was provided by a previous step (e.g., search_code)
            // If so, USE IT instead of re-searching from scratch!
            // ================================================================
            log('answer_question: Large context - processing provided context');
            log('answer_question: Context size:', context.length, 'chars');
            
            // Check if this looks like pre-searched context from search_code
            // (contains structured search results with symbols, code blocks, etc.)
            const looksLikeSearchResults = context.includes('### ') && 
                (context.includes('function') || context.includes('(') || context.includes('{'));
            
            if (useProvidedContext || looksLikeSearchResults) {
                // ================================================================
                // USE THE PROVIDED CONTEXT - Don't re-search!
                // This preserves the excellent results from search_code
                // ================================================================
                log('answer_question: Using provided context (from previous step)');
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `*Processing ${Math.ceil(context.length / 1000)}KB of search results...*\n\n`
                });
                
                // Smart chunking: prioritize content with more code/symbols
                const chunks = chunkContext(context, CHUNK_SIZE);
                log('answer_question: Split provided context into', chunks.length, 'chunks');
                
                // Score chunks by relevance to the question
                const scoredChunks = [];
                const keywords = extractSearchKeywords(question + ' ' + subQuestions.join(' '));
                
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    let score = 0;
                    const chunkLower = chunk.toLowerCase();
                    
                    // Score by keyword presence
                    for (const keyword of keywords) {
                        const regex = new RegExp(keyword.toLowerCase(), 'gi');
                        const matches = chunkLower.match(regex);
                        if (matches) {
                            score += matches.length * 2;
                        }
                    }
                    
                    // Bonus for code content (functions, structs, etc.)
                    if (chunk.includes('function') || chunk.includes('void ') || chunk.includes('int ')) score += 10;
                    if (chunk.includes('```')) score += 5; // Code blocks
                    if (chunk.match(/:\d+/)) score += 5; // Line numbers like file.c:123
                    
                    scoredChunks.push({ chunk, score, index: i });
                }
                
                // Sort by score and take top chunks
                scoredChunks.sort((a, b) => b.score - a.score);
                const topChunks = scoredChunks.slice(0, Math.min(5, scoredChunks.length));
                
                log('answer_question: Top chunk scores:', topChunks.map(c => c.score).join(', '));
                
                // Combine top chunks for analysis
                const selectedContext = topChunks
                    .sort((a, b) => a.index - b.index) // Restore original order
                    .map(c => c.chunk)
                    .join('\n\n---\n\n');
                
                // Use synthesizeFindingsWithReferences for structured output
                const result = await synthesizeFindingsWithReferences(
                    question,
                    selectedContext,
                    domain,
                    domain_notes,
                    subQuestions,
                    [], // filesAnalyzed - extract from context if needed
                    [],
                    []
                );
                
                if (result.success && result.data?.answer) {
                    return { success: true, data: { answer: result.data.answer } };
                }
                
                // Fallback to direct processing
                return await processAnswerDirect(question, selectedContext, domain, domain_notes);
            }
            
            // ================================================================
            // NO PROVIDED CONTEXT - Use comprehensive search
            // This path is for when answer_question is called directly without
            // a previous search step (e.g., simple questions with $context)
            // ================================================================
            log('answer_question: No pre-searched context - using comprehensiveSearch');
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `*Large codebase (${Math.ceil(context.length / 1000)}KB) - searching for relevant code...*\n\n`
            });
            
            // Use handleDetailedQuery's approach - it has filename matching!
            try {
                const result = await handleDetailedQuery(question);
                // handleDetailedQuery returns a string, wrap it in proper format
                return { success: true, data: { answer: result } };
            } catch (err) {
                log('answer_question: comprehensiveSearch failed, falling back to chunk scoring:', err.message);
            }
            
            // FALLBACK: Original chunk scoring (if comprehensiveSearch fails)
            log('answer_question: Falling back to keyword-based chunk scoring');
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `*Fallback: scoring chunks by keywords...*\n\n`
            });
            
            // Step 1: Chunk the context
            const chunks = chunkContext(context, CHUNK_SIZE);
            log('answer_question: Split into', chunks.length, 'chunks');
            
            // Step 2: Score each chunk for relevance (quick LLM call)
            const scoredChunks = [];
            const keywords = extractSearchKeywords(question + ' ' + subQuestions.join(' '));
            
            // VERBOSE: Show extracted keywords
            if (AGENT_CONFIG.verboseSearch) {
                const keywordInfo = `\n**🔍 Search Debug - Keywords Extracted:**\n\`${keywords.slice(0, 15).join('`, `')}\`\n`;
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: keywordInfo
                });
                log('VERBOSE: Keywords:', keywords.slice(0, 15));
            }
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `*Scoring ${chunks.length} chunks against query...*\n`
            });
            
            // VERBOSE: Track keyword hit details
            const keywordHits = new Map(); // keyword -> [{chunk, count}]
            const fileHits = new Map();    // file -> [{chunk, context}]
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                
                // Quick relevance score based on keyword density + structure
                let score = 0;
                const chunkLower = chunk.toLowerCase();
                const chunkKeywordHits = [];
                
                // Keyword matches (weighted)
                for (const kw of keywords.slice(0, 10)) {
                    const kwLower = kw.toLowerCase();
                    const matches = (chunkLower.match(new RegExp(kwLower, 'g')) || []).length;
                    const kwScore = matches * (kw.length > 5 ? 2 : 1); // Longer keywords worth more
                    score += kwScore;
                    
                    // VERBOSE: Track keyword hits
                    if (AGENT_CONFIG.verboseSearch && matches > 0) {
                        chunkKeywordHits.push({ keyword: kw, matches, score: kwScore });
                        if (!keywordHits.has(kw)) keywordHits.set(kw, []);
                        keywordHits.get(kw).push({ chunk: i, count: matches });
                    }
                }
                
                // Bonus for containing file matches (filenames in section headers)
                const fileMatches = chunk.match(/###\s+[\w]+\.(c|h|cpp|py|js|java)/g) || [];
                score += fileMatches.length * 5;
                
                // Bonus for function definitions
                const funcMatches = chunk.match(/function\s+\w+|def\s+\w+|\w+\s*\([^)]*\)\s*{/g) || [];
                score += funcMatches.length * 2;
                
                // Extract file names from chunk for reference
                const filesInChunk = [...new Set((chunk.match(/[\w-]+\.(c|h|cpp|py|js|java)/g) || []))];
                
                // VERBOSE: Track file hits
                if (AGENT_CONFIG.verboseSearch) {
                    for (const file of filesInChunk) {
                        if (!fileHits.has(file)) fileHits.set(file, []);
                        // Get some context around the file mention
                        const fileIdx = chunkLower.indexOf(file.toLowerCase());
                        const context = fileIdx >= 0 ? chunk.substring(Math.max(0, fileIdx - 20), fileIdx + file.length + 50).replace(/\n/g, ' ').trim() : '';
                        fileHits.get(file).push({ chunk: i, context: context.substring(0, 80) });
                    }
                }
                
                scoredChunks.push({
                    index: i,
                    chunk,
                    score,
                    filesInChunk,
                    keywordHits: chunkKeywordHits,
                    preview: chunk.substring(0, 100).replace(/\n/g, ' ')
                });
            }
            
            // Sort by score descending
            scoredChunks.sort((a, b) => b.score - a.score);
            
            // VERBOSE: Output detailed search hits
            if (AGENT_CONFIG.verboseSearch) {
                let verboseOutput = '\n**📊 Search Hit Summary:**\n';
                
                // Files found
                verboseOutput += `\n| File | Chunks Found | Sample Context |\n`;
                verboseOutput += `|:-----|:-------------|:---------------|\n`;
                const sortedFiles = [...fileHits.entries()].sort((a, b) => b[1].length - a[1].length);
                for (const [file, hits] of sortedFiles.slice(0, 15)) {
                    const chunkNums = hits.map(h => h.chunk).join(', ');
                    const sampleCtx = hits[0]?.context || '-';
                    verboseOutput += `| \`${file}\` | chunks: ${chunkNums} | ${sampleCtx.substring(0, 40)}... |\n`;
                }
                
                // Keyword coverage
                verboseOutput += `\n**Keyword Coverage:**\n`;
                for (const [kw, hits] of keywordHits) {
                    const totalHits = hits.reduce((sum, h) => sum + h.count, 0);
                    verboseOutput += `- \`${kw}\`: ${totalHits} hits across ${hits.length} chunks\n`;
                }
                
                // Top scored chunks
                verboseOutput += `\n**Top Scored Chunks:**\n`;
                for (const sc of scoredChunks.slice(0, 8)) {
                    const kwBreakdown = sc.keywordHits?.slice(0, 3).map(k => `${k.keyword}:${k.matches}`).join(', ') || 'n/a';
                    verboseOutput += `- Chunk ${sc.index}: score=${sc.score}, files=[${sc.filesInChunk.slice(0, 3).join(', ')}], keywords={${kwBreakdown}}\n`;
                }
                
                verboseOutput += '\n---\n\n';
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: verboseOutput
                });
                
                log('VERBOSE: File hits:', [...fileHits.keys()]);
                log('VERBOSE: Keyword hits:', Object.fromEntries(keywordHits));
            }
            
            // Log scoring results
            log('answer_question: Chunk scores:');
            for (const sc of scoredChunks.slice(0, 5)) {
                log(`  Chunk ${sc.index}: score=${sc.score}, files=${sc.filesInChunk.slice(0, 3).join(', ')}`);
            }
            
            // Step 3: Process top-scoring chunks (up to 5)
            const MAX_CHUNKS_TO_PROCESS = 5;
            const MIN_SCORE_THRESHOLD = 3; // Skip chunks with very low scores
            
            const chunksToProcess = scoredChunks
                .filter(sc => sc.score >= MIN_SCORE_THRESHOLD)
                .slice(0, MAX_CHUNKS_TO_PROCESS);
            
            if (chunksToProcess.length === 0) {
                // Fall back to top 2 chunks even if low score
                chunksToProcess.push(...scoredChunks.slice(0, 2));
            }
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `*Processing ${chunksToProcess.length} most relevant chunks (scores: ${chunksToProcess.map(c => c.score).join(', ')})...*\n\n`
            });
            
            // Collect findings from each chunk
            const findings = [];
            const allFilesFound = new Set();
            const allFunctionsFound = new Set();
            
            for (let i = 0; i < chunksToProcess.length; i++) {
                const { chunk, score, filesInChunk, index } = chunksToProcess[i];
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n*Analyzing chunk ${i + 1}/${chunksToProcess.length} (score: ${score})...*\n`
                });
                
                // Track files for references
                filesInChunk.forEach(f => allFilesFound.add(f));
                
                const chunkPrompt = `# CODE CONTEXT (Relevance Score: ${score}/100)

${chunk}

# QUESTION
${question}

# SUB-QUESTIONS
${subQuestions.map((sq, idx) => `${idx + 1}. ${sq}`).join('\n')}

# TASK
Extract SPECIFIC findings that help answer the question. For each finding:
1. State the finding clearly
2. Include exact file:line references
3. Note the function/struct names involved
4. Explain WHY this is relevant to the question

Format as:
### Finding: [Title]
- **Location:** \`filename.c:line\`
- **Key Code:** \`function_name()\` or \`StructName\`
- **Relevance:** [How this answers the question]
- **Details:** [Specific implementation details]`;

                try {
                    const chunkFindings = await callLanguageModel(chunkPrompt);
                    findings.push({
                        chunkIndex: index,
                        score,
                        content: chunkFindings,
                        files: filesInChunk
                    });
                    
                    // Extract function names mentioned
                    const funcNames = chunkFindings.match(/`(\w+)\(\)`/g) || [];
                    funcNames.forEach(f => allFunctionsFound.add(f.replace(/`|\(\)/g, '')));
                    
                } catch (err) {
                    log('answer_question: Chunk', index, 'error:', err.message);
                }
            }
            
            // Step 4: Collect files NOT processed (for "Related Topics" section)
            const unprocessedChunks = scoredChunks
                .filter(sc => !chunksToProcess.find(c => c.index === sc.index))
                .slice(0, 10);
            
            const relatedFiles = new Set();
            for (const sc of unprocessedChunks) {
                sc.filesInChunk.forEach(f => {
                    if (!allFilesFound.has(f)) {
                        relatedFiles.add(f);
                    }
                });
            }
            
            // Step 5: Synthesize with structured format
            const synthesisContext = findings.map(f => f.content).join('\n\n---\n\n');
            
            const result = await synthesizeFindingsWithReferences(
                question, 
                synthesisContext, 
                domain, 
                domain_notes, 
                subQuestions,
                Array.from(allFilesFound),
                Array.from(relatedFiles),
                Array.from(allFunctionsFound)
            );
            
            return result;
        }
    }
};

// Agent configuration
const AGENT_CONFIG = {
    enableJudge: true,  // Enable judge LLM to validate answers
    verboseSearch: true, // Log detailed search hits for debugging
    // Code extraction settings (configurable)
    maxSymbolsInContext: 30,  // Max symbols to include in search context
    codeSnippetLines: 25,     // Lines of code per symbol snippet
    maxChunks: 8,             // Max chunks for analysis
    maxBatchSize: 3,          // Batch size for hierarchical merge
    maxCombinedSize: 15000,   // Trigger hierarchical merge above this size
    maxAnalysisLength: 10000  // Max length for chunk analysis
};

/**
 * Clean up generated code - remove lazy LLM output patterns
 */
function cleanupGeneratedCode(code) {
    if (!code) return code;
    
    // Only remove lazy LLM placeholder patterns - NOT legitimate code fences
    const removePatterns = [
        // C-style placeholders
        /```\w*\s*\.\.\.+\s*```/g,               // ```java ... ``` (all on one line)
        /^\s*\.\.\.+\s*$/gm,                      // Just "..." on a line  
        /\/\/\s*\.\.\.+\s*$/gm,                   // // ...
        /\/\/\s*rest of (the )?(implementation|code|method|function).*$/gim,
        /\/\/\s*remaining (implementation|code|logic).*$/gim,
        /\/\/\s*etc\.?\s*$/gim,
        /\/\/\s*and so on.*$/gim,
        /\/\/\s*continue (with )?(the )?(implementation|code).*$/gim,
        /\/\/\s*similar (to|as) (above|before).*$/gim,
        /\/\/\s*same (as|pattern).*$/gim,
        /\/\*\s*\.\.\.+\s*\*\//g,                 // /* ... */
        /\/\/\s*other methods.*$/gim,
        /\/\/\s*more methods.*$/gim,
        /\/\/\s*additional methods.*$/gim,
        
        // COBOL-style placeholders (column 7 * or *> inline)
        /^\s{6}\*\s*\.\.\.+.*$/gm,                // COBOL: *  ...
        /\*>\s*\.\.\.+.*$/gm,                     // COBOL: *> ...
        /\*>\s*rest of (the )?(implementation|code|paragraph).*$/gim,
        /\*>\s*remaining (implementation|code|logic).*$/gim,
        /\*>\s*TODO.*$/gim,
        /\*>\s*etc\.?\s*$/gim,
        /\*>\s*continue.*$/gim,
    ];
    
    let cleaned = code;
    for (const pattern of removePatterns) {
        cleaned = cleaned.replace(pattern, '');
    }
    
    // Remove excessive empty lines (but keep single empty lines)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    
    return cleaned.trim();
}

/**
 * Translate a single file
 */
async function translateSingleFile(file, targetLanguage, symbolReference) {
    const prompt = `# TRANSLATE: ${file.fileName} (${file.language} → ${targetLanguage})

## ABSOLUTE REQUIREMENTS - VIOLATION IS FAILURE

### FORBIDDEN PATTERNS - DO NOT USE ANY OF THESE:
❌ "// Implementation details"
❌ "// TODO"
❌ "// Placeholder"
❌ "// Add implementation"
❌ "// Logic to..."
❌ "// ... implementation"
❌ "return null; // Placeholder"
❌ "return new X(); // Placeholder"
❌ "throw new UnsupportedOperationException()"
❌ Empty method bodies
❌ Comments describing what code SHOULD do instead of actual code
❌ Any comment containing "implement", "placeholder", "TODO", "details"

### REQUIRED:
✅ Translate EVERY line of code - no exceptions
✅ Translate EVERY function body completely with actual logic
✅ Translate EVERY struct/class with all fields and methods
✅ Preserve ALL numeric precision (3.14159265359 stays exactly that)
✅ Preserve ALL variable and function names
✅ If the source has 100 lines of logic, output must have ~100 lines of equivalent logic

### HOW TO HANDLE C CONSTRUCTS:
- C structs → Java classes with public fields or getters/setters
- C pointers → Java references (remove * and &)
- C arrays with size → Java arrays or ArrayList
- C malloc/free → Java new (no manual memory management)
- C macros (#define) → Java static final constants
- C function pointers → Java interfaces or lambdas
- C void* → Java Object or generics
- C sizeof → appropriate Java equivalent
- C unions → Java class with all fields

## PROJECT CONTEXT
Other symbols in the project:
${symbolReference || 'No other symbols found'}

## SOURCE CODE (${file.language})
\`\`\`${file.language}
${file.content}
\`\`\`

## OUTPUT REQUIREMENTS
1. Output ONLY complete, compilable ${targetLanguage} code
2. Every method must have a FULL implementation - not a placeholder
3. If you cannot translate something, translate it as best you can - DO NOT use placeholders
4. The output should be roughly the same length as the input (a 3000 line C file → ~3000 line Java file)

Provide the complete translated code now:`;

    try {
        const result = await callLanguageModelForCoding(prompt);
        
        // Extract code from markdown if present
        let translatedCode = result;
        const codeMatch = result.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
        if (codeMatch) {
            translatedCode = codeMatch[1];
        }
        
        // Clean up lazy LLM patterns
        translatedCode = cleanupGeneratedCode(translatedCode);
        
        return translatedCode;
    } catch (err) {
        log(`translateSingleFile: Error:`, err.message);
        return null;
    }
}

/**
 * Translate a large file by chunking it into sections
 * This handles files that are too large for a single LLM call
 */
async function translateLargeFile(file, targetLanguage, symbolReference) {
    const lines = file.content.split('\n');
    const totalLines = lines.length;
    const CHUNK_SIZE = 400; // Lines per chunk
    
    log(`translateLargeFile: Processing ${totalLines} lines in chunks of ${CHUNK_SIZE}`);
    taskController.start(`Translating ${file.fileName} (${totalLines} lines)`);
    
    // First, extract all type definitions, structs, enums, and function declarations
    // These will be included in every chunk for context
    const headerInfo = extractHeaderInfo(file.content, file.language);
    
    // Split into chunks at function boundaries
    const chunks = splitIntoFunctionChunks(file.content, file.language, CHUNK_SIZE);
    
    log(`translateLargeFile: Split into ${chunks.length} chunks`);
    
    const translatedChunks = [];
    let previousTranslations = ''; // Context from previous chunks
    
    for (let i = 0; i < chunks.length; i++) {
        // Check for cancellation
        if (taskController.isCancelled) {
            log('Translation cancelled by user');
            throw new Error('Translation cancelled by user');
        }
        
        const chunk = chunks[i];
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*Translating chunk ${i + 1}/${chunks.length} (lines ${chunk.startLine}-${chunk.endLine})...*\n`
        });
        
        const prompt = `# TRANSLATE CHUNK ${i + 1}/${chunks.length}: ${file.fileName}

## FILE CONTEXT
This is part ${i + 1} of ${chunks.length} of a ${totalLines}-line ${file.language} file being translated to ${targetLanguage}.

### Type Definitions & Declarations (for reference):
\`\`\`${file.language}
${headerInfo.substring(0, 3000)}
\`\`\`

${i > 0 ? `### Previous Chunk Translations (for continuity):
\`\`\`${targetLanguage}
${previousTranslations.substring(-4000)}
\`\`\`` : ''}

## CHUNK TO TRANSLATE (lines ${chunk.startLine}-${chunk.endLine}):
\`\`\`${file.language}
${chunk.content}
\`\`\`

## ABSOLUTE REQUIREMENTS:
❌ NO "// Implementation details"
❌ NO "// TODO" or "// Placeholder"
❌ NO empty method bodies
❌ NO "return null; // Placeholder"
✅ Translate EVERY line of actual code
✅ Translate EVERY function body completely
✅ Preserve ALL numeric precision
✅ Output should be ~${chunk.content.split('\n').length} lines

## PROJECT SYMBOLS:
${symbolReference || 'None'}

Output ONLY the translated ${targetLanguage} code for this chunk:`;

        try {
            const result = await callLanguageModelForCoding(prompt);
            
            let translatedChunk = result;
            const codeMatch = result.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
            if (codeMatch) {
                translatedChunk = codeMatch[1];
            }
            
            // Quick check for placeholders in this chunk
            if (/\/\/\s*(Implementation|TODO|Placeholder)/gi.test(translatedChunk)) {
                log(`translateLargeFile: Chunk ${i + 1} has placeholders, retrying...`);
                
                // Retry with stricter prompt
                const retryPrompt = `The previous translation had placeholder comments. Translate this code with COMPLETE implementations.

NO PLACEHOLDERS ALLOWED. Every method must have actual code.

\`\`\`${file.language}
${chunk.content}
\`\`\`

Translate to ${targetLanguage} with FULL implementations:`;
                
                const retryResult = await callLanguageModelForCoding(retryPrompt);
                const retryMatch = retryResult.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
                if (retryMatch) {
                    translatedChunk = retryMatch[1];
                } else {
                    translatedChunk = retryResult;
                }
            }
            
            // Clean up lazy LLM patterns
            translatedChunk = cleanupGeneratedCode(translatedChunk);
            
            translatedChunks.push(translatedChunk);
            
            // Keep last part of translation for context
            previousTranslations = translatedChunk;
            
        } catch (err) {
            log(`translateLargeFile: Chunk ${i + 1} error:`, err.message);
            translatedChunks.push(`// ERROR translating chunk ${i + 1}: ${err.message}`);
        }
    }
    
    // Combine all chunks
    let fullTranslation = '';
    
    // Add imports/package declaration for Java
    if (targetLanguage.toLowerCase() === 'java') {
        fullTranslation = `// Translated from ${file.fileName} (${totalLines} lines)
// Auto-generated by AstraCode

import java.util.*;
import java.util.function.*;

`;
    }
    
    fullTranslation += translatedChunks.join('\n\n');
    
    // Final cleanup of the complete translation
    fullTranslation = cleanupGeneratedCode(fullTranslation);
    
    log(`translateLargeFile: Complete translation is ${fullTranslation.split('\n').length} lines`);
    
    return fullTranslation;
}

/**
 * Extract header info (structs, typedefs, function declarations) from code
 */
function extractHeaderInfo(content, language) {
    const lines = content.split('\n');
    const headerLines = [];
    
    const langLower = (language || '').toLowerCase();
    
    if (langLower === 'c' || langLower === 'cpp' || langLower === 'c++') {
        // Extract typedefs, structs, enums, and function declarations
        let inStruct = false;
        let braceDepth = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            // Include typedefs
            if (trimmed.startsWith('typedef') || trimmed.startsWith('#define')) {
                headerLines.push(line);
                continue;
            }
            
            // Track structs/enums
            if (trimmed.match(/^(typedef\s+)?(struct|enum|union)\s+\w*/)) {
                inStruct = true;
                braceDepth = 0;
            }
            
            if (inStruct) {
                headerLines.push(line);
                braceDepth += (line.match(/\{/g) || []).length;
                braceDepth -= (line.match(/\}/g) || []).length;
                if (braceDepth <= 0 && line.includes('}')) {
                    inStruct = false;
                }
                continue;
            }
            
            // Function declarations (prototypes)
            if (trimmed.match(/^(static\s+)?(extern\s+)?[\w\s\*]+\([^)]*\)\s*;$/)) {
                headerLines.push(line);
            }
        }
    }
    
    return headerLines.join('\n');
}

/**
 * Split code into chunks at function boundaries
 */
function splitIntoFunctionChunks(content, language, maxLines) {
    const lines = content.split('\n');
    const chunks = [];
    let currentChunk = [];
    let currentStart = 1;
    let braceDepth = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        currentChunk.push(line);
        
        // Track brace depth
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;
        
        // Check if we should break here
        const shouldBreak = currentChunk.length >= maxLines && braceDepth === 0;
        const forceBreak = currentChunk.length >= maxLines * 1.5;
        
        if (shouldBreak || forceBreak || i === lines.length - 1) {
            chunks.push({
                content: currentChunk.join('\n'),
                startLine: currentStart,
                endLine: currentStart + currentChunk.length - 1
            });
            currentStart = i + 2;
            currentChunk = [];
        }
    }
    
    return chunks;
}

/**
 * Critique a translation - check for completeness and correctness
 */
async function critiqueTranslation(originalCode, sourceLang, translatedCode, targetLang, fileName) {
    // First, do a quick automated check for obvious placeholder patterns
    const placeholderPatterns = [
        /\/\/\s*Implementation\s*details/gi,
        /\/\/\s*TODO/gi,
        /\/\/\s*Placeholder/gi,
        /\/\/\s*Add\s*implementation/gi,
        /\/\/\s*Logic\s*to/gi,
        /\/\/\s*\.\.\./gi,
        /throw\s+new\s+UnsupportedOperationException/gi,
        /return\s+null;\s*\/\/\s*Placeholder/gi,
        /return\s+new\s+\w+\(\);\s*\/\/\s*Placeholder/gi,
        /\/\*\s*Implementation/gi,
        /NotImplementedException/gi,
        /\/\/\s*implement\s/gi,
        /^\s*\.\.\.\s*$/gm,                           // Just "..." on a line
        /```\w*\s*\.\.\.\s*```/gi,                    // ```java ... ```
        /\/\/\s*rest of\s/gi,                         // "// rest of implementation"
        /\/\/\s*remaining\s/gi,                       // "// remaining code"
        /\/\/\s*etc\.?/gi,                            // "// etc"
        /\/\/\s*and so on/gi,                         // "// and so on"
        /\/\/\s*continue\s/gi,                        // "// continue implementation"
        /\/\/\s*similar\s+to\s/gi,                    // "// similar to above"
    ];
    
    const foundPlaceholders = [];
    for (const pattern of placeholderPatterns) {
        const matches = translatedCode.match(pattern);
        if (matches) {
            foundPlaceholders.push(...matches.slice(0, 3)); // Limit to 3 examples per pattern
        }
    }
    
    // Check for empty method bodies (common placeholder pattern)
    const emptyMethods = translatedCode.match(/\{\s*\}/g);
    const emptyMethodCount = emptyMethods ? emptyMethods.length : 0;
    
    // Check line count ratio - translated should be similar length to original
    const originalLines = originalCode.split('\n').length;
    const translatedLines = translatedCode.split('\n').length;
    const lineRatio = translatedLines / originalLines;
    
    // If we found placeholders, fail immediately with specific issues
    if (foundPlaceholders.length > 0 || (lineRatio < 0.3 && originalLines > 100)) {
        const issues = [];
        
        if (foundPlaceholders.length > 0) {
            issues.push(`Found ${foundPlaceholders.length} placeholder patterns: ${foundPlaceholders.slice(0, 5).join(', ')}`);
        }
        
        if (lineRatio < 0.3 && originalLines > 100) {
            issues.push(`Translation is too short: ${translatedLines} lines vs original ${originalLines} lines (${Math.round(lineRatio * 100)}%)`);
        }
        
        if (emptyMethodCount > 5) {
            issues.push(`Found ${emptyMethodCount} empty method bodies - methods need actual implementation`);
        }
        
        log(`critiqueTranslation: Auto-detected issues:`, issues);
        return { passed: false, issues };
    }
    
    // If no obvious placeholders, do LLM critique for logic correctness
    const prompt = `# CRITIQUE TRANSLATION: ${fileName}

## ORIGINAL CODE (${sourceLang}) - ${originalLines} lines
\`\`\`${sourceLang}
${originalCode.substring(0, 15000)}${originalCode.length > 15000 ? '\n... (truncated)' : ''}
\`\`\`

## TRANSLATED CODE (${targetLang}) - ${translatedLines} lines
\`\`\`${targetLang}
${translatedCode.substring(0, 15000)}${translatedCode.length > 15000 ? '\n... (truncated)' : ''}
\`\`\`

## CHECK FOR THESE SPECIFIC ISSUES:

1. **PLACEHOLDER DETECTION** - Are there ANY of these forbidden patterns?
   - "// Implementation details"
   - "// TODO" or "// Placeholder"  
   - "// Logic to..." or "// Add implementation"
   - Methods that just return null or throw exceptions
   - Empty method bodies {}
   - Comments describing what code SHOULD do instead of actual code

2. **COMPLETENESS** - Is EVERY function from the original fully translated?
   - Count functions in original vs translated
   - Are function bodies complete or just stubs?

3. **LOGIC PRESERVATION** - Are all branches, loops, conditions translated?

4. **LENGTH CHECK** - Original has ${originalLines} lines. Translation has ${translatedLines} lines.
   - If translation is <50% the length, it's likely incomplete

## RESPOND:
If translation is COMPLETE with NO placeholders:
CRITIQUE_PASSED

If there are ANY placeholders or incomplete methods:
CRITIQUE_FAILED
ISSUES:
1. [Specific issue with line number or function name]
2. [Next issue]
...

Be STRICT. Any placeholder pattern = FAILURE.`;

    try {
        const result = await callLanguageModel(prompt);
        
        if (result.includes('CRITIQUE_PASSED')) {
            return { passed: true, issues: [] };
        }
        
        // Extract issues
        const issues = [];
        const issuesMatch = result.match(/ISSUES:\s*([\s\S]*)/);
        if (issuesMatch) {
            const issueLines = issuesMatch[1].split('\n').filter(l => l.trim());
            for (const line of issueLines) {
                const cleaned = line.replace(/^\d+\.\s*/, '').trim();
                if (cleaned.length > 5) {
                    issues.push(cleaned);
                }
            }
        }
        
        return { passed: false, issues: issues.length > 0 ? issues : ['Translation incomplete - see critique'] };
    } catch (err) {
        log(`critiqueTranslation: Error:`, err.message);
        return { passed: true, issues: [] }; // Assume pass on error
    }
}

/**
 * Fix translation issues identified by critique
 */
async function fixTranslationIssues(originalCode, sourceLang, translatedCode, targetLang, issues) {
    // For large files, we may need to process in sections
    const originalLines = originalCode.split('\n').length;
    
    const prompt = `# FIX TRANSLATION - IMPLEMENT ALL MISSING CODE

## ORIGINAL SOURCE CODE (${sourceLang}) - ${originalLines} lines
\`\`\`${sourceLang}
${originalCode.substring(0, 20000)}${originalCode.length > 20000 ? '\n... (see full source above)' : ''}
\`\`\`

## CURRENT BROKEN TRANSLATION (${targetLang})
\`\`\`${targetLang}
${translatedCode}
\`\`\`

## ISSUES THAT MUST BE FIXED:
${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## YOUR TASK - BE SPECIFIC

You MUST fix every issue by providing ACTUAL IMPLEMENTATION CODE.

### FORBIDDEN IN YOUR OUTPUT:
❌ "// Implementation details" 
❌ "// TODO"
❌ "// Placeholder"
❌ "// Logic to..."
❌ "return null; // Placeholder"
❌ "return new X(); // Placeholder"
❌ Empty method bodies {}
❌ throw UnsupportedOperationException
❌ Any comment saying what code SHOULD do

### REQUIRED IN YOUR OUTPUT:
✅ Every method must have ACTUAL CODE that does the work
✅ Translate the logic from the original source code
✅ If original has a 50-line function, your fix must have ~50 lines of logic
✅ Use the original source code to write the actual implementation

### EXAMPLE OF WRONG vs RIGHT:

WRONG (placeholder):
\`\`\`java
private static PartitionBoundInfo partition_bounds_create(...) {
    // Logic to create partition bounds
    return new PartitionBoundInfo(); // Placeholder
}
\`\`\`

RIGHT (actual implementation):
\`\`\`java
private static PartitionBoundInfo partition_bounds_create(PartitionBoundSpec[] boundspecs, int nparts, PartitionKey key, int[] mapping) {
    PartitionBoundInfo boundinfo = new PartitionBoundInfo();
    boundinfo.strategy = key.strategy;
    boundinfo.ndatums = 0;
    
    // Sort bound specs
    List<PartitionBoundSpec> sortedSpecs = new ArrayList<>(Arrays.asList(boundspecs));
    sortedSpecs.sort((a, b) -> compareBounds(a, b, key));
    
    // Build datum array
    for (int i = 0; i < nparts; i++) {
        PartitionBoundSpec spec = sortedSpecs.get(i);
        if (spec.is_default) {
            boundinfo.default_index = i;
        } else {
            // Process bound values
            boundinfo.datums[boundinfo.ndatums++] = spec.lowerdatums;
        }
        mapping[i] = i;
    }
    
    return boundinfo;
}
\`\`\`

## OUTPUT
Provide the COMPLETE fixed ${targetLang} code with ALL placeholders replaced by actual implementations.
The output should be similar in length to the original (${originalLines} lines).

Output the complete fixed code now:`;

    try {
        const result = await callLanguageModelForCoding(prompt);
        
        // Extract code from markdown if present
        let fixedCode = result;
        const codeMatch = result.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
        if (codeMatch) {
            fixedCode = codeMatch[1];
        }
        
        // Clean up lazy LLM patterns
        fixedCode = cleanupGeneratedCode(fixedCode);
        
        // Verify the fix actually removed placeholders
        const stillHasPlaceholders = /\/\/\s*(Implementation|TODO|Placeholder|Logic to)/gi.test(fixedCode);
        if (stillHasPlaceholders) {
            log(`fixTranslationIssues: Warning - fix still contains placeholders`);
        }
        
        return fixedCode;
    } catch (err) {
        log(`fixTranslationIssues: Error:`, err.message);
        return null;
    }
}

/**
 * Compile Java files using VS Code's Java extension or javac
 */
async function compileJavaFiles(translatedFiles) {
    const javaFiles = translatedFiles.filter(f => f.language === 'java' && f.translatedCode);
    
    if (javaFiles.length === 0) {
        return { success: true, errors: [], message: 'No Java files to compile' };
    }
    
    // Get workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return { success: false, errors: [{ message: 'No workspace folder open' }] };
    }
    
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const outputDir = path.join(workspaceRoot, '.astra', 'generated');
    const classDir = path.join(workspaceRoot, '.astra', 'compiled');
    
    // Ensure directories exist
    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(classDir));
    } catch (err) {
        // Directories may already exist
    }
    
    // Save all Java files to disk first
    const savedFiles = [];
    for (const file of javaFiles) {
        const filePath = path.join(outputDir, file.newFileName);
        try {
            await vscode.workspace.fs.writeFile(
                vscode.Uri.file(filePath),
                Buffer.from(file.translatedCode, 'utf8')
            );
            savedFiles.push(filePath);
            file.savedPath = filePath;
        } catch (err) {
            log(`compileJavaFiles: Error saving ${file.newFileName}:`, err.message);
        }
    }
    
    if (savedFiles.length === 0) {
        return { success: false, errors: [{ message: 'Failed to save Java files' }] };
    }
    
    // Try to compile using VS Code Java extension first
    try {
        // Check if Java extension is available
        const javaExtension = vscode.extensions.getExtension('redhat.java');
        
        if (javaExtension && javaExtension.isActive) {
            log('compileJavaFiles: Using VS Code Java extension');
            
            // Trigger compilation by opening files
            for (const filePath of savedFiles) {
                const doc = await vscode.workspace.openTextDocument(filePath);
                // This triggers the Java extension to compile
            }
            
            // Wait a bit for diagnostics
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check diagnostics for errors
            const errors = [];
            for (const filePath of savedFiles) {
                const uri = vscode.Uri.file(filePath);
                const diagnostics = vscode.languages.getDiagnostics(uri);
                
                for (const diag of diagnostics) {
                    if (diag.severity === vscode.DiagnosticSeverity.Error) {
                        errors.push({
                            file: path.basename(filePath),
                            line: diag.range.start.line + 1,
                            message: diag.message,
                            code: diag.code
                        });
                    }
                }
            }
            
            if (errors.length === 0) {
                return { success: true, errors: [], message: 'Compiled via VS Code Java extension' };
            } else {
                return { success: false, errors, message: 'Compilation errors found' };
            }
        }
    } catch (err) {
        log('compileJavaFiles: VS Code Java extension not available, trying javac');
    }
    
    // Fallback: Try javac directly
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        const fileList = savedFiles.join(' ');
        const command = `javac -d "${classDir}" ${fileList}`;
        
        log('compileJavaFiles: Running javac:', command);
        
        const { stdout, stderr } = await execPromise(command, { 
            cwd: outputDir,
            timeout: 30000 
        });
        
        if (stderr && stderr.includes('error:')) {
            // Parse javac errors
            const errors = parseJavacErrors(stderr);
            return { success: false, errors, message: stderr };
        }
        
        return { success: true, errors: [], message: 'Compiled with javac' };
        
    } catch (err) {
        // Parse error output
        const errors = parseJavacErrors(err.stderr || err.message);
        return { success: false, errors, message: err.message };
    }
}

/**
 * Parse javac error output into structured format
 */
function parseJavacErrors(output) {
    const errors = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
        // Match: FileName.java:lineNum: error: message
        const match = line.match(/(\w+\.java):(\d+):\s*error:\s*(.+)/);
        if (match) {
            errors.push({
                file: match[1],
                line: parseInt(match[2]),
                message: match[3]
            });
        }
    }
    
    return errors;
}

/**
 * Fix a compilation error in translated code
 */
async function fixCompilationError(originalCode, sourceLang, translatedCode, targetLang, error) {
    const prompt = `# FIX COMPILATION ERROR

## ORIGINAL CODE (${sourceLang})
\`\`\`${sourceLang}
${originalCode}
\`\`\`

## CURRENT ${targetLang} CODE (has compilation error)
\`\`\`${targetLang}
${translatedCode}
\`\`\`

## COMPILATION ERROR
File: ${error.file}
Line: ${error.line}
Error: ${error.message}

## YOUR TASK
Fix the compilation error. The fix must:
1. Resolve the specific error mentioned
2. Not break any other functionality
3. Preserve all logic from original code
4. Maintain decimal precision

Output ONLY the complete fixed ${targetLang} code:`;

    try {
        const result = await callLanguageModelForCoding(prompt);
        
        let fixedCode = result;
        const codeMatch = result.match(/\`\`\`(?:\w+)?\n([\s\S]*?)\n\`\`\`/);
        if (codeMatch) {
            fixedCode = codeMatch[1];
        }
        
        // Clean up lazy LLM patterns
        fixedCode = cleanupGeneratedCode(fixedCode);
        
        return fixedCode;
    } catch (err) {
        log(`fixCompilationError: Error:`, err.message);
        return null;
    }
}

/**
 * Judge/Validator: LLM-driven validation
 * No hardcoded patterns - lets the LLM reason about what's missing
 */
async function validateAndRefineAnswer(question, answer, codeContext) {
    // Always validate - let the LLM decide if anything is missing
    // Truncate context if too large (keep beginning and end)
    let contextForJudge = codeContext;
    if (codeContext.length > 40000) {
        const halfSize = 18000;
        contextForJudge = codeContext.substring(0, halfSize) + 
            '\n\n... [middle truncated] ...\n\n' + 
            codeContext.substring(codeContext.length - halfSize);
    }
    
    const judgePrompt = `# JUDGE TASK: Validate this answer against the source code

## ORIGINAL QUESTION
${question}

## GENERATED ANSWER
${answer}

## SOURCE CODE TO VERIFY AGAINST
\`\`\`
${contextForJudge}
\`\`\`

## YOUR TASK
You are a code review judge. Carefully:

1. **Read the question** - What EXACTLY is being asked?
2. **Read the answer** - What claims does it make?
3. **Search the source code** - Verify each claim. Look for:
   - Functions mentioned - do they exist at those line numbers?
   - Call flow direction - is caller→callee correct?
   - The ACTUAL function where work happens (not just entry points)
   - Parameters and options that control behavior

4. **Find what's missing** - Grep the code mentally for:
   - Functions with names suggesting the feature (e.g., "prepare_", "encode_", "_build")
   - Where data transformation actually happens
   - Configuration options not mentioned

## RESPOND WITH:

**If the answer is accurate and complete:**
VALIDATION: PASS

**If important information is wrong or missing:**

## 🧐 Critique
[Specifically what the answer got wrong or missed. Name exact functions from the code.]

## 🔍 Additional Findings

| Function | Location | Purpose |
|:---------|:---------|:--------|
| \`name()\` | \`file:line\` | What it actually does |

[Any missing code flow or important details]

Be concise but specific. Only add findings that significantly improve understanding.`;

    try {
        log('validateAndRefineAnswer: Running LLM judge');
        const judgeResult = await callLanguageModel(judgePrompt);
        
        if (judgeResult.includes('VALIDATION: PASS')) {
            log('validateAndRefineAnswer: Judge approved answer');
            return answer;
        }
        
        if (judgeResult.includes('Critique') || judgeResult.includes('Additional Findings')) {
            log('validateAndRefineAnswer: Judge added corrections');
            
            // Extract critique and additions
            const critiqueMatch = judgeResult.match(/## 🧐 Critique[\s\S]*?(?=## 🔍|$)/);
            const additionsMatch = judgeResult.match(/## 🔍 Additional Findings[\s\S]*/);
            
            let additions = '';
            if (critiqueMatch) {
                additions += critiqueMatch[0].trim();
            }
            if (additionsMatch) {
                if (additions) additions += '\n\n';
                additions += additionsMatch[0].trim();
            }
            
            if (additions.length > 50) {
                return answer + '\n\n---\n\n' + additions;
            }
            
            // Fallback: append the whole judge result
            const cleanResult = judgeResult.replace(/VALIDATION:.*\n?/g, '').trim();
            if (cleanResult.length > 50) {
                return answer + '\n\n---\n\n## 🧐 Critique\n\n' + cleanResult;
            }
        }
        
        return answer;
    } catch (error) {
        log('validateAndRefineAnswer: Judge error:', error.message);
        return answer;
    }
}

/**
 * Decompose compound questions into sub-questions
 * e.g., "explain X and tell me if Y" → ["How does X work?", "Is Y true/configurable?"]
 */
function decomposeQuestion(question) {
    const subQuestions = [];
    const questionLower = question.toLowerCase();
    
    // Detect compound question patterns
    const compoundPatterns = [
        /\band\s+(?:also\s+)?(?:tell|explain|show|describe|check|verify)/i,
        /\.\s*(?:also|and|additionally)/i,
        /\?\s*(?:also|and)/i,
        /,\s*and\s+/i
    ];
    
    const isCompound = compoundPatterns.some(p => p.test(question));
    
    if (isCompound) {
        // Split on "and tell", "and also", etc.
        const parts = question.split(/\s+and\s+(?:also\s+)?(?:tell|explain|show|check|describe|verify)\s*/i);
        
        if (parts.length > 1) {
            // First part is usually "explain X"
            subQuestions.push(`How does ${extractTopic(parts[0])} work?`);
            // Second part is usually "if Y"
            for (let i = 1; i < parts.length; i++) {
                const part = parts[i].trim();
                if (part.match(/^(?:me\s+)?if\s+/i)) {
                    subQuestions.push(part.replace(/^(?:me\s+)?if\s+/i, 'Is ') + '?');
                } else {
                    subQuestions.push(part.endsWith('?') ? part : part + '?');
                }
            }
        }
    }
    
    // Detect yes/no questions embedded in the question
    if (questionLower.includes('configurable') || questionLower.includes('can be configured')) {
        if (!subQuestions.some(q => q.toLowerCase().includes('configur'))) {
            subQuestions.push('Is this configurable? What parameters control the behavior?');
        }
    }
    
    if (questionLower.includes('optional') || questionLower.includes('can i change')) {
        if (!subQuestions.some(q => q.toLowerCase().includes('optional') || q.toLowerCase().includes('change'))) {
            subQuestions.push('What options are available and how do you set them?');
        }
    }
    
    // Detect request vs response context
    if (questionLower.includes('request') && !questionLower.includes('response')) {
        subQuestions.push('Focus on REQUEST handling (outgoing), not response parsing');
    } else if (questionLower.includes('response') && !questionLower.includes('request')) {
        subQuestions.push('Focus on RESPONSE handling (incoming), not request encoding');
    }
    
    // Detect encoding/decoding context
    if (questionLower.includes('encoding') || questionLower.includes('encode')) {
        if (questionLower.includes('request')) {
            subQuestions.push('How is outgoing data encoded/serialized before sending?');
        }
    }
    
    // If no sub-questions detected, use the original question
    if (subQuestions.length === 0) {
        subQuestions.push(question);
    }
    
    // Always add "how does it work" if not present
    const hasExplain = subQuestions.some(q => 
        q.toLowerCase().includes('how') || 
        q.toLowerCase().includes('explain') ||
        q.toLowerCase().includes('work')
    );
    if (!hasExplain && subQuestions.length < 3) {
        subQuestions.unshift(`How does ${extractTopic(question)} work?`);
    }
    
    return subQuestions.slice(0, 4); // Max 4 sub-questions
}

/**
 * Extract the main topic from a question
 */
function extractTopic(text) {
    // Remove common question starters
    let topic = text
        .replace(/^(?:explain|describe|tell me about|how does|what is|show me)\s*/i, '')
        .replace(/\s*\?.*$/, '')
        .replace(/\s*and\s*$/, '')
        .trim();
    
    // If topic is too long, take first part
    if (topic.length > 50) {
        topic = topic.split(/[,.]/, 1)[0].trim();
    }
    
    return topic || 'this feature';
}

/**
 * Chunk context into manageable pieces, trying to break at natural boundaries
 */
function chunkContext(context, maxChunkSize = 18000) {
    if (!context || context.length <= maxChunkSize) {
        return [context];
    }
    
    const chunks = [];
    let remaining = context;
    
    while (remaining.length > 0) {
        if (remaining.length <= maxChunkSize) {
            chunks.push(remaining);
            break;
        }
        
        // Try to break at a natural boundary (file section, double newline)
        let breakPoint = maxChunkSize;
        
        // Look for file section boundary (### filename)
        const fileBoundary = remaining.lastIndexOf('\n### ', maxChunkSize);
        if (fileBoundary > maxChunkSize * 0.5) {
            breakPoint = fileBoundary;
        } else {
            // Look for double newline
            const doubleLine = remaining.lastIndexOf('\n\n', maxChunkSize);
            if (doubleLine > maxChunkSize * 0.5) {
                breakPoint = doubleLine;
            }
        }
        
        chunks.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trim();
    }
    
    return chunks;
}

/**
 * Validate extracted facts against the actual codeIndex
 * Removes hallucinated functions/files that don't exist in the index
 */
function validateExtractedFacts(facts) {
    if (!facts) return facts;
    
    // Helper: Check if a function exists in codeIndex
    const functionExists = (funcName) => {
        if (!funcName || funcName === 'unknown') return false;
        // Clean the name (remove parentheses, etc.)
        const cleanName = funcName.replace(/\(\)$/, '').replace(/\(.*\)$/, '').trim();
        // Check both direct name and name@file pattern
        for (const [key, symbol] of codeIndex.symbols) {
            if (symbol.name === cleanName || 
                symbol.name.toLowerCase() === cleanName.toLowerCase()) {
                return true;
            }
        }
        return false;
    };
    
    // Helper: Check if a file exists in contextFiles or codeIndex
    const fileExists = (fileName) => {
        if (!fileName || fileName === 'unknown') return false;
        // Clean the filename
        const cleanFile = fileName.replace(/^📄\s*/, '').trim();
        // Check contextFiles
        for (const [path] of contextFiles) {
            if (path.endsWith(cleanFile) || path.includes(cleanFile)) {
                return true;
            }
        }
        // Check codeIndex.files
        for (const [path] of codeIndex.files) {
            if (path.endsWith(cleanFile) || path.includes(cleanFile)) {
                return true;
            }
        }
        return false;
    };
    
    // Patterns that indicate hallucinated entry points
    const hallucinated_patterns = [
        /^main_\w+_function$/i,      // main_partitioning_function
        /^main_\w+$/i,               // main_something
        /^entry_\w+$/i,              // entry_something
        /^\w+_main$/i,               // something_main
        /^do_\w+$/i,                 // do_something (too generic)
        /^handle_\w+$/i,             // handle_something (too generic unless confirmed)
    ];
    
    const isLikelyHallucinated = (funcName) => {
        if (!funcName) return true;
        const cleanName = funcName.replace(/\(\)$/, '').trim();
        return hallucinated_patterns.some(p => p.test(cleanName));
    };
    
    // Validate entry_point
    if (facts.entry_point) {
        const entryFunc = facts.entry_point.function;
        const entryFile = facts.entry_point.file;
        
        // Check if entry point looks hallucinated AND doesn't exist in index
        if (isLikelyHallucinated(entryFunc) && !functionExists(entryFunc)) {
            log(`validateExtractedFacts: Removing hallucinated entry_point "${entryFunc}" (not in index)`);
            facts.entry_point = null;
        }
        // Also check if function exists at all
        else if (entryFunc && entryFunc !== 'unknown' && !functionExists(entryFunc)) {
            // Check if file at least exists
            if (!fileExists(entryFile)) {
                log(`validateExtractedFacts: Removing unverified entry_point "${entryFunc}" (neither function nor file in index)`);
                facts.entry_point = null;
            }
        }
    }
    
    // Validate key_functions - remove those that don't exist
    if (facts.key_functions && Array.isArray(facts.key_functions)) {
        const originalCount = facts.key_functions.length;
        facts.key_functions = facts.key_functions.filter(fn => {
            if (!fn.name) return false;
            // Keep if function exists OR if file exists (file might have the function even if not indexed)
            if (functionExists(fn.name)) return true;
            if (fileExists(fn.file)) return true;
            log(`validateExtractedFacts: Removing unverified function "${fn.name}" (not in index)`);
            return false;
        });
        if (facts.key_functions.length < originalCount) {
            log(`validateExtractedFacts: Filtered key_functions ${originalCount} -> ${facts.key_functions.length}`);
        }
    }
    
    // Validate code_flow - remove flows with non-existent functions
    if (facts.code_flow && Array.isArray(facts.code_flow)) {
        const originalCount = facts.code_flow.length;
        facts.code_flow = facts.code_flow.filter(flow => {
            // Keep if at least one of caller/callee exists or file exists
            const callerExists = functionExists(flow.caller);
            const calleeExists = functionExists(flow.callee);
            const flowFileExists = fileExists(flow.file);
            return callerExists || calleeExists || flowFileExists;
        });
        if (facts.code_flow.length < originalCount) {
            log(`validateExtractedFacts: Filtered code_flow ${originalCount} -> ${facts.code_flow.length}`);
        }
    }
    
    // Validate key_files - files should exist
    if (facts.key_files && Array.isArray(facts.key_files)) {
        const originalCount = facts.key_files.length;
        facts.key_files = facts.key_files.filter(f => {
            if (!f.file) return false;
            if (fileExists(f.file)) return true;
            log(`validateExtractedFacts: Removing unverified file "${f.file}" (not in context)`);
            return false;
        });
        if (facts.key_files.length < originalCount) {
            log(`validateExtractedFacts: Filtered key_files ${originalCount} -> ${facts.key_files.length}`);
        }
    }
    
    // Validate data_structures - check they exist in codeIndex
    if (facts.data_structures && Array.isArray(facts.data_structures)) {
        const originalCount = facts.data_structures.length;
        facts.data_structures = facts.data_structures.filter(ds => {
            if (!ds.name) return false;
            // Check if struct exists in codeIndex
            for (const [key, symbol] of codeIndex.symbols) {
                if (symbol.name === ds.name && 
                    (symbol.type === 'struct' || symbol.type === 'typedef' || symbol.type === 'class' || symbol.type === 'enum')) {
                    // Update with verified info
                    ds.verified_file = symbol.file;
                    ds.verified_line = symbol.line;
                    return true;
                }
            }
            // Also check if file exists (struct might be there even if not indexed)
            if (ds.file && fileExists(ds.file)) return true;
            // Keep if it has substantial definition (LLM extracted actual code)
            if (ds.definition && ds.definition.length > 30) return true;
            log(`validateExtractedFacts: Removing unverified struct "${ds.name}"`);
            return false;
        });
        if (facts.data_structures.length < originalCount) {
            log(`validateExtractedFacts: Filtered data_structures ${originalCount} -> ${facts.data_structures.length}`);
        }
    }
    
    // Verify code_flow against actual call graph
    if (facts.code_flow && Array.isArray(facts.code_flow)) {
        for (const flow of facts.code_flow) {
            // Check if this call relationship exists in codeIndex.callGraph
            const callees = codeIndex.callGraph.get(flow.caller);
            flow.verified = callees && callees.has(flow.callee);
            if (!flow.verified) {
                log(`validateExtractedFacts: Call ${flow.caller} -> ${flow.callee} not in call graph (may still be valid)`);
            }
        }
    }
    
    return facts;
}

/**
 * Find real entry points from call graph data for the given files/functions
 * Entry points are functions that are called by others but don't call much themselves,
 * OR functions that call others but aren't called by anything (public APIs)
 */
function findRealEntryPoints(keyFiles, keyFunctions) {
    const entryPoints = [];
    
    if (!codeIndex.callGraph || codeIndex.callGraph.size === 0) {
        return entryPoints;
    }
    
    // Collect function names from key files and key functions
    const relevantFunctions = new Set();
    
    // Add functions from keyFunctions
    if (keyFunctions) {
        keyFunctions.forEach(fn => {
            if (fn.name) relevantFunctions.add(fn.name);
        });
    }
    
    // Add functions from keyFiles
    if (keyFiles) {
        keyFiles.forEach(kf => {
            if (kf.functions) {
                kf.functions.forEach(fn => relevantFunctions.add(fn));
            }
        });
    }
    
    // Find entry points: functions not called by others (or called by few) that call others
    for (const funcName of relevantFunctions) {
        const callers = codeIndex.reverseCallGraph?.get(funcName)?.size || 0;
        const callees = codeIndex.callGraph.get(funcName)?.size || 0;
        
        // Entry point criteria: calls others but isn't called much
        if (callees > 0 && callers <= 2) {
            // Find the function in symbols to get file/line
            for (const [key, symbol] of codeIndex.symbols) {
                if (symbol.name === funcName && key.includes('@')) {
                    entryPoints.push({
                        name: symbol.name,
                        file: symbol.file?.split('/').pop() || 'unknown',
                        line: symbol.line || 0,
                        callees: callees,
                        callers: callers
                    });
                    break;
                }
            }
        }
    }
    
    // Sort by: more callees (more important), fewer callers (more entry-like)
    entryPoints.sort((a, b) => (b.callees - b.callers) - (a.callees - a.callers));
    
    // Return top 3 at most
    return entryPoints.slice(0, 3);
}

/**
 * Try to extract partial facts from a malformed LLM response
 * Uses regex patterns to salvage useful data even when JSON parsing fails
 */
function tryExtractPartialFacts(response, subQuestions, filesAnalyzed) {
    const facts = {
        summary: "Analysis completed - see details below",
        entry_point: null,  // Don't fabricate an entry point
        answers: [],
        key_files: [],
        code_flow: [],
        data_structures: [],
        key_functions: [],
        config_options: [],
        notes: []
    };
    
    try {
        // Try to extract summary
        const summaryMatch = response.match(/"summary"\s*:\s*"([^"]+)"/);
        if (summaryMatch) {
            facts.summary = summaryMatch[1];
        }
        
        // Try to extract entry point
        const entryMatch = response.match(/"entry_point"\s*:\s*\{[^}]*"function"\s*:\s*"([^"]+)"[^}]*"file"\s*:\s*"([^"]+)"[^}]*"line"\s*:\s*(\d+)/);
        if (entryMatch) {
            facts.entry_point = { 
                function: entryMatch[1], 
                file: cleanFileName(entryMatch[2]),  // Clean file name!
                line: parseInt(entryMatch[3]) 
            };
        }
        
        // Try to extract key_files array
        const keyFilesMatch = response.match(/"key_files"\s*:\s*\[([\s\S]*?)\]/);
        if (keyFilesMatch) {
            const fileMatches = keyFilesMatch[1].matchAll(/"file"\s*:\s*"([^"]+)"/g);
            for (const match of fileMatches) {
                const cleanedFile = cleanFileName(match[1]);  // Clean file name!
                if (!facts.key_files.find(f => f.file === cleanedFile)) {
                    facts.key_files.push({ file: cleanedFile, purpose: "See analysis", functions: [] });
                }
            }
        }
        
        // Try to extract key_functions array
        const keyFuncsMatch = response.match(/"key_functions"\s*:\s*\[([\s\S]*?)\]/);
        if (keyFuncsMatch) {
            const funcMatches = keyFuncsMatch[1].matchAll(/"name"\s*:\s*"([^"]+)"[^}]*"file"\s*:\s*"([^"]+)"[^}]*"line"\s*:\s*(\d+)/g);
            for (const match of funcMatches) {
                facts.key_functions.push({ 
                    name: match[1], 
                    file: cleanFileName(match[2]),  // Clean file name!
                    line: parseInt(match[3]),
                    purpose: "See analysis"
                });
            }
        }
        
        // If we couldn't extract key_files, use filesAnalyzed as fallback
        if (facts.key_files.length === 0 && filesAnalyzed.length > 0) {
            // Clean and dedupe file names
            const seenFiles = new Set();
            for (const f of filesAnalyzed.slice(0, 10)) {
                const clean = cleanFileName(f);
                if (!seenFiles.has(clean)) {
                    seenFiles.add(clean);
                    facts.key_files.push({ file: clean, purpose: "Contains relevant code", functions: [] });
                }
            }
        }
        
        // Generate answers from subQuestions
        facts.answers = subQuestions.map(sq => ({ 
            question: sq, 
            answer: "See analysis below for details", 
            references: [] 
        }));
        
        // Add note about partial extraction
        if (facts.key_files.length > 0 || facts.key_functions.length > 0) {
            facts.notes.push("Partial data extracted from response");
        } else {
            facts.notes.push("Could not extract structured data - showing analyzed files");
        }
        
    } catch (err) {
        log('tryExtractPartialFacts: Error:', err.message);
        facts.notes.push("Fallback extraction failed");
    }
    
    return facts;
}

/**
 * Synthesize findings from multiple chunks into final answer
 */
async function synthesizeFindings(question, findingsContext, domain, domain_notes, subQuestions) {
    return await synthesizeFindingsWithReferences(question, findingsContext, domain, domain_notes, subQuestions, [], [], []);
}

/**
 * Synthesize findings with related topics and references
 * Uses TWO-STAGE generation:
 *   Stage 1: Extract structured facts (JSON)
 *   Stage 2: Format facts into template (deterministic)
 */
async function synthesizeFindingsWithReferences(question, findingsContext, domain, domain_notes, subQuestions, filesAnalyzed, relatedFiles, functionsFound) {
    
    
    // Truncate findings early to prevent prompt overflow
    // API limit is ~25K chars, leave room for JSON template (~5K)
    const maxFindingsSize = 18000;
    let truncatedFindings = findingsContext;
    if (findingsContext && findingsContext.length > maxFindingsSize) {
        truncatedFindings = findingsContext.substring(0, maxFindingsSize) + 
            '\n\n[... truncated for processing ...]';
        log(`synthesizeFindingsWithReferences: Truncated findings from ${findingsContext.length} to ${maxFindingsSize}`);
    }
    
    // ================================================================
    // STAGE 1: EXTRACT STRUCTURED FACTS
    // ================================================================
    
    const extractionPrompt = `# FINDINGS FROM CODE ANALYSIS
${truncatedFindings}

# ORIGINAL QUESTION
${question}

# SUB-QUESTIONS
${subQuestions.map((sq, idx) => `${idx + 1}. ${sq}`).join('\n')}

# TASK
Extract structured facts from the findings above. Output ONLY valid JSON.

## EXTRACTION PRIORITY (most important first):
1. DATA STRUCTURES - Find typedef struct, struct, class, enum definitions
2. KEY FUNCTIONS - Functions that implement core logic with their signatures
3. CALL FLOW - Actual caller->callee relationships with line numbers
4. KEY FILES - Implementation files (.c, .cpp, .h, .java, .py) - NOT build files

{
  "summary": "2-3 sentences describing what this code does based on ACTUAL CODE in findings",
  
  "data_structures": [
    {
      "name": "StructName",
      "file": "header.h",
      "line": 50,
      "definition": "COPY THE ACTUAL STRUCT/TYPEDEF CODE HERE from findings",
      "purpose": "What data it holds and how it's used",
      "key_fields": ["field1: type and purpose", "field2: type and purpose"]
    }
  ],
  
  "entry_point": {
    "function": "actual_function_name_from_findings",
    "file": "filename.c",
    "line": 123
  },
  
  "key_functions": [
    {
      "name": "function_name",
      "file": "file.c",
      "line": 200,
      "signature": "ReturnType function_name(Param1 p1, Param2 p2)",
      "purpose": "What it does",
      "key_code": "COPY 3-5 LINES of important logic from findings"
    }
  ],
  
  "code_flow": [
    {
      "caller": "calling_function",
      "callee": "called_function", 
      "file": "file.c",
      "line": 100,
      "call_code": "THE ACTUAL LINE showing the function call",
      "purpose": "Why this call happens"
    }
  ],
  
  "key_files": [
    {
      "file": "filename.c",
      "purpose": "Detailed purpose explaining what this file implements",
      "functions": ["func1", "func2", "func3"]
    }
  ],
  
  "answers": [
    {
      "question": "The sub-question text",
      "answer": "Detailed answer with specific function names and code references",
      "references": ["file.c:123", "other.c:456"]
    }
  ],
  
  "config_options": [
    {
      "param": "parameter_name",
      "values": ["value1", "value2"],
      "effect": "What it controls"
    }
  ],
  
  "notes": [
    "Any limitations or areas needing more investigation"
  ]
}

CRITICAL RULES:
1. Output ONLY valid JSON - no markdown, no text before or after
2. Start with { and end with }
3. EXTRACT ACTUAL CODE from findings - copy struct definitions, function signatures, key logic
4. For data_structures: MUST include "definition" field with REAL code from findings
5. For key_functions: Include "signature" and "key_code" with ACTUAL code
6. For code_flow: Include "call_code" showing the actual function call line
7. NEVER invent function names, line numbers, or code not in the findings
8. NEVER include: Makefile, meson.build, CMakeLists.txt, README in key_files
9. PRIORITIZE files whose names match the query topic
10. If entry_point unclear, set to null (don't invent one)
11. If a category has no data, use empty array []
12. Do NOT wrap JSON in \`\`\` code fences

BEGIN JSON OUTPUT:`;

    try {
        log('synthesizeFindingsWithReferences: Stage 1 - Extracting structured facts');
        
        // VERBOSE: Show code path
        if (AGENT_CONFIG.verboseSearch) {
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n**🔧 Debug: Using synthesizeFindingsWithReferences (findings ${Math.round(findingsContext.length/1024)}KB)**\n\n`
            });
        }
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n*Stage 1: Extracting structured facts...*\n`
        });
        
        // extractionPrompt already built with truncated findings (truncation done at start)
        const extractionResult = await callLanguageModel(extractionPrompt, {
            task: 'analysis',
            preferStrongerModel: true
        });


        // Check if LLM is unavailable
        if (isLlmErrorResponse(extractionResult)) {
            log('synthesizeFindingsWithReferences: LLM unavailable');
            return {
                success: false,
                data: {
                    answer: `**Unable to analyze code**

The LLM is currently unavailable. Please check your GitHub Copilot or API configuration.

Check the Output panel (View → Output → AstraCode) for details.`
                }
            };
        }
        
        // VERBOSE: Show what LLM returned
        if (AGENT_CONFIG.verboseSearch) {
            const preview = extractionResult?.substring(0, 500).replace(/\n/g, '\\n') || 'null';
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n**🔧 Debug: LLM returned (first 500 chars):**\n\`\`\`\n${preview}\n\`\`\`\n\n`
            });
        }
        
        // Parse JSON from response
        let facts;
        let jsonParsed = false;
        try {
            // Clean up response - remove markdown code fences if present
            let jsonStr = extractionResult.trim();
            if (jsonStr.startsWith('```')) {
                jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
            }
            // Also try to find JSON object in the response
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                jsonStr = jsonMatch[0];
            }
            facts = JSON.parse(jsonStr);
            jsonParsed = true;
            log('synthesizeFindingsWithReferences: Successfully parsed facts JSON');
        } catch (parseErr) {
            log('synthesizeFindingsWithReferences: JSON parse error:', parseErr.message);
            log('synthesizeFindingsWithReferences: Raw response:', extractionResult.substring(0, 500));
            
            // VERBOSE: Show parse error
            if (AGENT_CONFIG.verboseSearch) {
                const lastPart = extractionResult?.substring(extractionResult.length - 300).replace(/\n/g, '\\n') || '';
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n**⚠️ JSON Parse Error:** ${parseErr.message}\n**Last 300 chars of response:**\n\`\`\`\n${lastPart}\n\`\`\`\n**Attempting partial extraction...**\n\n`
                });
            }
            
            // Try to extract partial data from malformed response
            facts = tryExtractPartialFacts(extractionResult, subQuestions, filesAnalyzed);
        }
        
        // VERBOSE: Show parsed facts summary
        if (AGENT_CONFIG.verboseSearch) {
            const factsSummary = `**📊 Extracted Facts (JSON parsed: ${jsonParsed}):**
- Summary: ${facts.summary?.substring(0, 50) || 'none'}...
- Entry point: \`${facts.entry_point?.function || 'none'}()\`
- Key files: ${facts.key_files?.length || 0}
- Code flow: ${facts.code_flow?.length || 0} relationships
- Data structures: ${facts.data_structures?.length || 0}
- Key functions: ${facts.key_functions?.length || 0}
- Config options: ${facts.config_options?.length || 0}
`;
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: factsSummary + '\n---\n\n'
            });
        }
        
        // ================================================================
        // VALIDATION: Verify extracted functions exist in codeIndex
        // ================================================================
        facts = validateExtractedFacts(facts);
        
        // ================================================================
        // DECISION: Use template OR raw response?
        // ================================================================
        // If JSON parsing failed and we didn't extract much useful data,
        // the raw LLM response might be better than an empty template
        const hasUsefulStructuredData = jsonParsed || 
            (facts.key_functions?.length >= 2) ||
            (facts.key_files?.length >= 3 && facts.code_flow?.length >= 1);
        
        if (!hasUsefulStructuredData && extractionResult && extractionResult.length > 500) {
            // LLM returned substantial content but we couldn't parse it as JSON
            // Check if it looks like prose/markdown rather than JSON
            const looksLikeProse = !extractionResult.trim().startsWith('{') || 
                                   extractionResult.includes('##') ||
                                   extractionResult.includes('**');
            
            if (looksLikeProse) {
                log('synthesizeFindingsWithReferences: Falling back to raw LLM response (better than empty template)');
                
                if (AGENT_CONFIG.verboseSearch) {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `**📝 Using raw LLM response (structured extraction insufficient)**\n\n---\n\n`
                    });
                }
                
                // Return the raw response - it's probably better than an empty template
                return { success: true, data: { answer: extractionResult } };
            }
        }
        
        // ================================================================
        // STAGE 2: FORMAT INTO TEMPLATE (Deterministic)
        // ================================================================
        log('synthesizeFindingsWithReferences: Stage 2 - Formatting into template');
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*Stage 2: Formatting structured response...*\n\n`
        });
        
        const formatted = formatFactsToTemplate(facts, subQuestions, relatedFiles, functionsFound, findingsContext, question);
        
        return { success: true, data: { answer: formatted } };
        
    } catch (err) {
        log('synthesizeFindingsWithReferences: Error:', err.message);
        return {
            success: true,
            data: { answer: `## Synthesis Error\n\n**Error:** ${err.message}\n\n### Raw Findings:\n${findingsContext.substring(0, 15000)}` }
        };
    }
}

/**
 * Clean file name: remove emojis, path prefixes, backticks
 * Handles LLM output that includes emojis like "📄 partdesc.c"
 */
function cleanFileName(fileName) {
    if (!fileName) return 'unknown';
    let cleaned = fileName;
    
    // Remove specific emoji characters used in formatting
    // DO NOT use \p{Emoji} as it strips digits (1,2,3 etc are classified as emoji components)
    cleaned = cleaned
        .replace(/📄/g, '')
        .replace(/📁/g, '')
        .replace(/🔧/g, '')
        .replace(/⭐/g, '')
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')  // Miscellaneous symbols/pictographs
        .replace(/[\u{2600}-\u{26FF}]/gu, '')    // Misc symbols  
        .replace(/[\u{2700}-\u{27BF}]/gu, '');   // Dingbats
    
    // Remove other formatting
    cleaned = cleaned
        .replace(/^[\s*\-•]+/, '')            // Leading whitespace, bullets
        .replace(/^.*\//, '')                  // Path prefixes
        .replace(/`/g, '')                     // Backticks
        .replace(/^\s+|\s+$/g, '');            // Trim
    
    return cleaned || 'unknown';
}

/**
 * Format extracted facts into the standard template
 * This is deterministic - always produces correct format
 * @param {string} originalQuery - Original query for determining which sections to show
 */
function formatFactsToTemplate(facts, subQuestions, relatedFiles, functionsFound, rawFindings, originalQuery = '') {
    
    let output = '';
    
    // Determine if this is a "trace/explain" type query that benefits from call graph
    const queryLower = originalQuery.toLowerCase();
    const showCallGraph = queryLower.includes('explain') || 
                          queryLower.includes('how') ||
                          queryLower.includes('trace') ||
                          queryLower.includes('implement') ||
                          queryLower.includes('call') ||
                          queryLower.includes('flow') ||
                          queryLower.includes('where') ||
                          subQuestions.some(sq => /explain|how|trace|implement|call|flow/i.test(sq));
    
    // === Direct Answers ===
    output += `## 💬 Direct Answers\n\n`;
    if (facts.answers && facts.answers.length > 0) {
        facts.answers.forEach((ans, idx) => {
            const refs = ans.references?.length > 0 ? ` (${ans.references.join(', ')})` : '';
            output += `**Q${idx + 1}: ${ans.question || subQuestions[idx] || 'Question ' + (idx + 1)}**\n`;
            output += `> ${ans.answer}${refs}\n\n`;
        });
    } else {
        subQuestions.forEach((sq, idx) => {
            output += `**Q${idx + 1}: ${sq}**\n`;
            output += `> See analysis below for details.\n\n`;
        });
    }
    
    output += `---\n\n`;
    
    // === Quick Summary ===
    output += `## 🚀 Quick Summary\n\n`;
    output += `> ${facts.summary || 'This code implements the requested functionality.'}\n>\n`;
    
    // Check for valid entry point (not placeholder, unknown, or null after validation)
    const entryFn = facts.entry_point?.function || '';
    const isValidEntryPoint = facts.entry_point && entryFn && 
        entryFn !== 'unknown' && 
        entryFn !== 'main_function_name' &&  // JSON template placeholder
        entryFn !== 'entry_function' &&      // JSON template placeholder
        entryFn !== 'actual_function_name_from_findings' &&  // JSON template placeholder
        !entryFn.includes('unknown');
    
    if (isValidEntryPoint) {
        const entryFile = cleanFileName(facts.entry_point.file);
        output += `> **Entry Point:** \`${entryFn}()\` in \`${entryFile}:${facts.entry_point.line}\`\n\n`;
    } else {
        // Try to find real entry points from call graph for the key files
        const realEntryPoints = findRealEntryPoints(facts.key_files, facts.key_functions);
        
        if (realEntryPoints.length === 1) {
            const ep = realEntryPoints[0];
            output += `> **Entry Point:** \`${ep.name}()\` in \`${ep.file}:${ep.line}\`\n\n`;
        } else if (realEntryPoints.length > 1) {
            output += `> **Entry Points:** Multiple functions serve as entry points - see Key Functions below\n\n`;
        } else if (facts.key_functions && facts.key_functions.length > 0) {
            // Fall back to first key function
            const firstFn = facts.key_functions[0];
            const firstFile = cleanFileName(firstFn.file);
            output += `> **Primary Function:** \`${firstFn.name}()\` in \`${firstFile}:${firstFn.line}\`\n\n`;
        } else {
            output += `> **Entry Point:** See Key Functions below\n\n`;
        }
    }
    
    output += `---\n\n`;
    
    // === Key Files ===
    output += `## 📁 Key Files\n\n`;
    output += `| File | Purpose | Key Functions |\n`;
    output += `|:-----|:--------|:--------------|\n`;
    if (facts.key_files && facts.key_files.length > 0) {
        // Filter out build/config files that shouldn't be in key_files
        const BUILD_FILES_PATTERN = /^(makefile|gnumakefile|meson\.build|cmakelists\.txt|readme|readme\.md|changelog|license|configure\.ac|configure\.in)$/i;
        const filteredFiles = facts.key_files.filter(f => {
            const fileName = cleanFileName(f.file || '').toLowerCase();
            return !BUILD_FILES_PATTERN.test(fileName);
        });
        
        (filteredFiles.length > 0 ? filteredFiles : facts.key_files).slice(0, 10).forEach(f => {
            const funcs = f.functions?.slice(0, 4).map(fn => `\`${fn}()\``).join(', ') || '-';
            const rawFile = f.file || 'unknown';
            const file = cleanFileName(rawFile);
            // Debug: log if there's a mismatch suggesting emoji wasn't removed
            if (rawFile !== file && rawFile.length > file.length + 2) {
                log(`cleanFileName: "${rawFile}" -> "${file}"`);
            }
            // Add emoji prefix after cleaning to ensure consistent display
            output += `| 📄 \`${file}\` | ${f.purpose || '-'} | ${funcs} |\n`;
        });
    } else {
        output += `| - | No files identified | - |\n`;
    }
    
    output += `\n---\n\n`;
    
    // === Code Flow ===
    output += `## 🔄 Code Flow\n\n`;
    output += `\`\`\`\n`;
    if (facts.code_flow && facts.code_flow.length > 0) {
        // Build tree structure from call relationships
        const firstCall = facts.code_flow[0];
        const firstFile = cleanFileName(firstCall.file);
        output += `1. ${firstCall.caller}()   [${firstFile}:${firstCall.line}]   → ${firstCall.purpose || 'Entry point'}\n`;
        output += `   │\n`;
        
        facts.code_flow.slice(0, 6).forEach((call, idx) => {
            if (idx === 0) return; // Skip first (already shown)
            const isLast = idx === Math.min(facts.code_flow.length - 1, 5);
            const prefix = isLast ? '└─►' : '├─►';
            const callFile = cleanFileName(call.file);
            output += `   ${prefix} ${call.callee || call.caller}()   [${callFile}:${call.line}]   → ${call.purpose || 'Processing'}\n`;
            if (!isLast) output += `   │\n`;
        });
    } else {
        output += `1. [Entry function not identified]\n`;
        output += `   │\n`;
        output += `   └─► [See Key Functions below]\n`;
    }
    output += `\`\`\`\n\n`;
    
    output += `---\n\n`;
    
    // === Data Structures ===
    output += `## 📦 Data Structures\n\n`;
    if (facts.data_structures && facts.data_structures.length > 0) {
        // First show table summary
        output += `| Structure | Location | Purpose |\n`;
        output += `|:----------|:---------|:--------|\n`;
        facts.data_structures.slice(0, 8).forEach(ds => {
            const dsFile = cleanFileName(ds.file);
            output += `| \`${ds.name}\` | \`${dsFile}:${ds.line}\` | ${ds.purpose || '-'} |\n`;
        });
        output += `\n`;
        
        // Then show actual definitions for top structures
        const structsWithDefs = facts.data_structures.filter(ds => ds.definition && ds.definition.length > 20);
        if (structsWithDefs.length > 0) {
            output += `### Structure Definitions\n\n`;
            structsWithDefs.slice(0, 3).forEach(ds => {
                const dsFile = cleanFileName(ds.file);
                output += `#### \`${ds.name}\` - \`${dsFile}:${ds.line}\`\n\n`;
                output += `\`\`\`c\n${ds.definition}\n\`\`\`\n\n`;
                if (ds.key_fields && ds.key_fields.length > 0) {
                    output += `**Key Fields:**\n`;
                    ds.key_fields.forEach(field => {
                        output += `- ${field}\n`;
                    });
                    output += `\n`;
                }
            });
        }
    } else {
        output += `| Structure | Location | Purpose |\n`;
        output += `|:----------|:---------|:--------|\n`;
        output += `| - | No structures identified | See code analysis |\n`;
    }
    
    output += `\n---\n\n`;
    
    // === Key Functions ===
    output += `## 🔍 Key Functions\n\n`;
    if (facts.key_functions && facts.key_functions.length > 0) {
        // First show table summary
        output += `| Function | Location | Purpose |\n`;
        output += `|:---------|:---------|:--------|\n`;
        facts.key_functions.slice(0, 10).forEach(fn => {
            const fnFile = cleanFileName(fn.file);
            output += `| \`${fn.name}()\` | \`${fnFile}:${fn.line}\` | ${fn.purpose || '-'} |\n`;
        });
        output += `\n`;
        
        // Then show details for top functions with code
        const funcsWithCode = facts.key_functions.filter(fn => 
            (fn.signature && fn.signature.length > 5) || (fn.key_code && fn.key_code.length > 10)
        );
        if (funcsWithCode.length > 0) {
            output += `### Function Details\n\n`;
            funcsWithCode.slice(0, 5).forEach(fn => {
                const fnFile = cleanFileName(fn.file);
                output += `#### \`${fn.name}()\` - \`${fnFile}:${fn.line}\`\n\n`;
                if (fn.signature) {
                    output += `**Signature:** \`${fn.signature}\`\n\n`;
                }
                if (fn.key_code) {
                    output += `**Key Logic:**\n\`\`\`c\n${fn.key_code}\n\`\`\`\n\n`;
                }
                output += `**Purpose:** ${fn.purpose || 'See code for details'}\n\n`;
            });
        }
    } else {
        output += `| Function | Location | Purpose |\n`;
        output += `|:---------|:---------|:--------|\n`;
        output += `| - | No functions identified | See code analysis |\n`;
    }
    
    output += `\n---\n\n`;
    
    // === Call Graph (from index, not LLM) ===
    // Only show for explain/trace type queries when we have data
    if (showCallGraph && facts.key_functions && facts.key_functions.length > 0 && codeIndex.symbols.size > 0) {
        const callGraphData = [];
        
        // Trace top 3 key functions
        for (const fn of facts.key_functions.slice(0, 3)) {
            const fnName = fn.name?.replace(/\(\)$/, ''); // Remove trailing ()
            if (!fnName) continue;
            
            const trace = traceSymbol(fnName);
            if (trace.callers.length > 0 || trace.callees.length > 0) {
                callGraphData.push({
                    name: fnName,
                    file: cleanFileName(fn.file),
                    line: fn.line,
                    callers: trace.callers.slice(0, 5).map(c => ({
                        name: c.name,
                        file: cleanFileName(c.file),
                        line: c.line
                    })),
                    callees: trace.callees.slice(0, 5).map(c => ({
                        name: c.name,
                        file: cleanFileName(c.file),
                        line: c.line
                    }))
                });
            }
        }
        
        if (callGraphData.length > 0) {
            output += `## 📞 Call Graph\n\n`;
            output += `*Showing callers (who invokes) and callees (what it calls) for key functions:*\n\n`;
            
            for (const fn of callGraphData) {
                output += `**\`${fn.name}()\`** in \`${fn.file}:${fn.line}\`\n`;
                
                if (fn.callers.length > 0) {
                    output += `├── **Called by:** `;
                    output += fn.callers.map(c => `\`${c.name}()\``).join(', ');
                    output += `\n`;
                }
                
                if (fn.callees.length > 0) {
                    const prefix = fn.callers.length > 0 ? '└──' : '├──';
                    output += `${prefix} **Calls:** `;
                    output += fn.callees.map(c => `\`${c.name}()\``).join(', ');
                    output += `\n`;
                }
                
                if (fn.callers.length === 0 && fn.callees.length === 0) {
                    output += `└── *No call relationships found in index*\n`;
                }
                
                output += `\n`;
            }
            
            output += `---\n\n`;
        }
    }
    
    // === Configurability ===
    output += `## 🔧 Configurability\n\n`;
    if (facts.config_options && facts.config_options.length > 0) {
        output += `| Parameter | Values | Effect |\n`;
        output += `|:----------|:-------|:-------|\n`;
        facts.config_options.slice(0, 6).forEach(opt => {
            const values = Array.isArray(opt.values) ? opt.values.join(', ') : opt.values || '-';
            output += `| \`${opt.param}\` | ${values} | ${opt.effect || '-'} |\n`;
        });
    } else {
        output += `No configurable parameters identified in the analyzed code.\n`;
    }
    
    output += `\n---\n\n`;
    
    // === Where to Start ===
    output += `## 🎯 Where to Start\n\n`;
    output += `**To understand this feature:**\n`;
    if (facts.key_files && facts.key_files.length > 0) {
        const file1 = cleanFileName(facts.key_files[0].file);
        output += `1. Start with 📄 \`${file1}\` - ${facts.key_files[0].purpose || 'Main implementation'}\n`;
        if (facts.key_files.length > 1) {
            const file2 = cleanFileName(facts.key_files[1].file);
            output += `2. Then read 📄 \`${file2}\` - ${facts.key_files[1].purpose || 'Supporting code'}\n`;
        }
    } else {
        output += `1. Review the key functions listed above\n`;
    }
    
    // Use valid entry point or first key function for debug tip
    const debugFn = isValidEntryPoint ? facts.entry_point.function : 
        (facts.key_functions?.[0]?.name || null);
    if (debugFn) {
        output += `3. Debug tip: Set breakpoint in \`${debugFn}()\`\n`;
    }
    output += `\n`;
    
    output += `**To modify this feature:**\n`;
    if (facts.key_functions && facts.key_functions.length > 0) {
        const mainFn = facts.key_functions[0];
        const mainFile = cleanFileName(mainFn.file);
        output += `- Change core behavior → Edit \`${mainFn.name}()\` in 📄 \`${mainFile}\`\n`;
    }
    if (facts.config_options && facts.config_options.length > 0) {
        output += `- Add new option → Follow pattern of \`${facts.config_options[0].param}\`\n`;
    }
    
    output += `\n---\n\n`;
    
    // === Related Topics ===
    output += `## 📚 Related Topics (For Further Exploration)\n\n`;
    
    // Only show related files if we have specific relevance info, otherwise skip this section
    if (relatedFiles && relatedFiles.length > 0) {
        // Filter to only show files that are likely relevant based on naming
        const relevantFiles = relatedFiles.filter(f => {
            const fileName = cleanFileName(f).toLowerCase();
            // Only include if filename contains keywords from the query/topic
            return facts.key_functions?.some(kf => 
                fileName.includes(kf.name?.toLowerCase()?.substring(0, 5) || '')
            ) || false;
        });
        
        if (relevantFiles.length > 0) {
            output += `**Related Files (likely relevant based on naming):**\n`;
            relevantFiles.slice(0, 5).forEach(f => {
                const file = cleanFileName(f);
                output += `- 📄 \`${file}\`\n`;
            });
            output += `\n`;
        }
        // Don't show "may contain" for files we're not sure about
    }
    
    if (functionsFound && functionsFound.length > 0) {
        output += `**Related Functions to Explore:**\n`;
        output += functionsFound.slice(0, 10).map(f => `\`${f}()\``).join(', ') + `\n\n`;
    }
    
    output += `**Suggested Next Questions:**\n`;
    if (facts.key_functions && facts.key_functions.length > 0) {
        output += `- "How does \`${facts.key_functions[0].name}()\` work in detail?"\n`;
    }
    // Use valid entry point or first key function for suggested question
    const suggestFn = isValidEntryPoint ? facts.entry_point.function : 
        (facts.key_functions?.[0]?.name || null);
    if (suggestFn) {
        output += `- "What calls \`${suggestFn}()\`?"\n`;
    }
    output += `- "Show me the data flow for this operation"\n`;
    output += `- "Find potential bugs in this code"\n`;
    
    output += `\n---\n\n`;
    
    // === Notes ===
    output += `## ⚠️ Notes\n\n`;
    if (facts.notes && facts.notes.length > 0) {
        facts.notes.forEach(note => {
            output += `- ${note}\n`;
        });
    } else {
        output += `- Analysis based on code files in context\n`;
    }
    // Remove weak "may require deeper investigation" language
    
    // === Detailed Technical Analysis ===
    // Include the raw analysis for developers who want the full details
    if (rawFindings && rawFindings.length > 500) {
        output += `\n---\n\n`;
        output += `## 📝 Detailed Technical Analysis\n\n`;
        output += `<details>\n<summary>Click to expand full analysis (${Math.round(rawFindings.length / 1000)}KB)</summary>\n\n`;
        
        // Truncate if very large, but keep substantial detail
        const maxDetailLength = 15000;
        if (rawFindings.length > maxDetailLength) {
            output += rawFindings.substring(0, maxDetailLength);
            output += `\n\n*[Analysis truncated - ${Math.round((rawFindings.length - maxDetailLength) / 1000)}KB omitted]*\n`;
        } else {
            output += rawFindings;
        }
        
        output += `\n</details>\n`;
    }
    
    return output;
}


/**
 * Process answer directly (when context fits in single call)
 * Uses TWO-STAGE generation for consistent formatting
 */
async function processAnswerDirect(question, context, domain, domain_notes) {
    // Decompose question into sub-questions
    const subQuestions = decomposeQuestion(question);
    log('processAnswerDirect: Sub-questions:', subQuestions);
    
    // VERBOSE: Show which code path we're in
    if (AGENT_CONFIG.verboseSearch) {
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n**🔧 Debug: Using processAnswerDirect (context ${Math.round((context?.length || 0)/1024)}KB)**\n\n`
        });
    }
    
    // ================================================================
    // STAGE 1: EXTRACT STRUCTURED FACTS
    // ================================================================
    let extractionPrompt = '';
    
    if (domain || domain_notes) {
        extractionPrompt += `# Domain: ${domain || 'Code Analysis'}\n`;
        if (domain_notes) extractionPrompt += `Notes: ${domain_notes}\n`;
        extractionPrompt += '\n';
    }
    
    // Truncate context if needed (API limit ~25K chars)
    const MAX_CONTEXT = 12000;
    let truncatedContext = context;
    if (context && context.length > MAX_CONTEXT) {
        log(`processAnswerDirect: Truncating context from ${context.length} to ${MAX_CONTEXT}`);
        truncatedContext = context.substring(0, MAX_CONTEXT) + '\n\n[... truncated ...]';
    }
    
    if (truncatedContext) {
        extractionPrompt += `# SOURCE CODE\n${truncatedContext}\n\n`;
    }
    
    extractionPrompt += `# ORIGINAL QUESTION\n${question}\n\n`;
    extractionPrompt += `# SUB-QUESTIONS\n${subQuestions.map((sq, idx) => `${idx + 1}. ${sq}`).join('\n')}\n\n`;
    
    extractionPrompt += `# TASK
Extract structured facts from the code above. Output ONLY valid JSON with this exact structure:

{
  "summary": "2-3 sentences describing what this code does and its main purpose",
  "entry_point": {
    "function": "main_function_name",
    "file": "filename.c",
    "line": 123
  },
  "answers": [
    {
      "question": "The sub-question text",
      "answer": "Detailed answer (2-4 sentences) with specific function names, patterns, and code references",
      "references": ["file.c:123", "other.c:456"]
    }
  ],
  "key_files": [
    {
      "file": "filename.c",
      "purpose": "Detailed purpose (1-2 sentences) explaining what this file does",
      "functions": ["func1", "func2", "func3"]
    }
  ],
  "code_flow": [
    {
      "caller": "entry_function",
      "callee": "called_function", 
      "file": "file.c",
      "line": 100,
      "purpose": "Why this call happens"
    }
  ],
  "data_structures": [
    {
      "name": "StructName",
      "file": "header.h",
      "line": 50,
      "purpose": "What data it holds"
    }
  ],
  "key_functions": [
    {
      "name": "function_name",
      "file": "file.c",
      "line": 200,
      "purpose": "What it does"
    }
  ],
  "config_options": [
    {
      "param": "parameter_name",
      "values": ["value1", "value2"],
      "effect": "What it controls"
    }
  ],
  "notes": [
    "Any limitations or areas needing more investigation"
  ]
}

CRITICAL RULES:
1. Output ONLY valid JSON - no markdown, no explanation, no text before or after the JSON
2. Start your response with { and end with }
3. Extract ACTUAL data from the code - use real line numbers from the context
4. Include at least 3-5 items in key_files, key_functions, and code_flow
5. For key_files: PRIORITIZE files whose names contain the query topic (e.g., for "partitioning", include partdesc.c, partbounds.c, partprune.c BEFORE generic files)
6. For key_files: Include BOTH implementation files (.c/.cpp/.java) AND header files (.h/.hpp) when relevant
7. If a field has no data, use empty array []
8. Do NOT wrap JSON in \`\`\` code fences

BEGIN JSON OUTPUT:`;
    
    log('processAnswerDirect: Stage 1 - Extracting facts, prompt length:', extractionPrompt.length);
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `*Stage 1: Extracting structured facts...*\n`
    });
    
    const extractionResult = await callLanguageModel(extractionPrompt);
    
    // VERBOSE: Show what LLM returned
    if (AGENT_CONFIG.verboseSearch) {
        const preview = extractionResult?.substring(0, 300).replace(/\n/g, '\\n') || 'null';
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n**🔧 Debug: LLM returned (first 300 chars):**\n\`\`\`\n${preview}\n\`\`\`\n\n`
        });
    }
    
    // Parse JSON from response
    let facts;
    let jsonParsed = false;
    try {
        // Clean up response - remove markdown code fences if present
        let jsonStr = extractionResult.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }
        // Also try to find JSON object in the response
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }
        facts = JSON.parse(jsonStr);
        jsonParsed = true;
        log('processAnswerDirect: Successfully parsed facts JSON');
    } catch (parseErr) {
        log('processAnswerDirect: JSON parse error:', parseErr.message);
        log('processAnswerDirect: Raw response (first 500):', extractionResult?.substring(0, 500));
        
        // VERBOSE: Show parse error
        if (AGENT_CONFIG.verboseSearch) {
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n**⚠️ JSON Parse Error:** ${parseErr.message}\n**Falling back to defaults**\n\n`
            });
        }
        
        // Fallback: use defaults
        facts = {
            summary: "Analysis of the provided code",
            entry_point: null,  // Don't fabricate an entry point
            answers: subQuestions.map(sq => ({ question: sq, answer: "See code analysis below", references: [] })),
            key_files: [],
            code_flow: [],
            data_structures: [],
            key_functions: [],
            config_options: [],
            notes: ["Structured extraction encountered issues - content may be incomplete"]
        };
    }
    
    // VERBOSE: Show parsed facts summary
    if (AGENT_CONFIG.verboseSearch) {
        const factsSummary = `**📊 Extracted Facts (JSON parsed: ${jsonParsed}):**
- Summary: ${facts.summary?.substring(0, 50) || 'none'}...
- Entry point: \`${facts.entry_point?.function || 'none'}()\`
- Key files: ${facts.key_files?.length || 0}
- Code flow: ${facts.code_flow?.length || 0} relationships
- Data structures: ${facts.data_structures?.length || 0}
- Key functions: ${facts.key_functions?.length || 0}
- Config options: ${facts.config_options?.length || 0}
`;
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: factsSummary + '\n---\n\n'
        });
    }
    
    // ================================================================
    // STAGE 2: FORMAT INTO TEMPLATE (Deterministic)
    // ================================================================
    log('processAnswerDirect: Stage 2 - Formatting into template');
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `*Stage 2: Formatting structured response...*\n\n`
    });
    
    const formatted = formatFactsToTemplate(facts, subQuestions, [], [], context, question);
    
    // Validate answer if enabled
    if (AGENT_CONFIG.enableJudge) {
        log('processAnswerDirect: Running judge validation');
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n*Validating response...*\n`
        });
        
        // Give judge access to ALL context files for thorough validation
        let fullContext = '';
        for (const [path, file] of contextFiles) {
            const fileName = path.split('/').pop();
            fullContext += `### ${fileName}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
        }
        
        const validatedResult = await validateAndRefineAnswer(question, formatted, fullContext || context);
        return { success: true, data: { answer: validatedResult } };
    }
    
    return { success: true, data: { answer: formatted } };
}

/**
 * Get a summary of all available tools for the planner
 */
function getToolsSummary() {
    let summary = '## Available Tools\n\n';
    for (const [name, tool] of Object.entries(AGENT_TOOLS)) {
        summary += `- **${name}**: ${tool.description}\n`;
        if (Object.keys(tool.parameters).length > 0) {
            summary += `  Parameters: ${JSON.stringify(tool.parameters)}\n`;
        }
    }
    return summary;
}

/**
 * Get a summary of available resources
 */
function getResourcesSummary() {
    let summary = '## Available Resources\n\n';
    
    // Context files
    if (contextFiles.size > 0) {
        summary += '### Context Files (attached)\n';
        for (const [path, file] of contextFiles) {
            const name = path.split('/').pop();
            summary += `- ${name} (${file.language}, ${Math.round(file.content.length/1024)}KB, ${file.content.split('\n').length} lines)\n`;
        }
        summary += '\n';
    } else {
        summary += '### Context Files: None attached\n\n';
    }
    
    // Code index
    if (codeIndex.symbols.size > 0) {
        summary += `### Code Index\n`;
        summary += `- ${codeIndex.symbols.size} symbols indexed\n`;
        summary += `- ${codeIndex.files.size} files parsed\n`;
        summary += `- ${codeIndex.callGraph.size} call relationships\n\n`;
    }
    
    // API server (we'll check this during execution)
    summary += '### API Server: May be available at configured URL\n';
    
    return summary;
}

/**
 * ============================================================
 * QUERY ANALYSIS FRAMEWORK
 * ============================================================
 * Systematically analyzes developer queries before execution:
 * 1. PARSE: Extract task type, target, scope
 * 2. VALIDATE: Check if targets exist in context/index
 * 3. SELECT: Choose appropriate tool based on task
 * 4. RETURN: Structured analysis for planner
 */

/**
 * Analyze a developer query and extract structured information
 * @param {string} query - The user's query
 * @returns {Object} Structured query analysis
 */
function analyzeQuery(query) {
    const analysis = {
        originalQuery: query,
        taskType: null,        // EXPLAIN | REVIEW | SEARCH | TRACE | GENERATE | TRANSLATE | DOCUMENT | COMPARE
        target: {
            type: null,        // file | function | concept | codebase
            value: null,       // The actual target (filename, function name, etc.)
            exists: false,     // Whether target was found in context/index
            path: null         // Full path if found
        },
        scope: 'focused',      // focused | broad | comprehensive
        suggestedTool: null,   // The tool that should be used
        keywords: [],          // Extracted search keywords (task words removed)
        confidence: 'high'     // high | medium | low
    };
    
    const queryLower = query.toLowerCase();
    
    // ================================================================
    // STEP 1: IDENTIFY TASK TYPE
    // ================================================================
    const taskPatterns = [
        // REVIEW: Must have bug/issue/problem context
        { type: 'REVIEW', patterns: [
            /\b(identify|find|check|detect)\s*(bugs?|issues?|problems?|errors?|vulnerabilities)/i, 
            /\breview\s+\w+\.(c|h|cpp|py|js|java)/i, 
            /\b(bug|issue|problem)\s+in\b/i
        ] },
        // EXPLAIN: Understanding/describing code
        { type: 'EXPLAIN', patterns: [
            /\b(explain|describe|what\s+is|what\s+does|how\s+does|how\s+is.*implemented)\b/i, 
            /\btell\s+me\s+about\b/i
        ] },
        // TRACE: Following execution flow
        { type: 'TRACE', patterns: [
            /\b(trace|flow|call\s*graph|what\s+calls|calls\s+what|execution\s+path)\b/i
        ] },
        // SEARCH: Finding code - includes "identify code", "find code", "show me", etc.
        { type: 'SEARCH', patterns: [
            /\b(show\s+me|find|list|where\s+is|locate|search\s+for)\b/i, 
            /\ball\s+(functions?|classes?|files?|symbols?)\b/i,
            /\b(identify|find)\s+(code|function|class|the\s+code|implementation)\b/i,  // "identify code", "find the code"
            /\bcode\s+that\s+(handles?|implements?|processes?|manages?)\b/i  // "code that handles X"
        ] },
        // GENERATE: Creating new code
        { type: 'GENERATE', patterns: [
            /\b(create|write|generate|make|implement)\s+(a|an|the|new)?\s*(function|class|code|test)/i
        ] },
        // TRANSLATE: Converting between languages
        { type: 'TRANSLATE', patterns: [
            /\b(translate|convert|port|transform)\s+(this|these|to)\b/i
        ] },
        // DOCUMENT: Generating documentation
        { type: 'DOCUMENT', patterns: [
            /\b(document|generate\s+docs?|create\s+documentation)\b/i
        ] },
        // COMPARE: Comparing code/implementations
        { type: 'COMPARE', patterns: [
            /\b(compare|difference|vs|versus|between)\b/i
        ] }
    ];
    
    for (const { type, patterns } of taskPatterns) {
        for (const pattern of patterns) {
            if (pattern.test(query)) {
                analysis.taskType = type;
                break;
            }
        }
        if (analysis.taskType) break;
    }
    
    // Default to EXPLAIN if no task type detected
    if (!analysis.taskType) {
        analysis.taskType = 'EXPLAIN';
        analysis.confidence = 'medium';
    }
    
    log('analyzeQuery: Task type:', analysis.taskType);
    
    // ================================================================
    // STEP 2: EXTRACT AND VALIDATE TARGET
    // ================================================================
    
    // Check for specific file mentioned
    const fileMatch = query.match(/\b([\w-]+\.(?:c|h|cpp|hpp|java|py|js|ts|go|rs|rb|sql|tal|cob|cbl|json|xml|yaml|yml))\b/i);
    if (fileMatch) {
        const fileName = fileMatch[1];
        analysis.target.type = 'file';
        analysis.target.value = fileName;
        
        // Validate: Check if file exists in context
        for (const [path, file] of contextFiles) {
            const pathFileName = path.split('/').pop();
            if (pathFileName.toLowerCase() === fileName.toLowerCase()) {
                analysis.target.exists = true;
                analysis.target.path = path;
                break;
            }
        }
        
        log('analyzeQuery: File target:', fileName, 'exists:', analysis.target.exists);
    }
    
    // Check for specific function mentioned (if no file found)
    if (!analysis.target.value) {
        // Look for function-like patterns: functionName(), function_name, FunctionName
        const funcPatterns = [
            /\b(?:function|method|proc|procedure)\s+(\w+)/i,
            /\b(\w+)\s*\(\s*\)/,  // name()
            /\bthe\s+(\w+)\s+function\b/i,
            /\b(\w{3,})\s+(?:function|method)\b/i
        ];
        
        for (const pattern of funcPatterns) {
            const match = query.match(pattern);
            if (match && match[1] && match[1].length > 2) {
                const funcName = match[1];
                // Skip common words
                if (!['the', 'this', 'that', 'and', 'for', 'how', 'what'].includes(funcName.toLowerCase())) {
                    analysis.target.type = 'function';
                    analysis.target.value = funcName;
                    
                    // Validate: Check if function exists in index
                    if (codeIndex.symbols.has(funcName)) {
                        analysis.target.exists = true;
                        const sym = codeIndex.symbols.get(funcName);
                        analysis.target.path = sym.file;
                    } else {
                        // Try partial match
                        for (const [key, sym] of codeIndex.symbols) {
                            if (sym.name.toLowerCase() === funcName.toLowerCase()) {
                                analysis.target.exists = true;
                                analysis.target.path = sym.file;
                                analysis.target.value = sym.name; // Use correct casing
                                break;
                            }
                        }
                    }
                    
                    log('analyzeQuery: Function target:', funcName, 'exists:', analysis.target.exists);
                    break;
                }
            }
        }
    }
    
    // If still no target, it's a concept-based query
    if (!analysis.target.value) {
        analysis.target.type = 'concept';
        // Extract the main concept from query
        const keywords = extractSearchKeywords(query);
        analysis.target.value = keywords.slice(0, 3).join(' ');
        analysis.keywords = keywords;
        
        log('analyzeQuery: Concept target:', analysis.target.value);
    } else {
        analysis.keywords = extractSearchKeywords(query);
    }
    
    // ================================================================
    // STEP 3: DETERMINE SCOPE
    // ================================================================
    if (/\ball\b|\bevery\b|\bentire\b|\bwhole\b|\bcomprehensive\b/i.test(query)) {
        analysis.scope = 'comprehensive';
    } else if (/\bhigh.?level\b|\boverview\b|\bsummary\b|\bbrief\b/i.test(query)) {
        analysis.scope = 'broad';
    } else {
        analysis.scope = 'focused';
    }
    
    // ================================================================
    // STEP 4: SELECT SUGGESTED TOOL
    // ================================================================
    const toolMap = {
        'REVIEW': {
            'file': 'review_file',
            'function': 'review_code',
            'concept': 'review_code'
        },
        'EXPLAIN': {
            'file': 'search_code',  // Search file then explain
            'function': 'get_function_context',
            'concept': 'search_code'
        },
        'TRACE': {
            'file': 'search_code',
            'function': 'get_function_context',  // Includes call graph
            'concept': 'search_code'
        },
        'SEARCH': {
            'file': 'search_index',
            'function': 'search_index',
            'concept': 'search_code'
        },
        'GENERATE': {
            'file': 'generate_code',
            'function': 'generate_code',
            'concept': 'generate_code'
        },
        'TRANSLATE': {
            'file': 'translate_all_files',
            'function': 'translate_all_files',
            'concept': 'translate_all_files'
        },
        'DOCUMENT': {
            'file': 'generate_full_documentation',
            'function': 'document_code',
            'concept': 'generate_full_documentation'
        },
        'COMPARE': {
            'file': 'search_code',
            'function': 'search_code',
            'concept': 'search_code'
        }
    };
    
    analysis.suggestedTool = toolMap[analysis.taskType]?.[analysis.target.type] || 'search_code';
    
    log('analyzeQuery: Complete analysis:', JSON.stringify({
        taskType: analysis.taskType,
        targetType: analysis.target.type,
        targetValue: analysis.target.value,
        targetExists: analysis.target.exists,
        suggestedTool: analysis.suggestedTool,
        scope: analysis.scope
    }));
    
    return analysis;
}

/**
 * Format query analysis for planner prompt
 */
function formatQueryAnalysis(analysis) {
    let formatted = `## Query Analysis (Pre-processed)
**Task Type:** ${analysis.taskType}
**Target:** ${analysis.target.type} → "${analysis.target.value}"
**Target Found:** ${analysis.target.exists ? '✓ Yes' : '✗ No'} ${analysis.target.path ? `(${analysis.target.path})` : ''}
**Scope:** ${analysis.scope}
**Suggested Tool:** ${analysis.suggestedTool}
**Keywords:** ${analysis.keywords.join(', ')}
**Confidence:** ${analysis.confidence}

`;
    
    // Add warnings/guidance
    if (!analysis.target.exists && analysis.target.type === 'file') {
        formatted += `⚠️ WARNING: File "${analysis.target.value}" not found in context. May need to search or ask user.\n`;
    }
    if (!analysis.target.exists && analysis.target.type === 'function') {
        formatted += `⚠️ WARNING: Function "${analysis.target.value}" not found in index. May need fuzzy search.\n`;
    }
    
    return formatted;
}

/**
 * PLANNER: Uses LLM to create an execution plan
 */
async function createExecutionPlan(query, conversationHistory = []) {
    log('PLANNER: Creating execution plan for:', query);
    
    // ================================================================
    // STEP 0: ANALYZE QUERY FIRST
    // ================================================================
    const queryAnalysis = analyzeQuery(query);
    const analysisContext = formatQueryAnalysis(queryAnalysis);
    
    const toolsSummary = getToolsSummary();
    const resourcesSummary = getResourcesSummary();
    
    // Get discovered domain from indexed code
    const domainContext = getDomainContext();
    
    // Include recent conversation context
    let conversationContext = '';
    if (conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-4);
        conversationContext = '## Recent Conversation\n';
        for (const msg of recentHistory) {
            conversationContext += `${msg.role}: ${msg.content.substring(0, 500)}...\n`;
        }
        conversationContext += '\n';
    }
    
    const plannerPrompt = `You are an intelligent task planner for a code assistant called AstraCode.

# USER REQUEST
"${query}"

${analysisContext}
${conversationContext}
${domainContext}
${resourcesSummary}
${toolsSummary}

# YOUR TASK
Use the Query Analysis above to create the execution plan. The analysis has already:
1. Identified the TASK TYPE (${queryAnalysis.taskType})
2. Extracted the TARGET (${queryAnalysis.target.type}: ${queryAnalysis.target.value})
3. Validated if target exists (${queryAnalysis.target.exists})
4. Suggested the tool (${queryAnalysis.suggestedTool})

Your job is to confirm or adjust this analysis and create the step-by-step plan.

# MANDATORY TOOL MAPPINGS (FOLLOW THESE EXACTLY)
Based on TASK TYPE, you MUST use these tools:

| Task Type | Target Type | REQUIRED Tool |
|-----------|-------------|---------------|
| REVIEW    | file        | review_file   |
| REVIEW    | function    | review_code   |
| EXPLAIN   | file        | search_code → answer_question |
| EXPLAIN   | function    | get_function_context → answer_question |
| TRACE     | any         | search_code → answer_question |
| SEARCH    | any         | search_code or search_index |

⚠️ CRITICAL: When taskType is REVIEW, you MUST use review_file or review_code - NEVER use answer_question for bug finding!

# IMPORTANT RULES
1. If target is a SPECIFIC FILE that EXISTS → use the suggested tool directly on that file
2. If target is a SPECIFIC FUNCTION → use get_function_context to get its code first
3. If target is a CONCEPT → use search_code to find relevant code first
4. NEVER search for task words like "identify", "bugs", "review" - search for TARGET words only
5. USE the suggested tool from Query Analysis unless you have a good reason not to

# PLANNING GUIDELINES

## CLARIFICATION (when needed)
If the query is AMBIGUOUS and could mean different things, return a plan with:
- "needs_clarification": true
- "clarification_question": "Your specific question to user"
- "options": ["Option A description", "Option B description", ...]

Example clarification response:
{
  "needs_clarification": true,
  "clarification_question": "When you say 'show me the parser', do you mean:",
  "options": ["The SQL parser (parsing SQL queries)", "The command parser (parsing user commands)", "All parser-related code"],
  "domain": "unknown - needs clarification"
}

## TOOL SELECTION RULES
- For "how is X implemented", "explain X", "describe X functionality", "trace X":
  USE search_code (combines fuzzy index + trigram) → answer_question
  This is the PREFERRED approach for implementation questions.
  
- For "show me all X implementing Y", "list functions/classes for X":
  USE search_index with pattern=Y → then answer_question
  IMPORTANT: search_index will prioritize FILES and SYMBOLS with Y in the NAME

- For specific function questions ("explain function Y"): 
  USE get_function_context → answer_question
  
- For "list all X functions", "find functions related to Y":
  USE search_index → answer_question

- For "identify bugs", "find issues", "review X.c", "check for problems", "find bugs in X":
  ⚠️ MUST USE review_file with fileName=X.c → returns structured bug report
  This is REQUIRED for bug identification on specific files
  DO NOT use answer_question for bug finding!

- For general code review (no specific file): use review_code
- For simple questions like "what is X": use answer_question with context="$context"
- For documentation: use generate_full_documentation  
- For translations ("translate to X", "convert to X"): 
  USE translate_all_files - translates ALL attached files preserving symbols and decimal precision
- For new code: use generate_code

CRITICAL: When user has attached code files, the answer MUST reference the actual code with file names and line numbers. Do NOT give generic explanations.

# PARAMETER REFERENCE FORMAT
- "$context" = all attached files content
- "$step1.data" = full result object from step 1
- "$step1.data.combinedContext" = combined context from search_code (PREFERRED for implementation questions)
- "$step1.data.results" = results array from step 1 (for grep results)
- "$step1.data.symbols" = symbols array from search_index
- "$step1.data.code" = code from get_function_context

# EXAMPLES

Example 1 - Implementation tracing (RECOMMENDED - use search_code):
User: "describe how relation parsing is implemented"
{
  "domain": "[Inferred from attached code structure and terminology]",
  "domain_notes": "[Observations about the codebase from index analysis]",
  "understanding": "User wants to understand implementation details",
  "strategy": "Use search_code to find symbols and code, then explain",
  "steps": [
    {
      "step": 1,
      "tool": "search_code",
      "purpose": "Search for code matching the query terms",
      "parameters": { "query": "[key terms extracted from user query]" }
    },
    {
      "step": 2,
      "tool": "answer_question",
      "purpose": "Explain implementation with specific code references",
      "parameters": { 
        "question": "[Reformulated question asking for: 1) Entry points, 2) Key data structures, 3) The flow, 4) How different cases are handled]",
        "context": "$step1.data.combinedContext"
      }
    }
  ],
  "final_output": "Detailed explanation with file/line references"
}

Example 2 - Specific function deep-dive (MULTI-STEP):
User: "explain the [functionName] function"
{
  "domain": "[Inferred from code]",
  "domain_notes": "Focus on the specific function, its inputs, outputs, and call graph",
  "understanding": "User wants to understand a specific function in detail",
  "strategy": "Get the function source and call graph, then explain",
  "steps": [
    {
      "step": 1,
      "tool": "get_function_context",
      "purpose": "Get full source code and call relationships",
      "parameters": { "functionName": "[function name from query]" }
    },
    {
      "step": 2,
      "tool": "answer_question",
      "purpose": "Explain the function based on its source and call graph",
      "parameters": { 
        "question": "Explain [functionName]: 1) Purpose, 2) Parameters and return value, 3) Step-by-step logic, 4) Functions it calls and why, 5) What calls this function.",
        "context": "$step1.data"
      }
    }
  ],
  "final_output": "Detailed explanation of the function"
}

Example 3 - Find all code implementing a feature (NAME-BASED SEARCH):
User: "show me all classes and functions that implement [FEATURE]"
{
  "domain": "[Inferred from code]",
  "domain_notes": "Extract the key term from query - prioritize files/symbols with that term in NAME",
  "understanding": "User wants to find all code related to [FEATURE]",
  "strategy": "Search for files/symbols by NAME matching the key term, then gather context",
  "steps": [
    {
      "step": 1,
      "tool": "search_index",
      "purpose": "Find files and symbols with the key term in their NAME",
      "parameters": { "pattern": "[key term from query]", "type": null }
    },
    {
      "step": 2,
      "tool": "search_code", 
      "purpose": "Get detailed context for related code",
      "parameters": { "query": "[key term and related terms]" }
    },
    {
      "step": 3,
      "tool": "answer_question",
      "purpose": "List and describe all related code found",
      "parameters": { 
        "question": "List ALL files and functions that implement [FEATURE]. For each: 1) Name, 2) File location, 3) Brief purpose.",
        "context": "$step1.data\n\n$step2.data.combinedContext"
      }
    }
  ],
  "final_output": "Complete list of code implementing the feature"
}

Example 4 - List all functions matching a pattern:
User: "list all the [X] functions"
{
  "domain": "[Inferred from code]",
  "domain_notes": "Search for functions with [X] in their name",
  "understanding": "User wants to see all functions related to [X]",
  "strategy": "Search index for matching functions and summarize",
  "steps": [
    {
      "step": 1,
      "tool": "search_index",
      "purpose": "Find all matching functions",
      "parameters": { "pattern": "[pattern from query]", "type": "function" }
    },
    {
      "step": 2,
      "tool": "answer_question",
      "purpose": "Summarize the functions found",
      "parameters": { 
        "question": "List and briefly describe each function found. Group them by purpose if possible.",
        "context": "$step1.data"
      }
    }
  ],
  "final_output": "List of functions with descriptions"
}

Example 5 - Domain-specific question (use attached code context):
User: "what is [term]?"
{
  "domain": "[Inferred from attached code and the term]",
  "domain_notes": "[Any context from the indexed code about this term]",
  "understanding": "User wants to understand what [term] means in this codebase",
  "strategy": "Search the attached code for context about this term, then explain",
  "steps": [
    {
      "step": 1,
      "tool": "search_code",
      "purpose": "Find how this term is used in the attached code",
      "parameters": { "query": "[term]" }
    },
    {
      "step": 2,
      "tool": "answer_question",
      "purpose": "Explain the term based on how it's used in this codebase",
      "parameters": { 
        "question": "Based on the attached code, explain what [term] means and how it's used.", 
        "context": "$step1.data.combinedContext" 
      }
    }
  ],
  "final_output": "Explanation based on the actual code"
}

Example 6 - Bug identification in a specific file (SINGLE-STEP):
User: "identify bugs in [filename.c]" or "review [filename.c] for issues" or "find bugs in [filename.c]"
⚠️ CRITICAL: For ANY bug/issue finding request, you MUST use review_file - NEVER answer_question!
{
  "domain": "[Inferred from code]",
  "domain_notes": "User wants a code review of a specific file",
  "understanding": "User wants to find bugs/issues in [filename.c]",
  "strategy": "Use review_file to analyze the specific file for bugs",
  "steps": [
    {
      "step": 1,
      "tool": "review_file",
      "purpose": "Review the specific file for bugs and issues",
      "parameters": { "fileName": "[filename.c from query]", "focus": "bugs" }
    }
  ],
  "final_output": "Structured bug report with line numbers and recommendations"
}

Example 6b - EXACT MATCH for "find bugs in X.c":
User: "find bugs in partdesc.c"
{
  "domain": "PostgreSQL partition management",
  "understanding": "Find bugs in partdesc.c",
  "strategy": "Use review_file for bug identification",
  "steps": [
    {
      "step": 1,
      "tool": "review_file",
      "purpose": "Review partdesc.c for bugs",
      "parameters": { "fileName": "partdesc.c", "focus": "bugs" }
    }
  ],
  "final_output": "Bug report with specific issues found"
}

Example 7 - Translation (SINGLE-STEP):
User: "translate this [source language] to [target language]"
{
  "domain": "[Inferred from attached code]",
  "domain_notes": "Preserve symbols, data types, and business logic during translation",
  "understanding": "User wants to translate code to another language",
  "strategy": "Use translate_all_files to convert ALL attached files, preserving symbols and precision",
  "steps": [
    {
      "step": 1,
      "tool": "translate_all_files",
      "purpose": "Translate all attached files to target language",
      "parameters": { "targetLanguage": "[target language from query]" }
    }
  ],
  "final_output": "Translated files in target language"
}

Example 8 - Multi-file Translation:
User: "convert these files to [target language]"
{
  "domain": "[Inferred from attached code]",
  "domain_notes": "Preserve type hints, convert to target language idioms",
  "understanding": "User wants all attached files converted to target language",
  "strategy": "Use translate_all_files to translate all files together",
  "steps": [
    {
      "step": 1,
      "tool": "translate_all_files",
      "purpose": "Translate all files to target language",
      "parameters": { "targetLanguage": "[target language]" }
    }
  ],
  "final_output": "Files in target language with proper types"
}

# WHEN TO USE EACH TOOL

## 3-LAYER SEARCH ARCHITECTURE
Layer 1 - SYMBOL INDEX (structured lookups):
- search_index: Find functions/classes/variables by name (fuzzy matching)
- get_function_context: Get full source code of a specific function

Layer 2 - TRIGRAM INDEX (exact text search - Zoekt-style):  
- search_trigram: Fast exact/partial text search (variable names, strings, identifiers)
- search_code: COMPREHENSIVE - combines symbol + trigram in one step (PREFERRED)

Layer 3 - VECTOR INDEX (semantic similarity - TF-IDF):
- search_semantic: Find conceptually similar code (when exact keywords don't match)

## OTHER TOOLS
- grep_context: Fallback raw pattern matching (use trigram instead when possible)
- answer_question: Generate explanation from gathered context

# FUZZY MATCHING
The search tools support fuzzy matching for cryptic symbol names:
- "RTE" matches "RangeTblEntry" (CamelCase abbreviation)
- "parse_rel" matches "parse_relation" (word boundary)
- "xfrm" matches "transformExpr" (subsequence)

# WHEN TO USE MULTI-STEP vs SINGLE-STEP
- Use MULTI-STEP for: "how is X implemented", "explain function Y", "trace Z", "list all X functions"
- Use SINGLE-STEP for: "what is X", "compare A and B", "summarize this code", general questions

# OUTPUT FORMAT
Respond with ONLY valid JSON (no markdown, no explanation):
{
  "domain": "Identified technical domain",
  "domain_notes": "Key terminology or context to ensure accuracy",
  "understanding": "Brief description",
  "strategy": "Approach",
  "steps": [{ "step": 1, "tool": "tool_name", "purpose": "why", "parameters": { } }],
  "final_output": "Expected output"
}

Create the plan now:`;

    try {
        const response = await callLanguageModel(plannerPrompt);
        log('PLANNER: Raw response:', response.substring(0, 500));
        
        // Extract JSON from response
        let jsonStr = response.trim();
        // Remove markdown code blocks if present
        if (jsonStr.includes('```')) {
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                jsonStr = jsonMatch[1].trim();
            }
        }
        
        // Try to find JSON object in the response
        const jsonStart = jsonStr.indexOf('{');
        const jsonEnd = jsonStr.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
        }
        
        const plan = JSON.parse(jsonStr);
        log('PLANNER: Created plan with', plan.steps?.length || 0, 'steps');
        log('PLANNER: Strategy:', plan.strategy);
        
        return plan;
    } catch (error) {
        log('PLANNER ERROR:', error.message);
        // Return a fallback plan for simple questions
        return {
            understanding: query,
            strategy: 'Direct answer with available context',
            steps: [
                {
                    step: 1,
                    tool: 'answer_question',
                    purpose: 'Answer the user query directly',
                    parameters: { question: query, context: getBasicContext() },
                    use_result_for: 'Final response'
                }
            ],
            final_output: 'Direct answer to the question'
        };
    }
}

/**
 * Format grep results into a readable string for LLM context
 */
function formatGrepResults(results) {
    if (!results || !Array.isArray(results)) {
        log('formatGrepResults: Invalid results:', typeof results);
        return JSON.stringify(results, null, 2);
    }
    
    if (results.length === 0) {
        return 'No matches found.';
    }
    
    log('formatGrepResults: Formatting', results.length, 'result blocks');
    
    // Check if this is the new format (with content blocks) or old format (individual lines)
    const isNewFormat = results[0]?.content && results[0]?.startLine;
    
    if (isNewFormat) {
        // New format: code blocks with context
        let formatted = `Found ${results.reduce((s, r) => s + (r.matchCount || 1), 0)} matches in ${results.length} code blocks:\n\n`;
        
        for (const block of results) {
            formatted += `=== ${block.fileName} (lines ${block.startLine}-${block.endLine}) ===\n`;
            formatted += block.content;
            formatted += '\n\n';
        }
        
        return formatted;
    } else {
        // Old format: group by file
        const byFile = {};
        for (const r of results) {
            const file = r.fileName || 'unknown';
            if (!byFile[file]) byFile[file] = [];
            byFile[file].push(r);
        }
        
        let formatted = `Found ${results.length} matches:\n\n`;
        for (const [fileName, matches] of Object.entries(byFile)) {
            formatted += `=== ${fileName} ===\n`;
            for (const m of matches) {
                formatted += `Line ${m.line}: ${m.content}\n`;
            }
            formatted += '\n';
        }
        
        return formatted;
    }
}

/**
 * Get basic context for fallback scenarios
 */
function getBasicContext() {
    let context = '';
    for (const [path, file] of contextFiles) {
        const name = path.split('/').pop();
        context += `=== ${name} ===\n${file.content.substring(0, 5000)}\n\n`;
    }
    return context || 'No files in context';
}

/**
 * EXECUTOR: Executes a single step of the plan
 */
async function executeStep(step, previousResults, plan) {
    log(`EXECUTOR: Step ${step.step} - ${step.tool}: ${step.purpose}`);
    
    const tool = AGENT_TOOLS[step.tool];
    if (!tool) {
        log(`EXECUTOR: Unknown tool "${step.tool}"`);
        return { success: false, error: `Unknown tool: ${step.tool}` };
    }
    
    // Prepare parameters, potentially using results from previous steps
    let params = { ...step.parameters };
    
    // Inject domain context from plan if tool supports it and not already specified
    if (plan.domain && !params.domain) {
        params.domain = plan.domain;
    }
    if (plan.domain_notes && !params.domain_notes) {
        params.domain_notes = plan.domain_notes;
    }
    
    // If parameters reference previous results, substitute them
    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string') {
            log(`EXECUTOR: Checking param "${key}" = "${value.substring(0, 100)}..."`);
            
            // Check for references like "$step1.data.content" or "$step1.data.results"
            const refMatch = value.match(/\$step(\d+)\.(.+)/);
            if (refMatch) {
                const stepNum = parseInt(refMatch[1]);
                const pathStr = refMatch[2];
                const pathParts = pathStr.split('.');
                log(`EXECUTOR: Found step reference: step${stepNum}.${pathStr}`);
                log(`EXECUTOR: Previous results count:`, previousResults.length);
                
                let result = previousResults[stepNum - 1];
                log(`EXECUTOR: Step ${stepNum} result:`, result ? 'exists' : 'null');
                
                for (const prop of pathParts) {
                    result = result?.[prop];
                    log(`EXECUTOR: After accessing .${prop}:`, result ? (Array.isArray(result) ? `array[${result.length}]` : typeof result) : 'null');
                }
                
                // Special formatting for grep results
                if (pathStr.endsWith('.results') && Array.isArray(result)) {
                    const formatted = formatGrepResults(result);
                    log(`EXECUTOR: Formatted grep results: ${formatted.substring(0, 200)}...`);
                    params[key] = formatted;
                } else if (typeof result === 'object') {
                    params[key] = JSON.stringify(result, null, 2);
                } else {
                    params[key] = result;
                }
            }
            // Check for special reference "$context" - get all context files
            else if (value === '$context') {
                params[key] = getBasicContext();
            }
            // Check for "$all_results"
            else if (value === '$all_results') {
                params[key] = JSON.stringify(previousResults, null, 2);
            }
            // Handle natural language references like "result from step 1"
            else if (/result\s*(from|of)\s*step\s*(\d+)/i.test(value)) {
                const match = value.match(/result\s*(?:from|of)\s*step\s*(\d+)/i);
                if (match) {
                    const stepNum = parseInt(match[1]);
                    const prevResult = previousResults[stepNum - 1];
                    if (prevResult?.data?.results) {
                        // Format grep results
                        params[key] = formatGrepResults(prevResult.data.results);
                    } else if (prevResult?.data?.content) {
                        params[key] = prevResult.data.content;
                    } else if (prevResult?.data) {
                        params[key] = JSON.stringify(prevResult.data);
                    }
                }
            }
            // Handle "previous result" or "step N result" patterns
            else if (/previous\s*result|step\s*\d+\s*result/i.test(value)) {
                const lastResult = previousResults[previousResults.length - 1];
                if (lastResult?.data?.results) {
                    // Format grep results
                    params[key] = formatGrepResults(lastResult.data.results);
                } else if (lastResult?.data?.content) {
                    params[key] = lastResult.data.content;
                } else if (lastResult?.data) {
                    params[key] = JSON.stringify(lastResult.data);
                }
            }
        }
    }
    
    try {
        const result = await tool.execute(params);
        log(`EXECUTOR: Step ${step.step} result:`, result.success ? 'SUCCESS' : 'FAILED');
        return result;
    } catch (error) {
        log(`EXECUTOR: Step ${step.step} error:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Save generated code to .astra folder and return file info
 * @param {string} code - The code content to save
 * @param {string} fileName - Suggested file name
 * @param {string} language - Programming language for extension
 * @returns {Promise<{saved: boolean, filePath?: string, fileUri?: vscode.Uri, error?: string}>}
 */
async function saveGeneratedCode(code, fileName, language) {
    log('Saving generated code:', fileName);
    
    // Determine file extension based on language
    const extMap = {
        'java': '.java',
        'python': '.py',
        'javascript': '.js',
        'typescript': '.ts',
        'c': '.c',
        'cpp': '.cpp',
        'c++': '.cpp',
        'csharp': '.cs',
        'c#': '.cs',
        'go': '.go',
        'rust': '.rs',
        'ruby': '.rb',
        'php': '.php',
        'swift': '.swift',
        'kotlin': '.kt',
        'scala': '.scala'
    };
    
    // Clean up file name and add proper extension
    let cleanFileName = fileName.replace(/\.[^.]+$/, ''); // Remove existing extension
    const ext = extMap[language.toLowerCase()] || `.${language.toLowerCase()}`;
    cleanFileName = cleanFileName + ext;
    
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        let fileUri;
        
        if (workspaceFolder) {
            // Save to .astra/generated folder in workspace
            const astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'generated');
            try {
                await vscode.workspace.fs.createDirectory(astraDir);
            } catch (e) {
                // Directory might already exist
            }
            fileUri = vscode.Uri.joinPath(astraDir, cleanFileName);
        } else {
            // Save to temp location
            const os = require('os');
            const path = require('path');
            const tmpDir = path.join(os.tmpdir(), 'astra-generated');
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
            } catch (e) {
                // Directory might already exist
            }
            fileUri = vscode.Uri.file(path.join(tmpDir, cleanFileName));
        }
        
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf-8'));
        
        log('Saved generated code to:', fileUri.fsPath);
        
        return {
            saved: true,
            filePath: fileUri.fsPath,
            fileUri: fileUri,
            fileName: cleanFileName
        };
        
    } catch (error) {
        log('Error saving generated code:', error.message);
        return {
            saved: false,
            error: error.message
        };
    }
}

/**
 * Format a download link for the chat UI
 */
function formatDownloadLink(fileInfo, language) {
    if (!fileInfo.saved) {
        return '\n*⚠️ Could not save file to disk*\n';
    }
    
    // Use backtick code format which will be rendered as clickable link
    return `
---
### 📁 File Saved

**Click to open:** \`${fileInfo.filePath}\`

---
`;
}

/**
 * SYNTHESIZER: Combines all step results into a final response
 */
async function synthesizeResponse(query, plan, stepResults) {
    log('SYNTHESIZER: Combining results from', stepResults.length, 'steps');
    
    // Check if any step directly produced a good final answer
    for (let i = stepResults.length - 1; i >= 0; i--) {
        const result = stepResults[i];
        const step = plan.steps[i];
        
        if (result.success && result.data) {
            // For multi-file translation (translate_all_files)
            if (result.data.translatedFiles && Array.isArray(result.data.translatedFiles)) {
                const targetLang = result.data.targetLanguage || 'java';
                let output = `## 📦 Translated ${result.data.fileCount} Files to ${targetLang.toUpperCase()}\n\n`;
                
                // Summary
                if (result.data.summary) {
                    output += `### Summary\n${result.data.summary}\n\n`;
                }
                
                // Save and display each file
                for (const tf of result.data.translatedFiles) {
                    if (tf.error) {
                        output += `### ❌ ${tf.originalFile}\n**Error:** ${tf.error}\n\n`;
                    } else {
                        // Save the file
                        const fileInfo = await saveGeneratedCode(
                            tf.translatedCode,
                            tf.newFileName.replace(/\.\w+$/, ''),
                            targetLang
                        );
                        
                        output += `### ✅ ${tf.originalFile} → ${tf.newFileName}\n`;
                        if (fileInfo.saved) {
                            output += `**Click to open:** \`${fileInfo.filePath}\`\n\n`;
                        }
                        // Show a preview of the code (first 50 lines)
                        const codeLines = tf.translatedCode.split('\n');
                        const preview = codeLines.slice(0, 50).join('\n');
                        const truncated = codeLines.length > 50 ? `\n// ... (${codeLines.length - 50} more lines)` : '';
                        output += `\`\`\`${targetLang}\n${preview}${truncated}\n\`\`\`\n\n`;
                    }
                }
                
                return output;
            }
            
            // For single-file translation (translate_code, translate_file), save and return with download link
            if (result.data.translatedCode) {
                const targetLang = result.data.targetLanguage || 'java';
                const header = `## Translated to ${targetLang.toUpperCase()}`;
                const stats = result.data.chunks > 1 
                    ? `\n*Translated in ${result.data.chunks} chunks from ${result.data.originalLines} lines*\n`
                    : '';
                
                // Determine file name from original or plan
                let originalFileName = 'translated';
                if (plan.target_file) {
                    originalFileName = plan.target_file.replace(/\.[^.]+$/, '');
                } else if (result.data.fileName) {
                    originalFileName = result.data.fileName.replace(/\.[^.]+$/, '');
                }
                
                // Save the translated code
                const fileInfo = await saveGeneratedCode(
                    result.data.translatedCode, 
                    originalFileName, 
                    targetLang
                );
                
                const downloadSection = formatDownloadLink(fileInfo, targetLang);
                
                return `${header}${stats}
${downloadSection}

\`\`\`${targetLang}
${result.data.translatedCode}
\`\`\``;
            }
            // For generated code (from generate_code or create_from_example)
            if (result.data.generatedCode && result.data.shouldSave) {
                const lang = result.data.language || 'text';
                const fileName = result.data.fileName || 'generated';
                
                // Save the generated code
                const fileInfo = await saveGeneratedCode(
                    result.data.generatedCode,
                    fileName,
                    lang
                );
                
                const downloadSection = formatDownloadLink(fileInfo, lang);
                const basedOnNote = result.data.basedOn 
                    ? `\n*Based on: ${result.data.basedOn}*\n` 
                    : '';
                
                return `## Generated ${lang.toUpperCase()} Code
${basedOnNote}
${downloadSection}

\`\`\`${lang}
${result.data.generatedCode}
\`\`\``;
            }
            // For full documentation
            if (result.data.documentation && result.data.fileCount) {
                return result.data.documentation;
            }
            // For trace, return the analysis
            if (result.data.analysis && result.data.trace) {
                return result.data.analysis;
            }
            // For review, return the review
            if (result.data.review) {
                return result.data.review;
            }
            // For explanation or answer, return directly
            if (result.data.explanation) {
                return result.data.explanation;
            }
            // For answer from answer_question - return the actual answer
            if (result.data.answer) {
                log('SYNTHESIZER: Returning answer from answer_question');
                return result.data.answer;
            }
            if (result.data.documentation) {
                return result.data.documentation;
            }
            // For API search results with context
            if (result.data.context && result.data.results) {
                // Use LLM to answer based on API results
                const searchContext = result.data.context;
                const answerPrompt = `Based on these search results:\n\n${searchContext}\n\nAnswer the query: ${query}`;
                return await callLanguageModel(answerPrompt);
            }
        }
    }
    
    // Check for any successful data that might be useful
    const successfulResults = stepResults.filter(r => r.success && r.data);
    
    if (successfulResults.length === 0) {
        // All steps failed - explain what happened
        log('SYNTHESIZER: All steps failed');
        const errors = stepResults.map((r, i) => `Step ${i+1}: ${r.error || 'Unknown error'}`).join('\n');
        return `I encountered issues processing your request:\n\n${errors}\n\nPlease try rephrasing your question or adding more context.`;
    }
    
    // If no direct answer, synthesize from all results
    const resultsContext = stepResults.map((r, i) => {
        const step = plan.steps[i];
        if (r.success && r.data) {
            // Summarize data meaningfully
            if (r.data.files) {
                return `### Step ${i + 1}: ${step?.purpose}\nFiles: ${r.data.files.map(f => f.name || f).join(', ')}`;
            }
            if (r.data.content) {
                return `### Step ${i + 1}: ${step?.purpose}\nContent: ${r.data.content.substring(0, 500)}...`;
            }
            return `### Step ${i + 1}: ${step?.purpose}\n${JSON.stringify(r.data, null, 2).substring(0, 1000)}`;
        }
        return `### Step ${i + 1}: ${step?.purpose}\nError: ${r.error}`;
    }).join('\n\n');
    
    const synthesisPrompt = `You completed a multi-step task. Now synthesize the final response.

# Original Request
"${query}"

# Plan
Understanding: ${plan.understanding}
Strategy: ${plan.strategy}
Expected Output: ${plan.final_output}

# Step Results
${resultsContext}

# Instructions
Create a clear, helpful response that addresses the user's original request.
Use the information gathered from the steps above.
Be concise but complete. If steps failed, explain what happened.`;

    try {
        const result = await callLanguageModel(synthesisPrompt);
        if (result && result.trim()) {
            return result;
        }
    } catch (error) {
        log('SYNTHESIZER: LLM call failed:', error.message);
    }
    
    // Ultimate fallback - return raw step results
    log('SYNTHESIZER: Using fallback raw results');
    return `Here's what I found:\n\n${resultsContext}`;
}

/**
 * AGENT ORCHESTRATOR: Main entry point for the agentic workflow
 */

// ============================================================
// Chat Message Handler (Updated for Agentic Architecture)
// ============================================================

/**
 * Get a display-friendly model name
 * Uses centralized LLMConfig for display name resolution
 */
function getModelDisplayName() {
    // If we tracked the last used model, use it
    if (lastUsedModel) {
        // For Copilot models - use family or name
        if (lastUsedModel.vendor === 'copilot' || lastUsedModel.family) {
            const modelId = lastUsedModel.family || lastUsedModel.name || lastUsedModel.id;
            return LLMConfig.getDisplayName(modelId);
        }
        
        // For direct API models (anthropic/openai)
        if (lastUsedModel.provider && lastUsedModel.model) {
            return LLMConfig.getDisplayName(lastUsedModel.model);
        }
    }
    
    // Fallback: use default model from config
    const defaultModel = LLMConfig.getDefaultModel();
    return LLMConfig.getDisplayName(defaultModel);
}

/**
 * Format a plan for display to user
 */
function formatPlanForDisplay(plan) {
    let display = `## 📋 Execution Plan\n\n`;
    
    if (plan.domain) {
        display += `**Domain:** ${plan.domain}\n`;
    }
    if (plan.domain_notes) {
        display += `**Notes:** ${plan.domain_notes}\n`;
    }
    display += `**Understanding:** ${plan.understanding}\n`;
    display += `**Strategy:** ${plan.strategy}\n\n`;
    
    display += `### Steps:\n`;
    for (const step of plan.steps) {
        display += `${step.step}. **${step.tool}** - ${step.purpose}\n`;
        if (step.parameters) {
            const params = Object.entries(step.parameters)
                .filter(([k, v]) => k !== 'context' && v !== '$context')
                .map(([k, v]) => `   - ${k}: ${typeof v === 'string' && v.length > 50 ? v.substring(0, 50) + '...' : v}`)
                .join('\n');
            if (params) display += params + '\n';
        }
    }
    
    display += `\n**Expected Output:** ${plan.final_output}\n`;
    display += `\n---\n`;
    display += `💡 **Reply with:**\n`;
    display += `- \`go\` or \`execute\` to run this plan\n`;
    display += `- \`edit: <your changes>\` to modify\n`;
    display += `- \`skip\` to answer directly without planning\n`;
    
    return display;
}

/**
 * Check if message is a plan control command
 */
function isPlanCommand(text) {
    const lower = text.toLowerCase().trim();
    return lower === 'go' || 
           lower === 'execute' || 
           lower === 'run' ||
           lower === 'skip' ||
           lower.startsWith('edit:') ||
           lower.startsWith('edit ');
}

/**
 * Handle plan control commands
 */
async function handlePlanCommand(text) {
    const lower = text.toLowerCase().trim();
    
    if (!pendingPlan) {
        return null; // No pending plan
    }
    
    if (lower === 'go' || lower === 'execute' || lower === 'run') {
        // Execute the pending plan
        const { query, plan } = pendingPlan;
        pendingPlan = null;
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: '\n\n**Executing plan...**\n\n' 
        });
        
        return await executePlan(query, plan);
    }
    
    if (lower === 'skip') {
        // Skip planning, answer directly
        const { query } = pendingPlan;
        pendingPlan = null;
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: '\n\n**Answering directly...**\n\n' 
        });
        
        const context = getBasicContext();
        return await callLanguageModel(query + '\n\nContext:\n' + context);
    }
    
    if (lower.startsWith('edit:') || lower.startsWith('edit ')) {
        // User wants to edit the plan
        const editInstructions = text.substring(text.indexOf(':') + 1).trim() || 
                                  text.substring(5).trim();
        const { query, plan } = pendingPlan;
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: '\n\n**Revising plan...**\n\n' 
        });
        
        // Re-plan with user's edits
        const revisedPlan = await revisePlan(query, plan, editInstructions);
        pendingPlan = { query, plan: revisedPlan };
        
        return formatPlanForDisplay(revisedPlan);
    }
    
    return null;
}

/**
 * Revise a plan based on user feedback
 */
async function revisePlan(query, currentPlan, editInstructions) {
    const revisionPrompt = `You created this plan:
${JSON.stringify(currentPlan, null, 2)}

The user wants to change it: "${editInstructions}"

Provide a revised plan that incorporates the user's feedback.
Output ONLY valid JSON with the same structure.`;

    try {
        const response = await callLanguageModel(revisionPrompt);
        let jsonStr = response.trim();
        if (jsonStr.includes('```')) {
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonStr = jsonMatch[1].trim();
        }
        const jsonStart = jsonStr.indexOf('{');
        const jsonEnd = jsonStr.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
        }
        return JSON.parse(jsonStr);
    } catch (error) {
        log('Plan revision failed:', error.message);
        return currentPlan; // Return original if revision fails
    }
}

/**
 * Execute a plan (separated from planning)
 */
async function executePlan(query, plan) {
    log('EXECUTOR: Running plan with', plan.steps.length, 'steps');
    taskController.start(`Executing plan: ${query.substring(0, 50)}...`);
    
    // Show index statistics to user
    showIndexStats();
    
    // Show plan overview
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `\n**Executing ${plan.steps.length}-step plan:**\n` 
    });
    
    const stepResults = [];
    
    for (const step of plan.steps) {
        // Check for cancellation before each step
        if (taskController.isCancelled) {
            log('Plan execution cancelled by user');
            throw new Error('Task cancelled by user');
        }
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n▶️ **Step ${step.step}:** ${step.tool} - ${step.purpose}\n` 
        });
        
        const result = await executeStep(step, stepResults, plan);
        stepResults.push(result);
        
        // Show step result summary
        if (result.success) {
            const summary = getStepResultSummary(step.tool, result.data);
            if (summary) {
                showProgress(summary, 'found');
            }
        } else {
            showProgress(`Step ${step.step} failed: ${result.error}`, 'warn');
        }
        
        log(`EXECUTOR: Step ${step.step} (${step.tool}):`, result.success ? 'SUCCESS' : 'FAILED');
    }
    
    // Synthesize response
    showProgress('Generating response...', 'info');
    const response = await synthesizeResponse(query, plan, stepResults);
    return response;
}

/**
 * Get a human-readable summary of step results
 */
function getStepResultSummary(tool, data) {
    if (!data) return null;
    
    switch (tool) {
        case 'search_code':
            const symCount = data.indexResults?.symbols?.length || 0;
            const grepCount = data.grepResults?.length || 0;
            return `Found ${symCount} symbols, ${grepCount} code blocks`;
        case 'search_index':
            return `Found ${data.symbols?.length || 0} matching symbols`;
        case 'grep_context':
            return `Found ${data.results?.length || 0} matches`;
        case 'get_function_context':
            return `Retrieved function: ${data.name || 'unknown'}`;
        case 'review_file':
        case 'review_code':
            return 'Code review completed';
        default:
            return null;
    }
}

async function handleChatMessage(text) {
    log('Chat message:', text);
    
    // Reset model tracking for this request
    lastUsedModel = null;
    
    // ================================================================
    // BLOCK QUERIES DURING INDEXING
    // ================================================================
    if (IndexingState.shouldBlockQueries()) {
        const blockMessage = IndexingState.getBlockingMessage();
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: blockMessage + '\n\n'
        });
        chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
        return;
    }
    
    // Warn if summaries are still generating (but don't block)
    if (IndexingState.isSummarizing) {
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `⚠️ *Summaries still generating (${IndexingState.summariesGenerated} done). Results may improve after completion.*\n\n`
        });
    }
    
    // Check if this is a plan control command
    if (pendingPlan && isPlanCommand(text)) {
        // Don't add control commands to visible history
        chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: true });
        
        try {
            const response = await handlePlanCommand(text);
            const modelName = getModelDisplayName();
            const attribution = `\n\n---\n*AstraCode (${modelName})*`;
            
            if (response && response.length > 0) {
                // Response wasn't streamed, display it
                const cleanedResponse = cleanLlmResponse(response);
                
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: cleanedResponse + attribution 
                });
                
                chatHistory.push({
                    role: 'assistant',
                    content: cleanedResponse + attribution,
                    timestamp: new Date()
                });
            } else {
                // Response was already streamed (answer_question), just add attribution
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: attribution 
                });
                
                // Note: The streamed content was already displayed, we just add attribution
            }
        } catch (error) {
            log('Error:', error.message);
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n\nError: ${error.message}` 
            });
        }
        
        taskController.reset();
        chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
        chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
        return;
    }
    
    // Add user message to history
    const userMessage = {
        role: 'user',
        content: text,
        timestamp: new Date()
    };
    chatHistory.push(userMessage);
    
    // Persist the user message
    if (persistenceManager) {
        persistenceManager.appendChatMessage(userMessage);
        persistenceManager.markDirty();
    }
    
    updateChatUI();
    
    // Set processing state
    chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: true });
    
    try {
        // Check for session memory commands first
        const sessionCommand = parseSessionCommand(text);
        if (sessionCommand) {
            log('Session command detected:', sessionCommand.type);
            const response = executeSessionCommand(sessionMemory, sessionCommand);
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: response 
            });
            
            chatHistory.push({
                role: 'assistant',
                content: response,
                timestamp: new Date()
            });
            
            // Add to session memory
            if (sessionMemory) {
                sessionMemory.addTurn(text, response, { type: 'command' });
            }
            
            taskController.reset();
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
            updateChatUI();
            return;
        }
        
        // Check for /memory-help command
        if (text.trim().toLowerCase() === '/memory-help' || text.trim().toLowerCase() === '/session-help') {
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: SESSION_MEMORY_HELP 
            });
            
            chatHistory.push({
                role: 'assistant',
                content: SESSION_MEMORY_HELP,
                timestamp: new Date()
            });
            
            taskController.reset();
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
            updateChatUI();
            return;
        }
        
        // Expand @N references in the user message
        let expandedText = text;
        if (sessionMemory && sessionMemory.hasReferences(text)) {
            const { expanded, references } = sessionMemory.expandReferences(text);
            expandedText = expanded;
            
            if (references.length > 0) {
                log('Expanded references:', references.map(r => r.ref).join(', '));
                
                // Show user that we're using referenced content
                const refList = references.map(r => r.ref).join(', ');
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `*Using content from: ${refList}*\n\n`
                });
            }
        }
        
        // Check for simple/direct commands that skip planning
        const skipPlanningPatterns = [
            /^(hi|hello|hey|thanks|thank you)/i,
            /^\//, // Commands starting with /
        ];
        
        // Documentation generation should bypass planning
        const isDocumentGeneration = /^(?:document|generate\s+(?:full\s+)?(?:doc|documentation)|documentation|deepwiki|full\s*doc)/i.test(expandedText.trim());
        
        debugLog('ROUTE', `Files: ${contextFiles.size} | isDocGen: ${isDocumentGeneration}`, {
            query: expandedText.substring(0, 80),
            fileCount: contextFiles.size,
            isDocGeneration: isDocumentGeneration
        });
        
        const shouldSkipPlanning = skipPlanningPatterns.some(p => p.test(expandedText.trim()));
        
        // For large codebases, use LLM to classify the query type
        const LARGE_CODEBASE_THRESHOLD = 50;
        if (contextFiles.size > LARGE_CODEBASE_THRESHOLD && !isDocumentGeneration && !shouldSkipPlanning) {
            debugLog('ROUTE', 'Large codebase → LLM classification', contextFiles.size);
            
            // Show classification status
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: '*Analyzing query type...*\n\n'
            });
            
            const queryType = await classifyQueryWithLLM(expandedText, contextFiles.size);
            debugLog('CLASSIFY', `Query type: ${queryType}`, queryType);
            
            if (queryType === 'overview' || queryType === 'domain' || queryType === 'specific') {
                debugLog('ROUTE', `Using handleLocalMode (${queryType})`, queryType);
                // Handle overview, domain, AND specific queries with specialized handlers
                // These all benefit from search + chunking, not the planner
                const response = await handleLocalMode(text, { queryType });
                const modelName = getModelDisplayName();
                const attribution = `\n\n---\n*AstraCode (${modelName})*`;
                
                // Display the actual response
                if (response && response.length > 0) {
                    // Check if this is an error response
                    if (isLlmErrorResponse(response)) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: response  // Error already formatted, no attribution
                        });
                    } else {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: response + attribution 
                        });
                    }
                } else {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: attribution 
                    });
                }
                
                chatHistory.push({
                    role: 'assistant',
                    content: response || `Query answered using ${queryType} mode.`,
                    timestamp: new Date()
                });
                
                taskController.reset();
                chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
                chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
                updateChatUI();
                return;
            }
            
            // For 'general' queries (not about the code), continue to planner
            log('CLASSIFY: Query type is', queryType, '- continuing to planner');
        }
        
        if (isDocumentGeneration && contextFiles.size > 0) {
            // Direct documentation generation, bypass planning
            log('DOCS: Bypassing planner for documentation generation');
            const response = await handleLocalMode(text, {});
            const modelName = getModelDisplayName();
            const attribution = `\n\n---\n*AstraCode (${modelName})*`;
            
            // Note: handleLocalMode already streams the response
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: attribution 
            });
            
            chatHistory.push({
                role: 'assistant',
                content: 'Documentation generated.',
                timestamp: new Date()
            });
            
            taskController.reset();
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
            updateChatUI();
            return;
        }
        
        if (shouldSkipPlanning) {
            // Direct response, no planning
            const response = await callLanguageModel(text);
            const modelName = getModelDisplayName();
            const attribution = `\n\n---\n*AstraCode (${modelName})*`;
            
            chatHistory.push({
                role: 'assistant',
                content: response + attribution,
                timestamp: new Date()
            });
            
            taskController.reset();
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
            updateChatUI();
            return;
        }
        
        // ============================================================
        // SMALL CODEBASES: Read files directly, no planner needed
        // ============================================================
        const SMALL_CODEBASE_THRESHOLD = 50;
        if (contextFiles.size > 0 && contextFiles.size <= SMALL_CODEBASE_THRESHOLD) {
            debugLog('ROUTE', `Small codebase (${contextFiles.size} files) → Direct analysis`, {
                fileCount: contextFiles.size,
                threshold: SMALL_CODEBASE_THRESHOLD,
                files: Array.from(contextFiles.keys()).map(f => pathUtils.getFileName(f)).slice(0, 10)
            });
            
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `*Analyzing ${contextFiles.size} files directly...*\n\n`
            });
            
            // For small codebases, just pass all content to LLM
            debugLog('ROUTE', 'Calling handleLocalMode with queryType=specific');
            const response = await handleLocalMode(text, { queryType: 'specific' });
            const modelName = getModelDisplayName();
            debugLog('MODEL', `Response from: ${modelName}`, response?.length || 0);
            const attribution = `\n\n---\n*AstraCode (${modelName})*`;
            
            if (response && response.length > 0) {
                if (isLlmErrorResponse(response)) {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: response
                    });
                } else {
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: response + attribution 
                    });
                }
            } else {
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: attribution 
                });
            }
            
            chatHistory.push({
                role: 'assistant',
                content: response || 'Analysis complete.',
                timestamp: new Date()
            });
            
            taskController.reset();
            chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
            chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
            updateChatUI();
            return;
        }
        
        // PHASE 1: Create and display the plan
        log('PLANNER: Creating plan for:', text);
        const plan = await createExecutionPlan(text, chatHistory.slice(-6));
        
        if (!plan || !plan.steps || plan.steps.length === 0) {
            // No valid plan, answer directly
            log('AGENT: No valid plan, using direct LLM');
            const response = await callLanguageModel(text + '\n\nContext:\n' + getBasicContext());
            const modelName = getModelDisplayName();
            const attribution = `\n\n---\n*AstraCode (${modelName})*`;
            
            chatHistory.push({
                role: 'assistant',
                content: response + attribution,
                timestamp: new Date()
            });
        } else {
            // Store pending plan and show to user
            pendingPlan = { query: text, plan };
            
            const planDisplay = formatPlanForDisplay(plan);
            chatHistory.push({
                role: 'assistant',
                content: planDisplay,
                timestamp: new Date()
            });
            
            chatWebviewView?.webview.postMessage({ 
                type: 'assistantMessage', 
                content: planDisplay 
            });
        }
        
    } catch (error) {
        log('Error:', error.message);
        chatHistory.push({
            role: 'assistant',
            content: `Error: ${error.message}`,
            timestamp: new Date()
        });
    }
    
    taskController.reset();
    chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
    chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
    updateChatUI();
    
    // Add to session memory for @N references
    if (sessionMemory && chatHistory.length >= 2) {
        const lastAssistant = chatHistory[chatHistory.length - 1];
        if (lastAssistant && lastAssistant.role === 'assistant') {
            const originalUserText = text; // Use original text, not expanded
            sessionMemory.addTurn(originalUserText, lastAssistant.content, {
                model: lastUsedModel,
                filesInContext: contextFiles.size
            });
        }
    }
    
    // Persist the entire chat history after processing
    if (persistenceManager) {
        persistenceManager.markDirty();
    }
}

// Keep determineMode for backward compatibility but it's less important now
function determineMode(text) {
    // Explicit mode in message
    if (/^\/api\s/i.test(text)) return 'api';
    if (/^\/local\s/i.test(text)) return 'local';
    
    // Use current mode if not auto
    if (currentMode !== 'auto') return currentMode;
    
    // Auto detection
    const hasContext = contextFiles.size > 0;
    const referencesFiles = /\b(this|these|the|attached|file|code|context)\b/i.test(text);
    const isTranslate = /translate|convert|port\s+(?:to|this)|rewrite\s+(?:in|to)/i.test(text);
    const isExplain = /explain|describe|analyze|flowchart/i.test(text) && referencesFiles;
    const isGeneralQuestion = /^(what is|what are|how does|tell me about)/i.test(text);
    
    if (isGeneralQuestion && !referencesFiles) {
        return 'api';
    }
    
    if (hasContext && (referencesFiles || isTranslate || isExplain)) {
        return 'local';
    }
    
    return hasContext ? 'local' : 'api';
}

async function handleLocalMode(text, config = {}) {
    debugLog('LOCAL', `handleLocalMode called`, {
        query: text.substring(0, 60),
        configQueryType: config.queryType,
        fileCount: contextFiles.size
    });
    
    if (contextFiles.size === 0) {
        return `No files in context. Please add files using:
- Right-click a file → "AstraCode: Add File to Context"
- Or switch to API mode to search the codebase`;
    }
    
    // Use LLM-classified query type if provided, otherwise fall back to regex
    const LARGE_CODEBASE_THRESHOLD = 50;
    const isLargeCodebase = contextFiles.size > LARGE_CODEBASE_THRESHOLD;
    const queryType = config.queryType || (isLargeCodebase ? classifyQueryFallback(text) : 'specific');
    
    debugLog('LOCAL', `Query classification`, {
        isLargeCodebase,
        queryType,
        threshold: LARGE_CODEBASE_THRESHOLD
    });
    
    // ============================================================
    // HIGH-LEVEL QUERIES: Use pre-computed summaries + structure
    // ============================================================
    if (isLargeCodebase && queryType === 'overview') {
        debugLog('LOCAL', 'Using HIGH-LEVEL handler (summaries + structure)');
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*Analyzing ${contextFiles.size} files using intelligent summarization...*\n\n`
        });
        
        try {
            return await handleHighLevelQuery(text);
        } catch (error) {
            debugLog('LOCAL', `High-level handler error: ${error.message}`);
            // Fall back to legacy hierarchical summary
            const hierarchicalSummary = generateHierarchicalSummary();
            const prompt = `Based on this codebase structure, answer: ${text}\n\n${hierarchicalSummary}`;
            const result = await callLanguageModel(prompt);
            if (isLlmErrorResponse(result)) {
                return `**Unable to analyze codebase**

The LLM is currently unavailable. Here's a structural summary:

${hierarchicalSummary.substring(0, 2000)}

Please check your GitHub Copilot or API configuration.`;
            }
            return result;
        }
    }
    
    // ============================================================
    // DOMAIN/DETAILED QUERIES: Search + chunk + analyze
    // ============================================================
    if (isLargeCodebase && (queryType === 'domain' || queryType === 'specific')) {
        debugLog('LOCAL', 'Using DETAILED handler (search + chunking)');
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*Searching ${contextFiles.size} files for relevant code...*\n\n`
        });
        
        try {
            return await handleDetailedQuery(text);
        } catch (error) {
            log('LOCAL MODE: Detailed handler error:', error.message);
            // Fall back to legacy focused context
            const focusedContext = findRelevantContext(text);
            if (focusedContext.totalFiles > 0) {
                const prompt = `Analyze this code to answer: ${text}\n\n${focusedContext.content}`;
                const result = await callLanguageModel(prompt);
                if (isLlmErrorResponse(result)) {
                    return `**Unable to analyze code**

The LLM is currently unavailable. Found ${focusedContext.totalFiles} relevant files.

Please check your GitHub Copilot or API configuration.`;
                }
                return result;
            }
        }
    }
    
    // ============================================================
    // SMALL CODEBASES: Direct context (original behavior)
    // ============================================================
    debugLog('LOCAL', 'Small codebase path - reading files directly');
    
    let contextContent = 'FILES IN CONTEXT:\n\n';
    const fileList = [];
    for (const [filePath, file] of contextFiles) {
        const fileName = pathUtils.getFileName(filePath);
        contextContent += `=== ${fileName} (${file.language}) ===\n`;
        contextContent += file.content + '\n\n';
        fileList.push({ name: fileName, path: filePath, language: file.language, size: file.content.length });
    }
    
    debugLog('LOCAL', `Built context`, {
        files: fileList.length,
        totalChars: contextContent.length,
        fileNames: fileList.map(f => f.name)
    });
    
    // Add code index summary for code analysis queries
    const indexSummary = getIndexSummary();
    
    // Check if we're dealing with PDFs or documents (not code)
    const hasPdf = fileList.some(f => f.language === 'pdf' || f.name.toLowerCase().endsWith('.pdf'));
    const hasOnlyDocs = fileList.every(f => 
        f.language === 'pdf' || 
        f.name.toLowerCase().endsWith('.pdf') ||
        f.name.toLowerCase().endsWith('.md') ||
        f.name.toLowerCase().endsWith('.txt')
    );
    
    // Determine task type
    const isTranslate = /translate|convert|port\s+(?:to|this)|rewrite\s+(?:in|to)/i.test(text);
    const isFlowchart = /flowchart|diagram|flow/i.test(text);
    const isDocument = /^(?:document|generate\s+(?:full\s+)?(?:doc|documentation)|documentation|deepwiki|full\s*doc)/i.test(text);
    const isSummarize = /^(?:summarize|summary|give\s+(?:me\s+)?(?:a\s+)?summary)/i.test(text);
    const isExplain = /^(?:explain|describe)\s+(?:this|the|how)/i.test(text) && !isDocument;
    
    // Direct questions should be answered, not routed to specialized handlers
    // Use word boundaries to prevent "document" matching "do", "where" matching "what", etc.
    const isDirectQuestion = /^(?:does|is|are|can|could|will|would|has|have|do|did|what|why|how|where|when|which|should)\b/i.test(text);
    
    // New query types that use the code index - only match specific trace requests, not general questions
    const isTrace = !isDirectQuestion && /(?:^trace\s+\w|trace\s+(?:the\s+)?(?:function|method|call|symbol|variable)\s|follow\s+(?:the\s+)?call|call.?graph\s+(?:for|of)|who\s+calls|what\s+calls|find\s+usage|where\s+is\s+\w+\s+used)/i.test(text);
    const isFindBug = /^(?:find\s+bug|debug|fix\s+(?:the\s+)?error)|what(?:'s|\s+is)\s+wrong/i.test(text);
    const isEnhance = /^(?:enhance|improve|add\s+(?:a\s+)?feature|implement|extend|modify|refactor|optimize)/i.test(text);
    const isFindFunction = /^(?:find\s+(?:the\s+)?function|where\s+is\s+(?:the\s+)?(?:function|method)|locate|show\s+me\s+(?:the\s+)?(?:function|method))/i.test(text);
    
    debugLog('LOCAL', 'Task type detection', {
        isTranslate, isFlowchart, isDocument, isSummarize, isExplain,
        isDirectQuestion, isTrace, isFindBug, isEnhance, isFindFunction,
        hasPdf, hasOnlyDocs
    });
    
    // For PDFs and documents, always summarize instead of generating code documentation
    if (hasPdf || hasOnlyDocs) {
        if (isDocument || isSummarize) {
            debugLog('LOCAL', 'Using document summary prompt');
            const prompt = buildDocumentSummaryPrompt(contextContent, text);
            return await callLanguageModel(prompt);
        }
    }
    
    // Special handling for code documentation - generate .md file
    if (isDocument && !hasPdf) {
        debugLog('LOCAL', 'Generating documentation file');
        return await generateDocumentationFile(fileList, text);
    }
    
    let prompt;
    
    // Direct questions get answered directly
    if (isDirectQuestion) {
        debugLog('LOCAL', 'Using direct question prompt');
        prompt = buildDirectQuestionPrompt(contextContent, indexSummary, text);
    } else if (isTrace) {
        // Extract symbol name OR concept keywords from query
        let symbolName = null;
        let conceptKeywords = [];
        
        // First, try to extract a specific function name
        // Pattern 1: "trace functionName" where functionName looks like a real function (has underscore or camelCase)
        let symbolMatch = text.match(/trace\s+(?:the\s+)?(?:function\s+)?[`'"]*([a-zA-Z_]\w*(?:_\w+)+)/i);
        if (symbolMatch) symbolName = symbolMatch[1];
        
        // Pattern 2: "who/what calls functionName"
        if (!symbolName) {
            symbolMatch = text.match(/(?:who|what)\s+calls\s+[`'"]*([a-zA-Z_]\w+)/i);
            if (symbolMatch) symbolName = symbolMatch[1];
        }
        
        // Pattern 3: "where is functionName used"
        if (!symbolName) {
            symbolMatch = text.match(/where\s+is\s+[`'"]*([a-zA-Z_]\w+)\s+(?:used|called)/i);
            if (symbolMatch) symbolName = symbolMatch[1];
        }
        
        // Check if extracted symbol actually exists in the code index
        if (symbolName && !codeIndex.symbols.has(symbolName)) {
            // Symbol not found - treat as concept instead
            log('Symbol not in index, treating as concept:', symbolName);
            symbolName = null;
        }
        
        // If no specific function found, extract concept keywords
        if (!symbolName) {
            // Remove common trace-related words and extract meaningful keywords
            const cleanedQuery = text.toLowerCase()
                .replace(/^trace\s+(?:the\s+)?/i, '')
                .replace(/\s+(?:functionality|feature|logic|code|implementation|handling|processing)$/i, '')
                .trim();
            
            // Split into keywords
            conceptKeywords = cleanedQuery.split(/\s+/)
                .filter(w => w.length > 2 && !['the', 'and', 'for', 'how', 'does', 'this', 'that', 'with'].includes(w));
            
            log('Concept keywords extracted:', conceptKeywords);
        }
        
        // Filter out common stop words from symbolName
        const stopWords = ['the', 'this', 'that', 'function', 'method', 'call', 'trace', 'functionality', 'flow', 'code'];
        if (symbolName && stopWords.includes(symbolName.toLowerCase())) {
            symbolName = null;
        }
        
        log('Trace - symbol:', symbolName, 'concepts:', conceptKeywords);
        debugLog('EXECUTE', 'Building TRACE prompt', {
            symbolName,
            conceptKeywords,
            symbolExists: symbolName ? codeIndex.symbols.has(symbolName) : false
        });
        prompt = buildTracePrompt(contextContent, indexSummary, text, symbolName, conceptKeywords);
    } else if (isFindBug) {
        debugLog('EXECUTE', 'Building DEBUG prompt');
        prompt = buildDebugPrompt(contextContent, indexSummary, text);
    } else if (isEnhance) {
        debugLog('EXECUTE', 'Building ENHANCE prompt');
        prompt = buildEnhancePrompt(contextContent, indexSummary, text);
    } else if (isFindFunction) {
        debugLog('EXECUTE', 'Building FIND_FUNCTION prompt');
        prompt = buildFindFunctionPrompt(contextContent, indexSummary, text);
    } else if (isFlowchart) {
        debugLog('EXECUTE', 'Building FLOWCHART prompt');
        prompt = buildFlowchartPrompt(contextContent, text);
    } else if (isTranslate) {
        debugLog('EXECUTE', 'Building TRANSLATE prompt');
        // Detect target language from query or use config
        let targetLang = config.get('targetLanguage') || 'java';
        const targetMatch = text.match(/(?:to|into)\s+(java|python|c#|csharp|javascript|typescript|go|rust|c\+\+|cpp)/i);
        if (targetMatch) {
            targetLang = targetMatch[1].toLowerCase();
            if (targetLang === 'csharp') targetLang = 'c#';
            if (targetLang === 'cpp') targetLang = 'c++';
        }
        
        // STEP 1: PLAN - Extract specific file name from query
        const fileMatch = text.match(/(?:translate|convert|port)\s+(?:the\s+)?(?:file\s+)?[`'"]*([a-zA-Z0-9_\-\.]+\.[a-zA-Z]+)/i);
        let targetFile = fileMatch ? fileMatch[1] : null;
        
        debugLog('EXECUTE', 'Translate details', { targetFile, targetLang });
        
        // STEP 2: EXECUTE - Find the specific file and translate ONLY it
        let translateContent = '';
        let foundFile = null;
        
        if (targetFile) {
            // Search for the specific file in context
            for (const [path, file] of contextFiles) {
                const fileName = path.split('/').pop();
                if (fileName === targetFile || fileName.toLowerCase() === targetFile.toLowerCase()) {
                    foundFile = { path, fileName, content: file.content, language: file.language };
                    break;
                }
            }
            
            if (foundFile) {
                log('Found target file:', foundFile.fileName, 'with', foundFile.content.length, 'chars');
                translateContent = `## FILE TO TRANSLATE: ${foundFile.fileName}\n\n\`\`\`${foundFile.language}\n${foundFile.content}\n\`\`\``;
            } else {
                // File not found in context - list available files
                const availableFiles = [...contextFiles.keys()].map(p => p.split('/').pop()).join(', ');
                translateContent = `ERROR: File "${targetFile}" not found in context.\n\nAvailable files: ${availableFiles}\n\nPlease add the file to context using the 📎 button or right-click → "AstraCode: Add File to Context"`;
                
                return translateContent;
            }
        } else {
            // No specific file mentioned - if only one file, use it; otherwise ask
            if (contextFiles.size === 1) {
                const [path, file] = [...contextFiles.entries()][0];
                const fileName = path.split('/').pop();
                foundFile = { path, fileName, content: file.content, language: file.language };
                translateContent = `## FILE TO TRANSLATE: ${fileName}\n\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
            } else if (contextFiles.size > 1) {
                // Multiple files - ask which one to translate
                const fileList = [...contextFiles.keys()].map(p => `- ${p.split('/').pop()}`).join('\n');
                return `You have ${contextFiles.size} files in context. Which one would you like to translate?\n\n${fileList}\n\nPlease specify, e.g.: "translate parse_relation.c to Java"`;
            } else {
                return 'No files in context. Please add the file you want to translate using the 📎 button.';
            }
        }
        
        prompt = buildTranslatePrompt(translateContent, text, targetLang, foundFile?.fileName);
    } else if (isExplain) {
        debugLog('EXECUTE', 'Building EXPLAIN prompt');
        prompt = buildExplainPrompt(contextContent + indexSummary, text);
    } else if (isSummarize) {
        debugLog('EXECUTE', 'Building SUMMARIZE prompt');
        prompt = buildDocumentSummaryPrompt(contextContent, text);
    } else {
        debugLog('EXECUTE', 'Building GENERAL prompt (no specific type matched)');
        prompt = buildGeneralPrompt(contextContent + indexSummary, text);
    }
    
    // Log final prompt details before calling LLM
    debugLog('EXECUTE', 'Final prompt ready', {
        promptLength: prompt.length,
        promptPreview: prompt.substring(0, 200) + '...'
    });
    
    // Call LLM via VS Code Language Model API
    return await callLanguageModel(prompt);
}

// Build prompt for tracing functionality
function buildTracePrompt(context, indexSummary, query, symbolName, conceptKeywords = []) {
    log('buildTracePrompt called with symbol:', symbolName, 'concepts:', conceptKeywords);
    
    // CASE 1: Specific function trace
    if (symbolName && codeIndex.symbols.has(symbolName)) {
        const grep = grepCodeForSymbol(symbolName);
        let symbolCode = '';
        let callGraphText = '';
        let grepResults = '';
        let callersInfo = '';
        
        if (grep.definition) {
            symbolCode = `\n## FUNCTION DEFINITION (${grep.definition.fileName}:${grep.definition.line}):\n\`\`\`c\n${grep.definition.code}\n\`\`\`\n`;
        }
        
        if (grep.calls.length > 0) {
            grepResults = `\n## ALL CALLS TO ${symbolName} (${grep.calls.length} found):\n`;
            for (const call of grep.calls.slice(0, 15)) {
                grepResults += `- **${call.fileName}:${call.line}**: \`${call.code.substring(0, 80)}\`\n`;
            }
        }
        
        if (codeIndex.callGraph.has(symbolName)) {
            const callGraph = buildCallGraphFromSymbol(symbolName, 4);
            callGraphText = formatCallGraphAsText(callGraph);
        }
        
        const callers = codeIndex.reverseCallGraph.get(symbolName);
        if (callers && callers.size > 0) {
            callersInfo = `\n## CALLERS (${callers.size}):\n`;
            for (const caller of [...callers].slice(0, 10)) {
                const sym = codeIndex.symbols.get(caller);
                callersInfo += `- ${caller} (${sym?.file?.split('/').pop()}:${sym?.line})\n`;
            }
        }
        
        return `TRACE THE FUNCTION "${symbolName}" - DO NOT SUMMARIZE FILES.

${symbolCode}
${callGraphText}
${callersInfo}
${grepResults}

SOURCE CODE:
${context}

QUERY: ${query}

INSTRUCTIONS:
1. What does ${symbolName} do?
2. Show the call flow: callers → ${symbolName} → callees
3. What variables does it use?
4. Step through the logic
5. How does it handle errors?

DO NOT summarize each file. ONLY trace ${symbolName}.`;
    }
    
    // CASE 2: CONCEPT/FEATURE TRACE (e.g., "range bound functionality")
    if (conceptKeywords.length > 0) {
        log('Building concept trace for:', conceptKeywords);
        
        // GREP all files for each keyword - this is the primary source of truth
        const keywordMatches = new Map(); // keyword -> [{file, line, code}]
        const lineMatches = new Map();    // "file:line" -> {file, line, code, keywords:[]}
        
        for (const keyword of conceptKeywords) {
            keywordMatches.set(keyword, []);
            
            // Search through all context files
            for (const [filePath, file] of contextFiles) {
                const lines = file.content.split('\n');
                const fileName = filePath.split('/').pop();
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.toLowerCase().includes(keyword.toLowerCase())) {
                        const key = `${fileName}:${i + 1}`;
                        const match = { fileName, line: i + 1, code: line.trim() };
                        
                        keywordMatches.get(keyword).push(match);
                        
                        if (!lineMatches.has(key)) {
                            lineMatches.set(key, { ...match, keywords: [keyword] });
                        } else {
                            lineMatches.get(key).keywords.push(keyword);
                        }
                    }
                }
            }
        }
        
        log('Grep found matches:', lineMatches.size);
        
        // Sort matches by number of keyword hits (more = more relevant)
        const sortedMatches = [...lineMatches.values()]
            .sort((a, b) => b.keywords.length - a.keywords.length);
        
        // Find function definitions containing keywords
        const functionDefs = [];
        const structDefs = [];
        
        for (const match of sortedMatches) {
            const code = match.code;
            // Function definition patterns (C-style)
            if (code.match(/^\s*(?:static\s+)?(?:\w+\s+)+\w+\s*\([^)]*\)\s*(?:\{|$)/) ||
                code.match(/^(?:static\s+)?(?:inline\s+)?\w+\s*\*?\s+\w+\s*\(/) ||
                code.match(/^\w+\s+\w+\s*\([^)]*\)$/)) {
                functionDefs.push(match);
            }
            // Struct/type definition patterns
            else if (code.match(/^\s*(?:typedef\s+)?(?:struct|union|enum)\s+\w*/)) {
                structDefs.push(match);
            }
        }
        
        log('Found function defs:', functionDefs.length, 'struct defs:', structDefs.length);
        
        // Build the prompt - GREP RESULTS FIRST, then instructions
        const conceptName = conceptKeywords.join(' ').toUpperCase();
        
        // Start with SYSTEM INSTRUCTION (critical for LLM behavior)
        let output = `[SYSTEM: You are in TRACE MODE. Your task is to trace the "${conceptName}" feature through the code. DO NOT summarize files. DO NOT describe what each file does. Instead, trace how the feature works from start to finish.]

# TRACE REQUEST: ${conceptName}

`;

        // Show search results summary
        output += `## Search Results Summary\n\n`;
        let totalMatches = 0;
        for (const [keyword, matches] of keywordMatches) {
            output += `- "${keyword}": ${matches.length} occurrences\n`;
            totalMatches += matches.length;
        }
        output += `- **Total**: ${totalMatches} matches found\n\n`;
        
        // Show function definitions (MOST IMPORTANT)
        if (functionDefs.length > 0) {
            output += `## Functions Related to "${conceptName}" (${functionDefs.length} found)\n\n`;
            output += `These are the functions you should trace:\n\n`;
            for (const def of functionDefs.slice(0, 10)) {
                output += `### ${def.fileName}:${def.line}\n`;
                output += `Keywords: ${def.keywords.join(', ')}\n`;
                output += `\`\`\`c\n${def.code}\n\`\`\`\n\n`;
            }
        } else {
            output += `## No Function Definitions Found\n\nSearch the source files below for functions related to "${conceptName}".\n\n`;
        }
        
        // Show struct definitions
        if (structDefs.length > 0) {
            output += `## Data Structures for "${conceptName}" (${structDefs.length} found)\n\n`;
            for (const def of structDefs.slice(0, 6)) {
                output += `- **${def.fileName}:${def.line}**: \`${def.code}\`\n`;
            }
            output += `\n`;
        }
        
        // Show highly relevant lines (multiple keyword matches)
        const multiKeywordMatches = sortedMatches.filter(m => m.keywords.length > 1);
        if (multiKeywordMatches.length > 0) {
            output += `## Most Relevant Lines (matching multiple keywords)\n\n`;
            for (const match of multiKeywordMatches.slice(0, 12)) {
                output += `- **${match.fileName}:${match.line}** [${match.keywords.join('+')}]: \`${match.code.substring(0, 60)}...\`\n`;
            }
            output += `\n`;
        }
        
        // Add full source files
        output += `## Source Files\n\n${context}\n\n`;
        
        // User query
        output += `## User Query\n\n${query}\n\n`;
        
        // INSTRUCTIONS AT THE END (recency bias helps LLMs follow these)
        output += `---

# YOUR TASK

You are tracing the **${conceptName}** feature. Follow this exact structure:

## 1. What is ${conceptName}?
Explain in 2-3 sentences what this feature does.

## 2. Entry Point Functions
Which functions START the ${conceptName} process? List them with file:line.

## 3. Call Flow
Show how execution flows through the code:
\`\`\`
main_function()
├── calls helper1()
│   └── calls helper1a()
├── calls helper2()
└── returns result
\`\`\`

## 4. Key Data Structures
What structs/types are used? Explain their fields.

## 5. Step-by-Step Logic
Walk through how ${conceptName} works:
1. First, X happens...
2. Then, Y is called...
3. Finally, Z returns...

## 6. Key Variables
What are the important variables and how do they flow?

---

**CRITICAL RULES:**
- DO NOT write "## Makefile" or "## meson.build" sections
- DO NOT summarize what each file contains
- DO NOT give a general overview
- ONLY trace the ${conceptName} feature

Start your response with "## 1. What is ${conceptName}?"`;
        
        return output;
    }
    
    // CASE 3: Symbol requested but not found in index - grep for it
    if (symbolName) {
        const grep = grepCodeForSymbol(symbolName);
        let grepInfo = '';
        
        if (grep.all.length > 0) {
            grepInfo = `## GREP RESULTS for "${symbolName}" (${grep.all.length} occurrences):\n`;
            for (const ref of grep.all.slice(0, 25)) {
                grepInfo += `- ${ref.fileName}:${ref.line}: \`${ref.code.substring(0, 70)}\`\n`;
            }
        }
        
        return `Find and trace "${symbolName}" in the code.

${grepInfo}

${context}

QUERY: ${query}

Find "${symbolName}" and trace:
1. Where it's defined
2. What calls it
3. What it calls  
4. Execution flow
5. Key variables

Focus on "${symbolName}" only.`;
    }
    
    // CASE 4: Generic trace (no symbol, no concepts)
    return `Trace the code for: ${query}

${context}

${indexSummary}

Show:
1. Entry points
2. Call flow  
3. Key variables
4. Data flow`;
}

// Build prompt for debugging/finding bugs
function buildDebugPrompt(context, indexSummary, query) {
    return `Analyze this code for potential bugs and issues.

${context}

${indexSummary}

USER REQUEST: ${query}

Perform a thorough code review:

## Potential Issues Found
List each issue with:
- **Location**: File and line number
- **Issue**: What's wrong
- **Severity**: Critical / High / Medium / Low
- **Fix**: Suggested solution

## Code Smells
Identify any code quality issues:
- Duplicate code
- Long functions
- Missing error handling
- Hardcoded values
- etc.

## Security Concerns
Check for:
- Input validation issues
- Injection vulnerabilities
- Buffer overflows (for C/C++)
- etc.

## Recommended Fixes
Provide specific code changes to fix the issues.

Be specific with file names and line numbers from the code provided.`;
}

// Build prompt for code enhancement
function buildEnhancePrompt(context, indexSummary, query) {
    // Extract keywords from the enhancement request
    const keywords = query.toLowerCase()
        .replace(/enhance|add|implement|create|build|make|improve|modify|change|update|support|feature|functionality/gi, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['this', 'that', 'with', 'from', 'into', 'should', 'would', 'could', 'need', 'want'].includes(w));
    
    log('Enhancement keywords:', keywords);
    
    // Search code for relevant sections
    let relevantCode = '';
    let insertionPoints = '';
    const foundLocations = new Map();
    
    // Search for each keyword in the code
    for (const keyword of keywords.slice(0, 5)) {
        const grep = grepCodeForSymbol(keyword);
        if (grep.all.length > 0) {
            for (const ref of grep.all.slice(0, 5)) {
                const key = `${ref.fileName}:${ref.line}`;
                if (!foundLocations.has(key)) {
                    foundLocations.set(key, ref);
                }
            }
        }
    }
    
    if (foundLocations.size > 0) {
        relevantCode = `\n## RELEVANT CODE LOCATIONS (grep results):\n`;
        for (const [loc, ref] of foundLocations) {
            relevantCode += `- **${loc}**: \`${ref.code.substring(0, 70)}...\`\n`;
        }
    }
    
    // Identify potential insertion points based on code structure
    insertionPoints = `\n## POTENTIAL INSERTION POINTS:\n`;
    
    // Find main functions, classes, entry points
    const entryPoints = [];
    const utilities = [];
    const dataStructures = [];
    
    for (const [name, symbol] of codeIndex.symbols) {
        if (name.includes('@')) continue;
        
        // Entry points (main, init, etc.)
        if (/^(main|init|start|run|execute|process|handle)/i.test(name)) {
            entryPoints.push({ name, file: symbol.file?.split('/').pop(), line: symbol.line });
        }
        
        // Utility functions
        if (/^(get|set|create|build|parse|validate|check|is_|has_)/i.test(name)) {
            utilities.push({ name, file: symbol.file?.split('/').pop(), line: symbol.line });
        }
        
        // Data structures
        if (['struct', 'class', 'interface', 'record', 'type'].includes(symbol.type)) {
            dataStructures.push({ name, file: symbol.file?.split('/').pop(), line: symbol.line });
        }
    }
    
    if (entryPoints.length > 0) {
        insertionPoints += `\n**Entry Points (good for calling new functionality):**\n`;
        for (const ep of entryPoints.slice(0, 5)) {
            insertionPoints += `- ${ep.name} at ${ep.file}:${ep.line}\n`;
        }
    }
    
    if (dataStructures.length > 0) {
        insertionPoints += `\n**Data Structures (may need new fields):**\n`;
        for (const ds of dataStructures.slice(0, 5)) {
            insertionPoints += `- ${ds.name} at ${ds.file}:${ds.line}\n`;
        }
    }
    
    if (utilities.length > 0) {
        insertionPoints += `\n**Utility Functions (patterns to follow):**\n`;
        for (const util of utilities.slice(0, 5)) {
            insertionPoints += `- ${util.name} at ${util.file}:${util.line}\n`;
        }
    }
    
    // Get file summary
    let fileSummary = `\n## FILES IN CONTEXT:\n`;
    for (const [path, file] of contextFiles) {
        const fileName = path.split('/').pop();
        const lineCount = file.content.split('\n').length;
        const symbols = codeIndex.files.get(path)?.symbols || [];
        const funcCount = symbols.filter(s => ['function', 'method', 'procedure'].includes(s.type)).length;
        fileSummary += `- **${fileName}** (${lineCount} lines, ${funcCount} functions)\n`;
    }
    
    return `Analyze this code and identify WHERE to implement the requested enhancement.

${context}

${indexSummary}
${fileSummary}
${relevantCode}
${insertionPoints}

USER REQUEST: ${query}

## ENHANCEMENT ANALYSIS INSTRUCTIONS:

### 1. UNDERSTAND THE REQUEST
- What specific functionality is being requested?
- What inputs/outputs are needed?
- What constraints or requirements are mentioned?

### 2. IDENTIFY EXACT INSERTION POINTS
For each change needed, specify:

**File:** [filename]
**Line:** [line number or "after line X" / "before function Y"]
**Change Type:** [new function / modify existing / add to struct / new file]
**Reason:** Why this location?

Example:
\`\`\`
File: partbounds.c
Line: After line 234 (after check_new_partition function)
Change Type: New function
Reason: Related to partition validation, follows existing pattern
\`\`\`

### 3. IMPLEMENTATION PLAN
1. **Step 1:** [What to do first, with specific file:line]
2. **Step 2:** [Next change]
3. **Step 3:** [etc.]

### 4. CODE CHANGES
For each insertion point, show the exact code:

**File: [filename], Line: [number]**
\`\`\`[language]
// The new or modified code
\`\`\`

### 5. INTEGRATION
- How does the new code connect to existing code?
- What existing functions need to call the new code?
- What data structures need updates?

### 6. TESTING
- How to verify the enhancement works?
- Edge cases to consider?

BE SPECIFIC about file names and line numbers. Don't give vague instructions.`;
}

// Build prompt for finding functions
function buildFindFunctionPrompt(context, indexSummary, query) {
    // Try to extract what they're looking for
    const searchTerms = query.toLowerCase()
        .replace(/find|locate|where|is|show|me|the|function|method|procedure|that|which|does/gi, '')
        .trim();
    
    return `Find and explain the relevant code based on the user's query.

${context}

${indexSummary}

USER REQUEST: ${query}

Based on the code index, locate the relevant functions/code:

## Found Matches
List the functions/methods that match the query:
- **Name**: Function name
- **Location**: File:line
- **Purpose**: What it does
- **Signature**: Parameters and return type

## Code Snippets
Show the relevant code for each match.

## Usage Examples
Show where and how each function is called.

## Related Functions
List related functions that work together.

Use the code index to provide accurate locations.`;
}

// Build prompt for document/PDF summarization
function buildDocumentSummaryPrompt(context, query) {
    return `Analyze and summarize the following document content.

${context}

USER REQUEST: ${query}

Provide a comprehensive summary that includes:

## Document Overview
[What is this document about? 2-3 sentences]

## Key Points
- [Main point 1]
- [Main point 2]
- [Main point 3]
- [Continue as needed]

## Detailed Summary
[Provide a detailed summary of the document's content, organized by sections or topics]

## Important Details
[List any specific data, dates, figures, requirements, or technical specifications mentioned]

## Conclusions/Recommendations
[If applicable, summarize any conclusions or recommendations from the document]

Be thorough but concise. Focus on the most important information.`;
}

// Generate comprehensive documentation as a .md file
async function generateDocumentationFile(fileList, query, docType = 'technical') {
    log('=== GENERATING DOCUMENTATION ===');
    log('Documentation type:', docType);
    log('Files:', fileList.length);
    fileList.forEach(f => log('  -', f.name, '|', f.language, '|', f.size, 'chars'));
    
    debugLog('DOCS', `Starting ${docType} documentation generation`, {
        files: fileList.length,
        docType
    });
    
    if (fileList.length === 0) {
        log('ERROR: No files to document');
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `❌ No files in context to document. Add files first.`
        });
        return 'No files to document';
    }
    
    // Route to appropriate documentation generator
    if (docType === 'business') {
        return await generateBusinessDocumentation(fileList, query);
    }
    
    // Default: Technical documentation (original behavior)
    return await generateTechnicalDocumentation(fileList, query);
}

/**
 * Generate Business Documentation (BRD-style)
 * Focus on WHAT the code does, WHY it matters, customer value
 */
async function generateBusinessDocumentation(fileList, query) {
    const projectName = getProjectName(fileList);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const fileName = `${projectName}-business-documentation-${timestamp}.md`;
    
    // Business documentation structure
    let documentation = `# ${projectName} - Business Documentation
    
> **Document Type:** Business Requirements & Capabilities Overview
> **Generated by:** AstraCode
> **Date:** ${new Date().toLocaleDateString()}
> **Source Files Analyzed:** ${fileList.length}

---

## Executive Summary

`;

    // Show progress
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `📊 **Generating Business Documentation**\n\nProject: **${projectName}**\nFiles: ${fileList.length}\nFocus: Business value & capabilities\n\n---\n\n`
    });

    // Generate executive summary
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Generating executive summary...\n\n`
    });

    const summaryPrompt = buildBusinessSummaryPrompt(fileList);
    const summary = await callLanguageModelForDoc(summaryPrompt);
    if (summary.error) {
        documentation += `*This section describes the high-level business purpose of the system.*\n\n`;
        documentation += generateIndexBasedBusinessSummary(fileList) + '\n\n';
    } else {
        documentation += summary.text + '\n\n';
    }

    documentation += `---\n\n## Business Capabilities\n\n`;

    // Generate business capabilities
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Identifying business capabilities...\n\n`
    });

    const capabilitiesPrompt = buildBusinessCapabilitiesPrompt(fileList);
    const capabilities = await callLanguageModelForDoc(capabilitiesPrompt);
    if (capabilities.error) {
        documentation += generateIndexBasedCapabilities(fileList) + '\n\n';
    } else {
        documentation += capabilities.text + '\n\n';
    }

    documentation += `---\n\n## User Stories & Use Cases\n\n`;

    // Generate user stories
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Deriving user stories...\n\n`
    });

    const storiesPrompt = buildUserStoriesPrompt(fileList);
    const stories = await callLanguageModelForDoc(storiesPrompt);
    if (stories.error) {
        documentation += `*User stories derived from code analysis.*\n\n`;
    } else {
        documentation += stories.text + '\n\n';
    }

    documentation += `---\n\n## Business Rules & Logic\n\n`;

    // Generate business rules
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Extracting business rules...\n\n`
    });

    const rulesPrompt = buildBusinessRulesPrompt(fileList);
    const rules = await callLanguageModelForDoc(rulesPrompt);
    if (rules.error) {
        documentation += generateIndexBasedBusinessRules(fileList) + '\n\n';
    } else {
        documentation += rules.text + '\n\n';
    }

    documentation += `---\n\n## Data & Information Flow\n\n`;

    // Generate data flow (business perspective)
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Mapping information flow...\n\n`
    });

    const dataFlowPrompt = buildBusinessDataFlowPrompt(fileList);
    const dataFlow = await callLanguageModelForDoc(dataFlowPrompt);
    if (dataFlow.error) {
        documentation += `*Information flow through the system.*\n\n`;
    } else {
        documentation += dataFlow.text + '\n\n';
    }

    documentation += `---\n\n## Integration Points & Dependencies\n\n`;

    // Generate integrations
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Identifying integrations...\n\n`
    });

    const integrationsPrompt = buildIntegrationsPrompt(fileList);
    const integrations = await callLanguageModelForDoc(integrationsPrompt);
    if (integrations.error) {
        documentation += `*External systems and integration points.*\n\n`;
    } else {
        documentation += integrations.text + '\n\n';
    }

    // Add glossary section
    documentation += `---\n\n## Glossary of Business Terms\n\n`;
    
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Building glossary...\n\n`
    });

    const glossaryPrompt = buildGlossaryPrompt(fileList);
    const glossary = await callLanguageModelForDoc(glossaryPrompt);
    if (!glossary.error) {
        documentation += glossary.text + '\n\n';
    }

    // Add footer
    documentation += `---

*Generated by AstraCode - Business Documentation Mode*
`;

    // Save the file
    return await saveDocumentationFile(documentation, fileName);
}

/**
 * Generate Technical Documentation (enhanced with Summary, Entry Points, Data Structures, Call Graph)
 */
async function generateTechnicalDocumentation(fileList, query) {
    
    // Determine project name from common path or first file
    const projectName = getProjectName(fileList);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const fileName = `${projectName}-documentation-${timestamp}.md`;
    
    log('Project name:', projectName, '| Output file:', fileName);
    
    // Filter out build files for analysis (but keep them in fileList for reference)
    const BUILD_FILES_PATTERN = /^(makefile|gnumakefile|meson\.build|cmakelists\.txt|readme|readme\.md|changelog|license|configure\.ac)$/i;
    const codeFiles = fileList.filter(f => !BUILD_FILES_PATTERN.test(f.name.toLowerCase()));
    
    // Start building the documentation
    let documentation = `# ${projectName} Documentation

> Generated by AstraCode
> Date: ${new Date().toLocaleDateString()}
> Files analyzed: ${fileList.length} (${codeFiles.length} code files)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Entry Points](#entry-points)
3. [Key Data Structures](#key-data-structures)
4. [Call Graph](#call-graph)
5. [Architecture](#architecture)
6. [Module Reference](#module-reference)
${codeFiles.slice(0, 20).map((f, i) => `   - [${f.name}](#${f.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()})`).join('\n')}
7. [Data Flow](#data-flow)
8. [Dependencies](#dependencies)

---

`;

    // Show progress
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `📄 **Generating Documentation**\n\nProject: **${projectName}**\nFiles: ${fileList.length} (${codeFiles.length} code files)\n\n---\n\n`
    });

    // ================================================================
    // SECTION 1: EXECUTIVE SUMMARY
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Generating executive summary...\n\n`
    });

    documentation += `## Executive Summary\n\n`;
    
    const summaryPrompt = `Analyze these code files and provide an EXECUTIVE SUMMARY for developers.

FILES:
${codeFiles.slice(0, 15).map(f => `- ${f.name}`).join('\n')}

CODE INDEX (functions found):
${Array.from(codeIndex.symbols.entries())
    .filter(([k, s]) => k.includes('@') && codeFiles.some(f => s.file?.includes(f.name)))
    .slice(0, 50)
    .map(([k, s]) => `- ${s.name} (${s.type}) in ${pathUtils.getFileName(s.file)}:${s.line}`)
    .join('\n')}

Write a 3-5 paragraph technical summary that covers:
1. **Purpose**: What does this code do? What problem does it solve?
2. **Core Mechanism**: How does it work at a high level? What's the main algorithm or approach?
3. **Key Components**: What are the main modules/files and their responsibilities?
4. **Data Flow**: How does data move through the system?
5. **Developer Notes**: What should a developer understand before modifying this code?

Be specific and technical. Reference actual function names and file names from the code.`;

    const summary = await callLanguageModelForDoc(summaryPrompt);
    if (summary.error) {
        documentation += generateIndexBasedOverview(fileList) + '\n\n';
    } else {
        documentation += summary.text + '\n\n';
    }
    documentation += `---\n\n`;

    // ================================================================
    // SECTION 2: ENTRY POINTS
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Identifying entry points...\n\n`
    });

    documentation += `## Entry Points\n\n`;
    documentation += `These are the main functions where execution begins or external calls enter the module:\n\n`;
    documentation += `| Function | File | Line | Purpose |\n`;
    documentation += `|:---------|:-----|:-----|:--------|\n`;

    // Find entry points from code index - functions that are called but don't call others much,
    // or have names suggesting entry points
    const entryPointPatterns = /^(main|init|start|create|transform|parse|handle|process|execute|run)/i;
    const entryPoints = [];
    
    for (const [key, symbol] of codeIndex.symbols) {
        if (!key.includes('@')) continue;
        if (!codeFiles.some(f => symbol.file?.includes(f.name))) continue;
        if (!['function', 'procedure', 'method'].includes(symbol.type)) continue;
        
        const callers = codeIndex.reverseCallGraph.get(symbol.name);
        const callees = codeIndex.callGraph.get(symbol.name);
        const callerCount = callers?.size || 0;
        const calleeCount = callees?.size || 0;
        
        // Entry point heuristics: called by others but also calls many others (orchestrator)
        // OR has entry-point-like name
        if ((callerCount > 0 && calleeCount >= 3) || entryPointPatterns.test(symbol.name)) {
            entryPoints.push({
                name: symbol.name,
                file: pathUtils.getFileName(symbol.file),
                line: symbol.line,
                callers: callerCount,
                callees: calleeCount
            });
        }
    }
    
    // Sort by callees (most connected first) and take top 10
    entryPoints.sort((a, b) => b.callees - a.callees);
    
    if (entryPoints.length > 0) {
        for (const ep of entryPoints.slice(0, 10)) {
            documentation += `| \`${ep.name}()\` | ${ep.file} | ${ep.line} | Called by ${ep.callers}, calls ${ep.callees} functions |\n`;
        }
    } else {
        documentation += `| - | No clear entry points identified | - | - |\n`;
    }
    documentation += `\n---\n\n`;

    // ================================================================
    // SECTION 3: KEY DATA STRUCTURES
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Extracting key data structures...\n\n`
    });

    documentation += `## Key Data Structures\n\n`;
    documentation += `| Structure | File | Line | Type |\n`;
    documentation += `|:----------|:-----|:-----|:-----|\n`;

    const dataStructures = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (!key.includes('@')) continue;
        if (!codeFiles.some(f => symbol.file?.includes(f.name))) continue;
        if (!['struct', 'class', 'type', 'typedef', 'enum'].includes(symbol.type)) continue;
        
        dataStructures.push({
            name: symbol.name,
            file: pathUtils.getFileName(symbol.file),
            line: symbol.line,
            type: symbol.type
        });
    }
    
    if (dataStructures.length > 0) {
        for (const ds of dataStructures.slice(0, 15)) {
            documentation += `| \`${ds.name}\` | ${ds.file} | ${ds.line} | ${ds.type} |\n`;
        }
    } else {
        documentation += `| - | No structures found in code index | - | - |\n`;
    }
    documentation += `\n---\n\n`;

    // ================================================================
    // SECTION 4: CALL GRAPH (2 levels)
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Building call graph (2 levels)...\n\n`
    });

    documentation += `## Call Graph\n\n`;
    documentation += `This shows the call relationships between functions (2 levels deep):\n\n`;
    documentation += `\`\`\`\n`;

    // Build call graph for top entry points
    const graphEntries = entryPoints.slice(0, 5);
    if (graphEntries.length > 0) {
        for (const ep of graphEntries) {
            documentation += `${ep.name}()\n`;
            const callees = codeIndex.callGraph.get(ep.name);
            if (callees && callees.size > 0) {
                const calleeArray = Array.from(callees).slice(0, 8);
                calleeArray.forEach((callee, idx) => {
                    const isLast = idx === calleeArray.length - 1;
                    const prefix = isLast ? '└──' : '├──';
                    documentation += `  ${prefix} ${callee}()\n`;
                    
                    // Level 2: What does this callee call?
                    const level2Callees = codeIndex.callGraph.get(callee);
                    if (level2Callees && level2Callees.size > 0) {
                        const l2Array = Array.from(level2Callees).slice(0, 4);
                        l2Array.forEach((l2, l2idx) => {
                            const l2IsLast = l2idx === l2Array.length - 1;
                            const l2Prefix = isLast ? '    ' : '│   ';
                            const l2Arrow = l2IsLast ? '└──' : '├──';
                            documentation += `  ${l2Prefix}${l2Arrow} ${l2}()\n`;
                        });
                        if (level2Callees.size > 4) {
                            const l2Prefix = isLast ? '    ' : '│   ';
                            documentation += `  ${l2Prefix}    ... +${level2Callees.size - 4} more\n`;
                        }
                    }
                });
                if (callees.size > 8) {
                    documentation += `  ... +${callees.size - 8} more callees\n`;
                }
            }
            documentation += `\n`;
        }
    } else {
        documentation += `No call graph data available. Rebuild index to generate call relationships.\n`;
    }
    documentation += `\`\`\`\n\n---\n\n`;

    // ================================================================
    // SECTION 5: ARCHITECTURE (LLM-generated)
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Analyzing architecture...\n\n`
    });

    const archPrompt = buildArchitecturePrompt(codeFiles);
    const architecture = await callLanguageModelForDoc(archPrompt);
    if (architecture.error) {
        documentation += generateIndexBasedArchitecture(fileList) + '\n\n---\n\n';
    } else {
        documentation += `## Architecture\n\n${architecture.text}\n\n---\n\n`;
    }

    // ================================================================
    // SECTION 6: MODULE REFERENCE (file-by-file)
    // ================================================================
    documentation += `## Module Reference\n\n`;
    
    // Only document code files, not build files
    for (let i = 0; i < codeFiles.length; i++) {
        const file = codeFiles[i];
        const fileContent = contextFiles.get(file.path)?.content || '';
        
        log(`Documenting file ${i + 1}/${codeFiles.length}: ${file.name} (${fileContent.length} chars)`);
        
        if (fileContent.length === 0) {
            log('WARNING: Empty content for file:', file.path);
            documentation += `### ${file.name}\n\n*File content not available.*\n\n---\n\n`;
            continue;
        }
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `⏳ Documenting ${file.name} (${i + 1}/${codeFiles.length})...\n`
        });

        const filePrompt = buildFileDocPrompt(file.name, fileContent);
        log('File prompt length:', filePrompt.length);
        
        const fileDoc = await callLanguageModelForDoc(filePrompt);
        
        documentation += `### ${file.name}\n\n`;
        if (fileDoc.error) {
            log('File doc error:', fileDoc.error, '- using fallback');
            documentation += generateIndexBasedFileDoc(file.path, file.name) + '\n\n---\n\n';
        } else {
            log('File doc success, length:', fileDoc.text?.length || 0);
            documentation += fileDoc.text + '\n\n---\n\n';
        }
    }

    // ================================================================
    // SECTION 7: DATA FLOW
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Analyzing data flow...\n\n`
    });

    const dataFlowPrompt = buildDataFlowPrompt(codeFiles);
    const dataFlow = await callLanguageModelForDoc(dataFlowPrompt);
    if (dataFlow.error) {
        documentation += generateIndexBasedDataFlow(fileList) + '\n\n---\n\n';
    } else {
        documentation += `## Data Flow\n\n${dataFlow.text}\n\n---\n\n`;
    }

    // ================================================================
    // SECTION 8: DEPENDENCIES
    // ================================================================
    chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: `⏳ Mapping dependencies...\n\n`
    });

    const depsPrompt = buildDependenciesPrompt(codeFiles);
    const dependencies = await callLanguageModelForDoc(depsPrompt);
    if (dependencies.error) {
        documentation += generateIndexBasedDependencies(fileList) + '\n\n';
    } else {
        documentation += `## Dependencies\n\n${dependencies.text}\n\n`;
    }

    // Add footer
    documentation += `---

*Generated by AstraCode - Technical Documentation*
`;

    // Save the file
    return await saveDocumentationFile(documentation, fileName);
}

/**
 * Clean up old documentation files (older than 4 hours)
 * Only deletes .md files that match AstraCode naming pattern
 */
async function cleanupOldDocumentationFiles(astraDir) {
    try {
        const FOUR_HOURS_MS = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
        const now = Date.now();
        
        // Read directory contents
        const entries = await vscode.workspace.fs.readDirectory(astraDir);
        
        let deletedCount = 0;
        for (const [name, type] of entries) {
            // Only process .md files that look like our generated documentation
            if (type !== vscode.FileType.File) continue;
            if (!name.endsWith('.md')) continue;
            
            // Check if it matches our naming pattern: *-documentation-*.md or *-business-documentation-*.md
            if (!name.includes('-documentation-')) continue;
            
            const fileUri = vscode.Uri.joinPath(astraDir, name);
            
            try {
                // Get file stats
                const stat = await vscode.workspace.fs.stat(fileUri);
                const fileAge = now - stat.mtime;
                
                if (fileAge > FOUR_HOURS_MS) {
                    await vscode.workspace.fs.delete(fileUri);
                    deletedCount++;
                    log(`Cleaned up old documentation: ${name} (age: ${Math.round(fileAge / 60000)} minutes)`);
                }
            } catch (statError) {
                // File might have been deleted already, skip
                log(`Could not stat file ${name}: ${statError.message}`);
            }
        }
        
        if (deletedCount > 0) {
            debugLog('DOCS', `Cleaned up ${deletedCount} old documentation file(s)`);
        }
        
    } catch (error) {
        // Don't fail if cleanup fails - it's not critical
        log('Documentation cleanup error (non-critical):', error.message);
    }
}

/**
 * Save documentation file and show completion message
 */
async function saveDocumentationFile(documentation, fileName) {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        let fileUri;
        let astraDir;
        
        if (workspaceFolder) {
            // Save to .astra folder in workspace
            astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra');
            await vscode.workspace.fs.createDirectory(astraDir);
            fileUri = vscode.Uri.joinPath(astraDir, fileName);
            
            // Clean up old documentation files (older than 4 hours)
            await cleanupOldDocumentationFiles(astraDir);
        } else {
            // Save to temp location (use pathUtils for cross-platform compatibility)
            const tmpDir = require('os').tmpdir();
            fileUri = vscode.Uri.file(pathUtils.joinPath(tmpDir, fileName));
        }
        
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(documentation, 'utf-8'));
        
        debugLog('DOCS', 'Documentation saved', {
            path: fileUri.fsPath,
            platform: process.platform,
            size: documentation.length
        });
        
        // Open the file - use async/await properly and add delays for Windows
        let openedSuccessfully = false;
        let previewOpened = false;
        
        try {
            debugLog('DOCS', 'Opening text document...');
            const doc = await vscode.workspace.openTextDocument(fileUri);
            
            debugLog('DOCS', 'Showing text document...');
            await vscode.window.showTextDocument(doc, { 
                preview: false, 
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: false  // Focus on the new document
            });
            openedSuccessfully = true;
            
            // Small delay before trying markdown preview (helps on Windows)
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // Try to open markdown preview
            debugLog('DOCS', 'Opening markdown preview...');
            try {
                await vscode.commands.executeCommand('markdown.showPreview', fileUri);
                previewOpened = true;
                debugLog('DOCS', 'Markdown preview opened successfully');
            } catch (previewError) {
                debugLog('DOCS', `Markdown preview failed: ${previewError.message}`);
                // Preview failed, but document is still open - that's ok
            }
            
        } catch (openError) {
            debugLog('DOCS', `Error opening document: ${openError.message}`);
            // Try alternative method - reveal in explorer
            try {
                await vscode.commands.executeCommand('revealFileInOS', fileUri);
            } catch (revealError) {
                debugLog('DOCS', `Reveal in OS also failed: ${revealError.message}`);
            }
        }
        
        // Build completion message with clickable link
        const filePathDisplay = fileUri.fsPath;
        const openCommand = `command:vscode.open?${encodeURIComponent(JSON.stringify([fileUri.toString()]))}`;
        
        let completionMessage = `\n\n✅ **Documentation Complete!**\n\n`;
        completionMessage += `📄 **File saved to:** \`${filePathDisplay}\`\n\n`;
        
        // Add clickable link to open the file
        completionMessage += `👉 **[Click here to open the documentation](${openCommand})**\n\n`;
        
        if (openedSuccessfully) {
            if (previewOpened) {
                completionMessage += `*The documentation has been opened with Markdown preview.*`;
            } else {
                completionMessage += `*The documentation has been opened. Use Ctrl+Shift+V (Cmd+Shift+V on Mac) to open Markdown preview.*`;
            }
        } else {
            completionMessage += `*Could not auto-open the file. Please open it manually from the path above.*`;
        }
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: completionMessage
        });
        
        // Also send a separate message with just the file link for easy access
        chatWebviewView?.webview.postMessage({ 
            type: 'documentationComplete', 
            filePath: fileUri.fsPath,
            fileUri: fileUri.toString()
        });
        
        return `Documentation generated successfully! See the new tab for rendered output.`;
        
    } catch (error) {
        debugLog('DOCS', `Error saving documentation: ${error.message}`);
        
        // Return the documentation as text if we can't save
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n\n⚠️ Could not save file (${error.message}). Here's the documentation:\n\n---\n\n${documentation}`
        });
        
        return documentation;
    }
}

function getProjectName(fileList) {
    if (fileList.length === 0) return 'Project';
    
    // Try to find common directory name
    const paths = fileList.map(f => f.path);
    const parts = pathUtils.splitPath(paths[0]);
    
    // Look for a meaningful directory name
    for (let i = parts.length - 2; i >= 0; i--) {
        const dir = parts[i];
        if (dir && dir !== '.' && dir !== 'src' && dir !== 'lib' && !dir.startsWith('.')) {
            return dir;
        }
    }
    
    // Fall back to first file name without extension
    return fileList[0].name.replace(/\.[^.]+$/, '');
}

function buildOverviewPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Limit content size to avoid token limits
    const maxFilesForContent = 10;  // Only include first 10 files' content
    const maxContentPerFile = 1500; // Reduced from 2000
    const maxTotalContent = 20000;  // Cap total content
    
    let totalContentLength = 0;
    const fileContents = [];
    
    for (let i = 0; i < fileList.length && i < maxFilesForContent; i++) {
        const f = fileList[i];
        const content = contextFiles.get(f.path)?.content || '';
        const truncatedContent = content.substring(0, maxContentPerFile);
        
        if (totalContentLength + truncatedContent.length > maxTotalContent) {
            fileContents.push(`FILE: ${f.name}\n[Content truncated - file too large]\n`);
        } else {
            fileContents.push(`FILE: ${f.name}\n${truncatedContent}${content.length > maxContentPerFile ? '...[truncated]' : ''}\n`);
            totalContentLength += truncatedContent.length;
        }
    }
    
    if (fileList.length > maxFilesForContent) {
        fileContents.push(`\n[... and ${fileList.length - maxFilesForContent} more files]\n`);
    }
    
    return `Analyze these source files and write a concise project overview.

FILES (${fileList.length} total): ${fileNames}

${fileContents.join('\n---\n')}

Write an overview that covers:
1. **Purpose**: What is the main purpose of this codebase/module? (2-3 sentences)
2. **Key Features**: List 3-5 main features or capabilities
3. **Technology**: What language, frameworks, or patterns are used?

Be concise and accurate. Output only the content, no headers.`;
}

function buildArchitecturePrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Use the code index for architecture instead of raw content
    // This is more reliable for large codebases
    let indexInfo = '';
    if (codeIndex.symbols.size > 0) {
        // Get functions and their relationships
        const functions = [];
        for (const [name, symbol] of codeIndex.symbols) {
            if (name.includes('@')) continue; // Skip duplicates
            if (['function', 'procedure', 'method'].includes(symbol.type)) {
                const callers = codeIndex.reverseCallGraph.get(name);
                const calls = codeIndex.callGraph.get(name);
                functions.push({
                    name,
                    file: symbol.file?.split('/').pop(),
                    callers: callers ? callers.size : 0,
                    calls: calls ? [...calls].slice(0, 5) : []
                });
            }
        }
        
        // Sort by caller count (most called = most important)
        functions.sort((a, b) => b.callers - a.callers);
        
        indexInfo = `\n\nCODE INDEX (${functions.length} functions):\n`;
        indexInfo += functions.slice(0, 30).map(f => 
            `- ${f.name} (${f.file}) [called by ${f.callers}]${f.calls.length > 0 ? ' → ' + f.calls.join(', ') : ''}`
        ).join('\n');
    }
    
    // Limit file content
    const maxFiles = 8;
    const maxContentPerFile = 1000;
    const fileContents = fileList.slice(0, maxFiles).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, maxContentPerFile)}${content.length > maxContentPerFile ? '...[truncated]' : ''}\n`;
    }).join('\n---\n');
    
    return `Analyze the architecture of these source files.

FILES (${fileList.length} total): ${fileNames}
${indexInfo}

${fileContents}

Provide:

### Component Diagram
\`\`\`mermaid
flowchart TB
    subgraph Components
        A[Component1] --> B[Component2]
    end
\`\`\`

### Module Structure
| Module | Responsibility | Key Functions |
|--------|---------------|---------------|
| file.c | What it does | func1, func2 |

### Relationships
Describe how the modules interact with each other.

Be accurate based on the actual code and index information.`;
}

/**
 * Generate overview from code index when LLM is unavailable
 */
function generateIndexBasedOverview(fileList) {
    const languages = new Set();
    const functions = [];
    const classes = [];
    
    // Gather info from code index
    for (const [name, symbol] of codeIndex.symbols) {
        if (name.includes('@')) continue; // Skip duplicates
        
        if (['function', 'procedure', 'method', 'section', 'paragraph'].includes(symbol.type)) {
            functions.push(name);
        } else if (['class', 'struct', 'interface', 'record'].includes(symbol.type)) {
            classes.push(name);
        }
    }
    
    // Detect languages from files
    for (const file of fileList) {
        const ext = file.name.split('.').pop().toLowerCase();
        const langMap = {
            'c': 'C', 'h': 'C/C++', 'cpp': 'C++', 'java': 'Java',
            'py': 'Python', 'js': 'JavaScript', 'ts': 'TypeScript',
            'cbl': 'COBOL', 'cob': 'COBOL', 'tal': 'TAL', 'sql': 'SQL',
            'cs': 'C#', 'go': 'Go', 'rs': 'Rust'
        };
        if (langMap[ext]) languages.add(langMap[ext]);
    }
    
    const totalFunctions = codeIndex.callGraph.size;
    const totalVariables = codeIndex.variables.size;
    const callEdges = Array.from(codeIndex.callGraph.values()).reduce((sum, calls) => sum + calls.size, 0);
    
    let overview = `**Purpose**: This codebase contains ${fileList.length} source files with ${totalFunctions} functions/procedures and ${totalVariables} tracked variables. `;
    
    if (classes.length > 0) {
        overview += `It defines ${classes.length} classes/structures. `;
    }
    
    overview += `\n\n**Key Features**:\n`;
    
    // Find entry points (functions with no callers)
    const entryPoints = [];
    for (const [funcName, calls] of codeIndex.callGraph) {
        const callers = codeIndex.reverseCallGraph.get(funcName);
        if (!callers || callers.size === 0) {
            entryPoints.push(funcName);
        }
    }
    
    if (entryPoints.length > 0) {
        overview += `- Entry points: ${entryPoints.slice(0, 5).join(', ')}${entryPoints.length > 5 ? '...' : ''}\n`;
    }
    
    // Most called functions
    const mostCalled = [];
    for (const [funcName, callers] of codeIndex.reverseCallGraph) {
        mostCalled.push({ name: funcName, count: callers.size });
    }
    mostCalled.sort((a, b) => b.count - a.count);
    
    if (mostCalled.length > 0) {
        overview += `- Core functions: ${mostCalled.slice(0, 5).map(f => f.name).join(', ')}\n`;
    }
    
    overview += `- Call graph: ${callEdges} call relationships\n`;
    
    overview += `\n**Technology**: ${[...languages].join(', ') || 'Unknown'}\n`;
    
    return overview;
}

/**
 * Generate architecture section from code index when LLM is unavailable
 */
function generateIndexBasedArchitecture(fileList) {
    let arch = `## Architecture\n\n`;
    
    // Build component diagram from call graph
    arch += `### Component Diagram\n\n\`\`\`mermaid\nflowchart TB\n`;
    
    // Group functions by file
    const fileToFuncs = new Map();
    for (const [name, symbol] of codeIndex.symbols) {
        if (name.includes('@')) continue;
        if (['function', 'procedure', 'method'].includes(symbol.type)) {
            const fileName = symbol.file?.split('/').pop() || 'unknown';
            if (!fileToFuncs.has(fileName)) {
                fileToFuncs.set(fileName, []);
            }
            fileToFuncs.get(fileName).push(name);
        }
    }
    
    // Create subgraphs for each file
    let fileIdx = 0;
    const fileIds = new Map();
    for (const [fileName, funcs] of fileToFuncs) {
        const fileId = `F${fileIdx++}`;
        fileIds.set(fileName, fileId);
        const safeName = fileName.replace(/[^a-zA-Z0-9]/g, '_');
        arch += `    subgraph ${safeName}["${fileName}"]\n`;
        arch += `        ${fileId}["${funcs.slice(0, 3).join(', ')}${funcs.length > 3 ? '...' : ''}"]\n`;
        arch += `    end\n`;
    }
    
    // Add cross-file calls
    const addedEdges = new Set();
    for (const [funcName, calls] of codeIndex.callGraph) {
        const funcSymbol = codeIndex.symbols.get(funcName);
        if (!funcSymbol) continue;
        const srcFile = funcSymbol.file?.split('/').pop();
        
        for (const calledFunc of calls) {
            const calledSymbol = codeIndex.symbols.get(calledFunc);
            if (!calledSymbol) continue;
            const dstFile = calledSymbol.file?.split('/').pop();
            
            if (srcFile && dstFile && srcFile !== dstFile) {
                const edgeKey = `${srcFile}->${dstFile}`;
                if (!addedEdges.has(edgeKey)) {
                    addedEdges.add(edgeKey);
                    const srcId = fileIds.get(srcFile);
                    const dstId = fileIds.get(dstFile);
                    if (srcId && dstId) {
                        arch += `    ${srcId} --> ${dstId}\n`;
                    }
                }
            }
        }
    }
    
    arch += `\`\`\`\n\n`;
    
    // Module structure table
    arch += `### Module Structure\n\n`;
    arch += `| Module | Functions | Calls | Called By |\n`;
    arch += `|--------|-----------|-------|----------|\n`;
    
    for (const [fileName, funcs] of fileToFuncs) {
        let totalCalls = 0;
        let totalCallers = 0;
        for (const func of funcs) {
            const calls = codeIndex.callGraph.get(func);
            const callers = codeIndex.reverseCallGraph.get(func);
            if (calls) totalCalls += calls.size;
            if (callers) totalCallers += callers.size;
        }
        arch += `| ${fileName} | ${funcs.length} | ${totalCalls} | ${totalCallers} |\n`;
    }
    
    arch += `\n### Relationships\n\n`;
    arch += `The codebase has ${fileToFuncs.size} modules with ${addedEdges.size} cross-module dependencies.\n`;
    
    return arch;
}

/**
 * Generate file documentation from code index when LLM is unavailable
 */
function generateIndexBasedFileDoc(filePath, fileName) {
    let doc = '';
    
    // Get file info from index
    const fileInfo = codeIndex.files.get(filePath);
    if (!fileInfo) {
        doc += `*File not indexed - no structural information available*\n`;
        return doc;
    }
    
    doc += `**Language**: ${fileInfo.language}\n`;
    doc += `**Lines**: ${fileInfo.lineCount || 'unknown'}\n\n`;
    
    // Group symbols by type
    const functions = [];
    const classes = [];
    const variables = [];
    
    for (const symbol of fileInfo.symbols || []) {
        if (['function', 'procedure', 'method', 'section', 'paragraph', 'subproc'].includes(symbol.type)) {
            functions.push(symbol);
        } else if (['class', 'struct', 'interface', 'record'].includes(symbol.type)) {
            classes.push(symbol);
        } else if (['variable', 'field', 'parameter', 'constant'].includes(symbol.type)) {
            variables.push(symbol);
        }
        // Ignore other symbol types for documentation
    }
    
    if (functions.length > 0) {
        doc += `**Functions/Procedures (${functions.length})**:\n`;
        for (const func of functions) {
            const callers = codeIndex.reverseCallGraph.get(func.name);
            const calls = codeIndex.callGraph.get(func.name);
            const callerCount = callers ? callers.size : 0;
            const callCount = calls ? calls.size : 0;
            
            doc += `- \`${func.name}\``;
            if (func.signature) doc += `: ${func.signature}`;
            doc += ` (line ${func.line})`;
            if (callerCount > 0 || callCount > 0) {
                doc += ` [calls: ${callCount}, called by: ${callerCount}]`;
            }
            doc += '\n';
        }
        doc += '\n';
    }
    
    if (classes.length > 0) {
        doc += `**Classes/Structures (${classes.length})**:\n`;
        for (const cls of classes) {
            doc += `- \`${cls.name}\` (${cls.type}, line ${cls.line})\n`;
        }
        doc += '\n';
    }
    
    if (variables.length > 0) {
        doc += `**Variables/Data (${variables.length})**:\n`;
        for (const v of variables.slice(0, 20)) { // Limit to 20
            doc += `- \`${v.name}\``;
            if (v.dataType) doc += `: ${v.dataType}`;
            doc += ` (line ${v.line})`;
            if (v.scope) doc += ` [${v.scope}]`;
            doc += '\n';
        }
        if (variables.length > 20) {
            doc += `- *... and ${variables.length - 20} more*\n`;
        }
        doc += '\n';
    }
    
    return doc;
}

/**
 * Generate data flow documentation from code index when LLM is unavailable
 */
function generateIndexBasedDataFlow(fileList) {
    let doc = `## Data Flow\n\n`;
    
    // Variable tracking info
    if (codeIndex.variables.size > 0) {
        doc += `### Tracked Variables\n\n`;
        doc += `| Variable | Type | File | Reads | Writes |\n`;
        doc += `|----------|------|------|-------|--------|\n`;
        
        const sortedVars = [...codeIndex.variables.entries()]
            .map(([key, v]) => ({
                key,
                ...v,
                reads: v.accesses?.filter(a => a.type === 'read').length || 0,
                writes: v.accesses?.filter(a => a.type === 'write').length || 0
            }))
            .sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes))
            .slice(0, 30);
        
        for (const v of sortedVars) {
            const fileName = v.file?.split('/').pop() || 'unknown';
            doc += `| ${v.name} | ${v.dataType || 'unknown'} | ${fileName} | ${v.reads} | ${v.writes} |\n`;
        }
        doc += '\n';
    }
    
    // Call flow between files
    doc += `### Call Flow\n\n`;
    
    const fileCallMap = new Map();
    for (const [funcName, calls] of codeIndex.callGraph) {
        const funcSymbol = codeIndex.symbols.get(funcName);
        if (!funcSymbol) continue;
        const srcFile = funcSymbol.file?.split('/').pop();
        
        for (const calledFunc of calls) {
            const calledSymbol = codeIndex.symbols.get(calledFunc);
            if (!calledSymbol) continue;
            const dstFile = calledSymbol.file?.split('/').pop();
            
            if (srcFile && dstFile) {
                const key = `${srcFile} → ${dstFile}`;
                if (!fileCallMap.has(key)) {
                    fileCallMap.set(key, []);
                }
                fileCallMap.get(key).push(`${funcName} → ${calledFunc}`);
            }
        }
    }
    
    if (fileCallMap.size > 0) {
        for (const [route, calls] of fileCallMap) {
            doc += `**${route}**:\n`;
            for (const call of calls.slice(0, 5)) {
                doc += `- ${call}\n`;
            }
            if (calls.length > 5) {
                doc += `- *... and ${calls.length - 5} more*\n`;
            }
            doc += '\n';
        }
    } else {
        doc += `No cross-file calls detected.\n`;
    }
    
    return doc;
}

/**
 * Generate dependencies documentation from code index when LLM is unavailable
 */
function generateIndexBasedDependencies(fileList) {
    let doc = `## Dependencies\n\n`;
    
    // External dependencies (imports, includes)
    const allDeps = new Map();
    for (const [filePath, deps] of codeIndex.dependencies) {
        const fileName = filePath.split('/').pop();
        for (const dep of deps) {
            if (!allDeps.has(dep)) {
                allDeps.set(dep, []);
            }
            allDeps.get(dep).push(fileName);
        }
    }
    
    if (allDeps.size > 0) {
        doc += `### External Dependencies\n\n`;
        doc += `| Dependency | Used By |\n`;
        doc += `|------------|--------|\n`;
        
        for (const [dep, files] of allDeps) {
            doc += `| ${dep} | ${files.join(', ')} |\n`;
        }
        doc += '\n';
    }
    
    // Internal dependencies (file-to-file calls)
    doc += `### Internal Dependencies\n\n`;
    
    const internalDeps = new Map();
    for (const [funcName, calls] of codeIndex.callGraph) {
        const funcSymbol = codeIndex.symbols.get(funcName);
        if (!funcSymbol) continue;
        const srcFile = funcSymbol.file?.split('/').pop();
        
        for (const calledFunc of calls) {
            const calledSymbol = codeIndex.symbols.get(calledFunc);
            if (!calledSymbol) continue;
            const dstFile = calledSymbol.file?.split('/').pop();
            
            if (srcFile && dstFile && srcFile !== dstFile) {
                if (!internalDeps.has(srcFile)) {
                    internalDeps.set(srcFile, new Set());
                }
                internalDeps.get(srcFile).add(dstFile);
            }
        }
    }
    
    if (internalDeps.size > 0) {
        doc += `| File | Depends On |\n`;
        doc += `|------|------------|\n`;
        
        for (const [file, deps] of internalDeps) {
            doc += `| ${file} | ${[...deps].join(', ')} |\n`;
        }
    } else {
        doc += `No internal file dependencies detected.\n`;
    }
    
    return doc;
}

function buildFileDocPrompt(fileName, content) {
    return `Document this source file comprehensively.

FILE: ${fileName}
\`\`\`
${content.substring(0, 20000)}
\`\`\`

Generate documentation with:

**Purpose**: What does this file do? (1-2 sentences)

**Key Functions/Components**:
| Function/Component | Purpose | Parameters |
|--------------------|---------|------------|
| name | what it does | key params |

**Logic Flow**:
\`\`\`mermaid
flowchart TD
    A[Start] --> B[Step1] --> C[Step2] --> D[End]
\`\`\`

**Key Variables**:
| Variable | Type | Purpose |
|----------|------|---------|
| name | type | what it holds |

**Error Handling**:
| Condition | Action |
|-----------|--------|
| when | what happens |

Be thorough but concise. Use actual names from the code.`;
}

function buildDataFlowPrompt(fileList) {
    const fileContents = fileList.map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1000)}...\n`;
    }).join('\n---\n');
    
    return `Analyze the data flow across these files.

${fileContents}

Provide:

### Data Flow Diagram
\`\`\`mermaid
flowchart LR
    A[Input] --> B[Process] --> C[Output]
\`\`\`

### Input Sources
| Source | Type | Description |
|--------|------|-------------|
| name | type | what data comes in |

### Transformations
Describe key data transformations that occur.

### Output
| Destination | Type | Description |
|-------------|------|-------------|
| name | type | what data goes out |

Be specific to the actual code.`;
}

function buildDependenciesPrompt(fileList) {
    const fileContents = fileList.map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        // Focus on includes/imports
        const lines = content.split('\n').filter(l => 
            l.includes('#include') || l.includes('import') || l.includes('require') || l.includes('extern')
        ).join('\n');
        return `FILE: ${f.name}\n${lines}\n`;
    }).join('\n---\n');
    
    return `Analyze the dependencies in these files.

${fileContents}

Provide:

### External Dependencies
| Library/Module | Purpose | Used By |
|----------------|---------|---------|
| name | why needed | which files |

### Internal Dependencies
\`\`\`mermaid
graph LR
    A[file1] --> B[file2]
    B --> C[file3]
\`\`\`

### APIs/Interfaces
| Interface | Type | Description |
|-----------|------|-------------|
| name | internal/external | purpose |

Be specific to the actual includes and imports found.`;
}

// ============================================================
// BUSINESS DOCUMENTATION PROMPTS
// These prompts generate documentation for business users,
// product owners, and stakeholders - focusing on WHAT and WHY
// ============================================================

function buildBusinessSummaryPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Build file content summary
    const maxFilesForContent = 10;
    const maxContentPerFile = 2000;
    let totalContentLength = 0;
    const fileContents = [];
    
    for (let i = 0; i < fileList.length && i < maxFilesForContent; i++) {
        const f = fileList[i];
        const content = contextFiles.get(f.path)?.content || '';
        const truncatedContent = content.substring(0, maxContentPerFile);
        
        if (totalContentLength + truncatedContent.length > 25000) {
            break;
        }
        fileContents.push(`FILE: ${f.name}\n${truncatedContent}${content.length > maxContentPerFile ? '...[truncated]' : ''}\n`);
        totalContentLength += truncatedContent.length;
    }
    
    return `You are a Business Analyst writing documentation for business stakeholders and product owners.
Your audience is NON-TECHNICAL. They need to understand WHAT this system does and WHY it matters.

Analyze these source files and write an EXECUTIVE SUMMARY.

FILES (${fileList.length} total): ${fileNames}

${fileContents.join('\n---\n')}

Write an executive summary that answers:
1. **What does this system/module do?** (Plain English, no technical jargon)
2. **Who are the users?** (What roles or personas benefit from this?)
3. **What business problem does it solve?** (Pain points addressed)
4. **What is the business value?** (ROI, efficiency gains, risk reduction)

Write in clear, business-friendly language. Avoid code references, function names, or technical implementation details.
Use bullet points for key takeaways. Keep it to 200-300 words.`;
}

function buildBusinessCapabilitiesPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Use code index to identify capabilities
    let capabilities = '';
    if (codeIndex.symbols.size > 0) {
        const funcs = [];
        for (const [key, sym] of codeIndex.symbols) {
            if (['function', 'method', 'procedure'].includes(sym.type) && !key.includes('@')) {
                funcs.push(sym);
            }
        }
        capabilities = funcs.slice(0, 50).map(f => `- ${f.name} (${f.file})`).join('\n');
    }
    
    // Get file content summary
    const fileContents = fileList.slice(0, 5).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1500)}...\n`;
    }).join('\n---\n');
    
    return `You are a Business Analyst documenting system capabilities for product owners.
Your audience is NON-TECHNICAL. Focus on WHAT the system can do, not HOW it does it.

FILES: ${fileNames}

CODE FUNCTIONS (for reference):
${capabilities || 'No function index available'}

FILE CONTENTS:
${fileContents}

Create a BUSINESS CAPABILITIES section with the following format:

### Core Capabilities

For each major capability, provide:

| Capability | Description | Business Benefit |
|------------|-------------|------------------|
| [Name in business terms] | [What it does in plain English] | [Why it matters to the business] |

### Feature List

Group features into categories (e.g., "Data Management", "Reporting", "User Management"):

**Category Name**
- Feature 1: Brief description of what users can do
- Feature 2: Brief description of what users can do

Use business terminology. Convert technical function names to user-friendly descriptions.
For example: "validate_ABA_routing" → "Validates bank routing numbers to prevent payment errors"`;
}

function buildUserStoriesPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Get file content summary
    const fileContents = fileList.slice(0, 8).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1200)}...\n`;
    }).join('\n---\n');
    
    return `You are a Business Analyst deriving user stories from existing code.
Analyze the code to understand what users can do with this system.

FILES: ${fileNames}

${fileContents}

Generate USER STORIES in standard Agile format. Group them by user persona/role.

### User Personas
First, identify the likely user personas based on the code (e.g., "Bank Operations User", "System Administrator", "Customer Service Rep")

### User Stories by Persona

For each persona, write 3-5 user stories:

**As a [User Role]...**

| ID | User Story | Acceptance Criteria |
|----|------------|---------------------|
| US-001 | As a [role], I want to [action] so that [benefit] | Given [context], when [action], then [result] |

### Use Cases

Describe 2-3 key use cases in narrative form:

**Use Case: [Name]**
- **Actor:** Who initiates this?
- **Goal:** What are they trying to accomplish?
- **Preconditions:** What must be true before starting?
- **Main Flow:** Step-by-step what happens (business terms only)
- **Success Outcome:** What does success look like?

Focus on business outcomes, not technical implementation.`;
}

function buildBusinessRulesPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Get file content, focusing on validation and business logic
    const fileContents = fileList.slice(0, 8).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1500)}...\n`;
    }).join('\n---\n');
    
    return `You are a Business Analyst extracting BUSINESS RULES from code.
Look for validation logic, calculations, conditions, and constraints.

FILES: ${fileNames}

${fileContents}

Extract and document BUSINESS RULES in a format business users can understand.

### Business Rules

| Rule ID | Rule Name | Description | Condition | Action/Outcome |
|---------|-----------|-------------|-----------|----------------|
| BR-001 | [Descriptive name] | [What this rule enforces] | [When it applies] | [What happens] |

### Validation Rules

| Field/Data | Validation | Error Message (if applicable) |
|------------|------------|-------------------------------|
| [What's being validated] | [The rule in plain English] | [What users see if invalid] |

### Calculations & Formulas

| Calculation | Purpose | Formula (business terms) |
|-------------|---------|--------------------------|
| [Name] | [Why needed] | [Plain English explanation] |

### Decision Logic

For complex decisions, use decision tables:

**Decision: [Name]**
| Condition 1 | Condition 2 | Action |
|-------------|-------------|--------|
| Yes | Yes | Do X |
| Yes | No | Do Y |

Translate code logic into business rules. Avoid code syntax - use plain English.`;
}

function buildBusinessDataFlowPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Get file content summary
    const fileContents = fileList.slice(0, 6).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1500)}...\n`;
    }).join('\n---\n');
    
    return `You are a Business Analyst documenting how INFORMATION flows through the system.
Focus on what data moves where, not technical implementation.

FILES: ${fileNames}

${fileContents}

Create an INFORMATION FLOW section for business stakeholders.

### Data Entities

| Entity | Description | Key Attributes |
|--------|-------------|----------------|
| [Name in business terms] | [What it represents] | [Important fields in plain English] |

### Information Flow Diagram

Describe the flow in a business-friendly way:

\`\`\`
[Input Source] → [Process/Action] → [Output/Destination]
\`\`\`

Example:
\`\`\`
Customer Request → Validation → Payment Processing → Bank Confirmation → Customer Receipt
\`\`\`

### Process Steps

1. **Step Name:** What happens (in business terms)
   - Input: What data comes in
   - Output: What data goes out
   - Business Rule: Any rules applied

### Data Touchpoints

| Stage | Data Used | Data Created/Modified |
|-------|-----------|----------------------|
| [Stage name] | [What info is read] | [What info is written] |

Use business terminology. Describe data in terms users understand (e.g., "customer information" not "struct Customer").`;
}

function buildIntegrationsPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Look for external calls, APIs, connections
    const fileContents = fileList.slice(0, 8).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1500)}...\n`;
    }).join('\n---\n');
    
    return `You are a Business Analyst documenting SYSTEM INTEGRATIONS for stakeholders.
Identify how this system connects to other systems, services, or data sources.

FILES: ${fileNames}

${fileContents}

Create an INTEGRATION POINTS section.

### External Systems

| System/Service | Direction | Purpose | Data Exchanged |
|----------------|-----------|---------|----------------|
| [Name] | Inbound/Outbound/Both | [Why we integrate] | [What data flows] |

### Integration Diagram

\`\`\`
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   External   │ ──→  │  Our System  │  ──→ │   External   │
│   System A   │      │              │      │   System B   │
└──────────────┘      └──────────────┘      └──────────────┘
\`\`\`

### Data Sources

| Source | Type | Purpose |
|--------|------|---------|
| [Name] | Database/File/API/etc | [What data we get] |

### Downstream Consumers

| Consumer | What They Receive | Frequency |
|----------|-------------------|-----------|
| [System/Team] | [Data/Reports/etc] | [Real-time/Daily/etc] |

### Dependencies

List any external services or systems this code depends on:
- **Required:** Systems that must be available
- **Optional:** Systems that enhance functionality

Use business names for systems (e.g., "Core Banking System" not "CBS_API_v2").`;
}

function buildGlossaryPrompt(fileList) {
    const fileNames = fileList.map(f => f.name).join(', ');
    
    // Get file content to extract terms
    const fileContents = fileList.slice(0, 10).map(f => {
        const content = contextFiles.get(f.path)?.content || '';
        return `FILE: ${f.name}\n${content.substring(0, 1000)}...\n`;
    }).join('\n---\n');
    
    return `You are a Business Analyst creating a GLOSSARY of business terms found in this codebase.
Extract domain-specific terms, acronyms, and business concepts.

FILES: ${fileNames}

${fileContents}

Create a GLOSSARY section for business users.

### Acronyms & Abbreviations

| Acronym | Full Name | Definition |
|---------|-----------|------------|
| [e.g., ABA] | [American Bankers Association] | [What it means in this context] |

### Business Terms

| Term | Definition | Related Terms |
|------|------------|---------------|
| [Term] | [Plain English definition] | [Related concepts] |

### Domain Concepts

| Concept | Description | Example |
|---------|-------------|---------|
| [Concept] | [What it means to the business] | [Real-world example] |

Include:
- Any industry-specific terms (banking, payments, etc.)
- Acronyms found in variable names or comments
- Business concepts implied by the code logic
- Terms that non-technical stakeholders need to understand

Sort alphabetically. Keep definitions concise (1-2 sentences).`;
}

// Business documentation fallback functions (when LLM is unavailable)

function generateIndexBasedBusinessSummary(fileList) {
    let summary = '';
    
    // Count functions and files
    const funcCount = codeIndex.symbols.size;
    const fileCount = fileList.length;
    
    summary += `This system consists of ${fileCount} source files containing approximately ${funcCount} functions and components.\n\n`;
    
    // Try to identify purpose from file names
    const fileTypes = {};
    fileList.forEach(f => {
        const name = f.name.toLowerCase();
        if (name.includes('payment') || name.includes('pay')) fileTypes.payments = true;
        if (name.includes('valid') || name.includes('check')) fileTypes.validation = true;
        if (name.includes('report') || name.includes('output')) fileTypes.reporting = true;
        if (name.includes('user') || name.includes('auth')) fileTypes.userManagement = true;
        if (name.includes('data') || name.includes('db')) fileTypes.dataManagement = true;
    });
    
    if (Object.keys(fileTypes).length > 0) {
        summary += `**Identified capabilities:**\n`;
        if (fileTypes.payments) summary += `- Payment processing functionality\n`;
        if (fileTypes.validation) summary += `- Data validation and verification\n`;
        if (fileTypes.reporting) summary += `- Reporting and output generation\n`;
        if (fileTypes.userManagement) summary += `- User management features\n`;
        if (fileTypes.dataManagement) summary += `- Data management and storage\n`;
    }
    
    return summary;
}

function generateIndexBasedCapabilities(fileList) {
    let capabilities = '';
    
    // Group functions by apparent purpose
    const groups = {
        'Data Processing': [],
        'Validation': [],
        'Reporting': [],
        'User Operations': [],
        'Other': []
    };
    
    for (const [key, sym] of codeIndex.symbols) {
        if (!['function', 'method', 'procedure'].includes(sym.type)) continue;
        const name = sym.name.toLowerCase();
        
        if (name.includes('valid') || name.includes('check') || name.includes('verify')) {
            groups['Validation'].push(sym.name);
        } else if (name.includes('report') || name.includes('print') || name.includes('output')) {
            groups['Reporting'].push(sym.name);
        } else if (name.includes('user') || name.includes('auth') || name.includes('login')) {
            groups['User Operations'].push(sym.name);
        } else if (name.includes('process') || name.includes('handle') || name.includes('parse')) {
            groups['Data Processing'].push(sym.name);
        } else {
            groups['Other'].push(sym.name);
        }
    }
    
    for (const [group, items] of Object.entries(groups)) {
        if (items.length > 0) {
            capabilities += `### ${group}\n\n`;
            items.slice(0, 10).forEach(item => {
                capabilities += `- ${item}\n`;
            });
            if (items.length > 10) capabilities += `- ...and ${items.length - 10} more\n`;
            capabilities += '\n';
        }
    }
    
    return capabilities || '*Capabilities will be documented when LLM is available.*';
}

function generateIndexBasedBusinessRules(fileList) {
    let rules = '';
    
    // Look for validation functions as indicators of business rules
    let ruleCount = 1;
    for (const [key, sym] of codeIndex.symbols) {
        if (!['function', 'method', 'procedure'].includes(sym.type)) continue;
        const name = sym.name.toLowerCase();
        
        if (name.includes('valid') || name.includes('check') || name.includes('verify')) {
            rules += `| BR-${String(ruleCount).padStart(3, '0')} | ${sym.name} | See function in ${sym.file} |\n`;
            ruleCount++;
            if (ruleCount > 20) break;
        }
    }
    
    if (rules) {
        return `| Rule ID | Rule Name | Reference |\n|---------|-----------|------------|\n${rules}`;
    }
    return '*Business rules will be extracted when LLM is available.*';
}

async function handleApiMode(text, apiUrl, config) {
    log('API MODE: Searching codebase');
    
    // Extract search terms
    const cleanText = text.replace(/^\/api\s*/i, '');
    const searchTerms = extractSearchTerms(cleanText);
    
    if (!searchTerms) {
        // No search terms - just ask LLM directly
        log('API MODE: No search terms, falling back to LLM');
        return await callLanguageModel(cleanText);
    }
    
    try {
        // Search API
        const searchResults = await searchCodebase(apiUrl, searchTerms);
        
        if (!searchResults || searchResults.length === 0) {
            // No results from API - fall back to LLM
            log('API MODE: No results from API server, falling back to LLM');
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `*No results found in indexed codebase for "${searchTerms}", asking LLM...*\n\n`
            });
            return await callLanguageModel(cleanText);
        }
        
        // Build context from search results
        let contextContent = `SEARCH RESULTS FOR: "${searchTerms}"\n\n`;
        for (const result of searchResults.slice(0, 5)) {
            contextContent += `=== ${result.procedure_name || result.file_path} ===\n`;
            contextContent += result.content_preview || result.content || '';
            contextContent += '\n\n';
        }
        
        // Call LLM with search results
        const prompt = buildApiPrompt(contextContent, cleanText, searchResults);
        const response = await callLanguageModel(prompt);
        
        return `**Found ${searchResults.length} results for "${searchTerms}"**\n\n${response}`;
        
    } catch (error) {
        log('API error:', error.message);
        // API failed - fall back to LLM
        log('API MODE: API error, falling back to LLM');
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `*API server unavailable, asking LLM...*\n\n`
        });
        return await callLanguageModel(cleanText);
    }
}

// ============================================================
// Prompt Builders
// ============================================================

function buildFlowchartPrompt(context, query) {
    return `Generate a Mermaid flowchart diagram for the following code.

${context}

USER REQUEST: ${query}

Output a valid Mermaid flowchart using:
- flowchart TD (top-down)
- ([Stadium]) for Start/End
- [Rectangle] for Process
- {Diamond} for Decision
- [[Double]] for CALL/PERFORM

Output ONLY the mermaid code block:

\`\`\`mermaid
flowchart TD
    ...
\`\`\``;
}

function buildTranslatePrompt(context, query, targetLang, fileName) {
    // Detect source language from context or query
    const sourceLangMatch = query.match(/(?:from\s+)?(\w+)\s+(?:to|into)/i);
    const sourceLang = sourceLangMatch ? sourceLangMatch[1].toUpperCase() : 'C';
    
    // Build a focused prompt with PLAN and EXECUTE structure
    let prompt = `# CODE TRANSLATION TASK

## STEP 1: PLAN
You are translating **ONE FILE ONLY**: \`${fileName || 'the provided file'}\`
- Source language: ${sourceLang}
- Target language: ${targetLang.toUpperCase()}
- Task: Complete, line-by-line translation

## STEP 2: EXECUTE
Translate the code below to ${targetLang.toUpperCase()}.

${context}

## USER REQUEST: ${query}

---

# CRITICAL INSTRUCTIONS

## DO NOT DO THESE:
❌ DO NOT summarize files
❌ DO NOT describe what the file does
❌ DO NOT write "please provide the content"
❌ DO NOT say "here's a simplified version"
❌ DO NOT write placeholder comments like "// TODO" or "// Other methods"
❌ DO NOT skip any functions

## YOU MUST DO THESE:
✅ Translate EVERY function completely
✅ Translate EVERY line of code
✅ Preserve ALL logic, ALL branches, ALL conditions
✅ Convert ALL data types correctly
✅ Include ALL error handling
✅ The translation should be ~same length as original

## TYPE MAPPINGS (${sourceLang} → ${targetLang.toUpperCase()}):
| ${sourceLang} | ${targetLang.toUpperCase()} |
|---------------|-------------------|
| int, INT | int |
| long | long |
| char* / STRING | String |
| char[] | char[] or String |
| float, double | float, double |
| bool | boolean |
| void | void |
| struct | class |
| enum | enum |
| typedef | class or type alias |
| #define constant | static final |
| #define macro(x) | inline method |
| NULL | null |
| malloc/free | new (GC handles free) |
| pointer (*) | reference or array |

## DECIMAL PRECISION:
- Use BigDecimal for financial/money calculations
- Cast integer division: \`(double) a / b\` to preserve decimals
- PIC 9(n)V9(m) → BigDecimal

---

# START TRANSLATION NOW

Translate \`${fileName || 'the file'}\` to ${targetLang.toUpperCase()}:

\`\`\`${targetLang}
// ${fileName ? fileName.replace(/\.[^.]+$/, '') : 'TranslatedFile'}.${targetLang === 'java' ? 'java' : targetLang}
// Translated from ${sourceLang} to ${targetLang.toUpperCase()}

`;
    
    return prompt;
}


function buildExplainPrompt(context, query) {
    // Check if user wants full documentation or quick explanation
    const wantsFullDocs = /document|documentation|deepwiki|full|detailed|comprehensive/i.test(query);
    
    if (wantsFullDocs) {
        return buildDeepWikiPrompt(context, query);
    }
    
    // Quick explanation
    return `Analyze and explain the following code concisely.

${context}

USER REQUEST: ${query}

Provide a clear explanation covering:
1. **Purpose**: What does this code do?
2. **Key Logic**: Main processing steps
3. **Important Variables**: Key data structures
4. **External Calls**: Any CALL/PERFORM/API calls

Be concise but thorough.`;
}

function buildDeepWikiPrompt(context, query) {
    return `Generate comprehensive DeepWiki-style documentation for the following code.

${context}

USER REQUEST: ${query}

---

Generate documentation in this EXACT format:

# [Program Name] Documentation

## 1. Overview

### Purpose
[2-3 sentence description of what this program/module does]

### Key Features
- [Feature 1]
- [Feature 2]
- [Feature 3]

## 2. Architecture

### Component Diagram
\`\`\`mermaid
flowchart TB
    subgraph Input
        A[Input Source]
    end
    subgraph Processing
        B[Main Logic]
        C[Validation]
    end
    subgraph Output
        D[Output/Result]
    end
    A --> B --> C --> D
\`\`\`

### Module Structure
| Component | Purpose | Location |
|-----------|---------|----------|
| [Section/Paragraph] | [What it does] | [Line range] |

## 3. Data Flow

### Input
| Field/Variable | Type | Description |
|----------------|------|-------------|
| [Name] | [Type] | [Purpose] |

### Processing Steps
1. **[Step Name]**: [Description]
2. **[Step Name]**: [Description]

### Output
| Field/Variable | Type | Description |
|----------------|------|-------------|
| [Name] | [Type] | [Purpose] |

## 4. Business Logic

### Decision Points
\`\`\`mermaid
flowchart TD
    A{Condition?} -->|Yes| B[Action 1]
    A -->|No| C[Action 2]
\`\`\`

### Validation Rules
| Rule | Condition | Action |
|------|-----------|--------|
| [Rule Name] | [When this happens] | [Do this] |

### Error Handling
| Error Code | Condition | Response |
|------------|-----------|----------|
| [Code] | [When] | [What happens] |

## 5. Dependencies

### External Calls
| Program/Module | Purpose | Parameters |
|----------------|---------|------------|
| [Name] | [Why called] | [Key params] |

### Data Sources
| Source | Type | Usage |
|--------|------|-------|
| [Name] | [File/DB/API] | [How used] |

## 6. Key Variables & Constants

### Working Storage / Variables
| Name | Type | Purpose | Initial Value |
|------|------|---------|---------------|
| [Name] | [Type] | [What it holds] | [Default] |

### Constants / Literals
| Name | Value | Meaning |
|------|-------|---------|
| [Name] | [Value] | [Purpose] |

## 7. Usage Examples

### Typical Flow
\`\`\`
1. [First step]
2. [Second step]
3. [Result]
\`\`\`

### Sample Input/Output
**Input:**
\`\`\`
[Example input data]
\`\`\`

**Output:**
\`\`\`
[Example output data]
\`\`\`

## 8. Notes & Considerations

### Performance
- [Any performance considerations]

### Maintenance
- [Things to watch out for]

### Related Programs
- [List of related modules]

---

Now generate the documentation following this exact structure. Fill in ALL sections with actual content from the code. Use Mermaid diagrams where indicated. Be thorough and accurate.`;
}

/**
 * Build prompt for direct questions (yes/no, what, how, does, etc.)
 * These questions should be answered directly without special formatting
 */
function buildDirectQuestionPrompt(context, indexSummary, query) {
    return `You are a helpful code assistant. The user has asked a direct question about the code. Answer it directly and accurately.

${context}

${indexSummary}

USER QUESTION: ${query}

INSTRUCTIONS:
1. Answer the user's question DIRECTLY - don't provide a general summary or documentation
2. If it's a yes/no question, start with "Yes" or "No" then explain
3. If they ask "does this code do X?", examine the code and answer specifically about X
4. Be specific - reference actual function names, line numbers, and code sections
5. If the answer requires looking at specific parts of the code, quote the relevant sections
6. If you're not sure, say so - don't make things up

Provide a focused, direct answer to the question.`;
}

function buildGeneralPrompt(context, query) {
    return `You are a code assistant. Answer the user's question based on the provided code.

${context}

USER QUESTION: ${query}

Provide a helpful, accurate answer based on the code above.`;
}

function buildApiPrompt(context, query, results) {
    return `Based on search results from the codebase, help the user with their request.

${context}

USER REQUEST: ${query}

Found ${results.length} relevant files. Based on these results, provide a helpful response.
If the user wants to implement something, use the found code as examples/patterns.`;
}

// ============================================================
// API Functions
// ============================================================

async function searchCodebase(apiUrl, query) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${apiUrl}/search`);
        const isHttps = url.protocol === 'https:';
        const http = require(isHttps ? 'https' : 'http');
        
        const postData = JSON.stringify({
            query: query,
            top_k: 10,
            include_content: true
        });
        
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        reject(new Error(`API returned ${res.statusCode}`));
                        return;
                    }
                    const json = JSON.parse(data);
                    resolve(json.results || []);
                } catch (e) {
                    reject(new Error(`Invalid JSON response: ${e.message}`));
                }
            });
        });
        
        req.on('error', (e) => reject(e));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        req.write(postData);
        req.end();
    });
}

function extractSearchTerms(text) {
    // Remove common words and extract meaningful terms
    const stopWords = ['implement', 'create', 'build', 'make', 'find', 'search', 'for', 'the', 'a', 'an', 'functionality', 'to'];
    const words = text.toLowerCase().split(/\s+/);
    const terms = words.filter(w => !stopWords.includes(w) && w.length > 2);
    return terms.join(' ');
}

// ============================================================
// Response Cleanup
// ============================================================

/**
 * Clean LLM response by removing trailing refusal messages
 * These are sometimes appended by the model even when the response is valid
 */
function cleanLlmResponse(response) {
    if (!response) return response;
    
    // Patterns that indicate a trailing refusal (case insensitive)
    const refusalPatterns = [
        /\n*Sorry,?\s*I\s*(?:can't|cannot|am unable to)\s*assist\s*with\s*that\.?\s*$/i,
        /\n*I\s*(?:can't|cannot)\s*(?:help|assist)\s*with\s*(?:that|this)\.?\s*$/i,
        /\n*I'm\s*(?:sorry|afraid),?\s*(?:but\s*)?I\s*(?:can't|cannot|am unable to).*$/i,
        /\n*I\s*(?:can't|cannot)\s*provide\s*(?:that|this).*$/i,
        /\n*I'm\s*not\s*able\s*to\s*(?:help|assist)\s*with\s*(?:that|this)\.?\s*$/i,
        /\n*As\s*an\s*AI,?\s*I\s*(?:can't|cannot).*$/i,
    ];
    
    let cleaned = response;
    
    for (const pattern of refusalPatterns) {
        cleaned = cleaned.replace(pattern, '');
    }
    
    // Also clean up any trailing whitespace/newlines
    cleaned = cleaned.trimEnd();
    
    return cleaned;
}

// ============================================================
// Task-Based LLM Routing
// ============================================================

/**
 * Patterns that indicate a coding/translation task
 * These tasks may benefit from a more capable model
 */
const CODING_TASK_PATTERNS = [
    /\b(translate|convert|transpile|port|migrate)\b.*\b(code|from|to)\b/i,
    /\b(generate|create|write|implement)\b.*\b(code|class|function|method|api|service)\b/i,
    /\b(refactor|optimize|fix|debug)\b.*\b(code|function|method|class)\b/i,
    /\bto\s+(java|python|typescript|javascript|go|rust|kotlin|csharp)\b/i,
    /\b(from|in)\s+(tal|cobol|fortran|pascal)\b/i,
    /\b(java|python|typescript|go|rust)\s+(code|implementation|version)\b/i,
];

/**
 * Patterns that indicate a documentation/explanation task
 * These tasks can use free Copilot models effectively
 */
const DOC_TASK_PATTERNS = [
    /\b(explain|describe|what\s+is|what\s+are|how\s+does|summarize|document)\b/i,
    /\b(difference|compare|between)\b/i,
    /\b(help|understand|clarify)\b/i,
    /\bwhat\s+(is|are|does)\b/i,
    /\b(overview|summary|documentation)\b/i,
];

/**
 * Detect if the prompt is a coding task or documentation task
 * @param {string} prompt - The prompt to analyze
 * @returns {'coding' | 'docs' | 'auto'} - The detected task type
 */
function detectTaskType(prompt) {
    // Check first 500 chars for task indicators
    const sample = prompt.substring(0, 500).toLowerCase();
    
    // Check for coding patterns
    for (const pattern of CODING_TASK_PATTERNS) {
        if (pattern.test(sample)) {
            log('Task type detected: CODING');
            return 'coding';
        }
    }
    
    // Check for documentation patterns
    for (const pattern of DOC_TASK_PATTERNS) {
        if (pattern.test(sample)) {
            log('Task type detected: DOCS');
            return 'docs';
        }
    }
    
    log('Task type detected: AUTO');
    return 'auto';
}

// ============================================================
// Language Model Integration
// ============================================================

// Call LLM for documentation (returns {text, error} instead of error message string)
async function callLanguageModelForDoc(prompt) {
    log('callLanguageModelForDoc - prompt length:', prompt.length);
    
    // Use the existing callLanguageModel which has retry logic and chunking
    const result = await callLanguageModel(prompt);
    
    log('LLM result length:', result?.length || 0);
    log('LLM result preview:', result?.substring(0, 200) || 'empty');
    
    // Check if result is empty
    if (!result || result.trim().length === 0) {
        log('ERROR: Empty response from LLM');
        return { text: null, error: 'LLM returned empty response' };
    }
    
    // Check if result is the full error message (starts with error marker)
    // Only check the START of the response, not anywhere in it
    const trimmedResult = result.trim();
    if (trimmedResult.startsWith('**Language Model not available') || 
        trimmedResult.startsWith('**Cannot generate') ||
        trimmedResult.startsWith('❌ GitHub Copilot')) {
        log('ERROR: LLM returned error message');
        return { text: null, error: 'LLM unavailable - check Copilot or API server' };
    }
    
    // Check if ENTIRE response is a refusal (not just contains refusal text)
    const lowerResult = trimmedResult.toLowerCase();
    const isOnlyRefusal = (
        (lowerResult.startsWith("sorry, i can't") || 
         lowerResult.startsWith("i cannot assist") ||
         lowerResult.startsWith("i'm unable to") ||
         lowerResult.startsWith("i can't help")) &&
        trimmedResult.length < 500  // True refusals are short
    );
    
    if (isOnlyRefusal) {
        log('ERROR: LLM refused request');
        return { text: null, error: 'LLM refused - content may be too large or restricted' };
    }
    
    // Check if this looks like the Fix Option error template
    if (result.includes('Fix Option 1:') && result.includes('Fix Option 2:')) {
        log('ERROR: Got error template instead of content');
        return { text: null, error: 'LLM unavailable - see error details in chat' };
    }
    
    log('SUCCESS: Got valid LLM response');
    return { text: result, error: null };
}

async function callLanguageModel(prompt, taskTypeOrOptions = null) {
    // Support both old signature (string taskType) and new signature (options object)
    let taskType = null;
    let preferStrongerModel = false;
    
    if (typeof taskTypeOrOptions === 'object' && taskTypeOrOptions !== null) {
        // New options-based signature
        taskType = taskTypeOrOptions.task || taskTypeOrOptions.taskType || null;
        preferStrongerModel = taskTypeOrOptions.preferStrongerModel || false;
    } else {
        // Old string-based signature for backward compatibility
        taskType = taskTypeOrOptions;
    }
    
    // Detect task type if not provided
    if (!taskType) {
        taskType = detectTaskType(prompt);
    }
    
    // If analysis task or preferStrongerModel flag, use stronger model
    if (taskType === 'analysis' || preferStrongerModel) {
        // Override to use analysis model (configured in settings)
        taskType = 'analysis';
    }
    
    // Map old task types to new LLMConfig task types
    const taskMapping = {
        'coding': LLMConfig.TASKS.CODING,
        'docs': LLMConfig.TASKS.SUMMARY,
        'summary': LLMConfig.TASKS.SUMMARY,
        'classification': LLMConfig.TASKS.CLASSIFICATION,
        'analysis': LLMConfig.TASKS.ANALYSIS,
        'auto': LLMConfig.TASKS.DEFAULT
    };
    const llmTask = taskMapping[taskType] || LLMConfig.TASKS.DEFAULT;
    
    // Prepend system prompt (only for user-facing queries, not internal calls)
    // Skip for classification, docs generation, and summary tasks
    const skipSystemPromptTasks = ['classification', 'docs', 'summary'];
    if (!skipSystemPromptTasks.includes(taskType)) {
        const systemPrompt = getSystemPrompt();
        if (systemPrompt) {
            prompt = `<system_prompt>\n${systemPrompt}\n</system_prompt>\n\n${prompt}`;
        }
    }
    
    // Get the model from centralized config
    const preferredModel = LLMConfig.getModelForTask(llmTask);
    
    debugLog('LLM', `Model selection`, {
        taskType,
        llmTask,
        preferredModel,
        promptSize: prompt.length,
        hasSystemPrompt: !skipSystemPromptTasks.includes(taskType)
    });
    
    // Get provider order from centralized config
    const providerOrder = LLMConfig.getProviderPriority();
    debugLog('LLM', `Provider order: ${providerOrder.join(' → ')}`);
    log('Prompt size:', prompt.length, 'chars');
    
    let lastError = null;
    
    // Try each provider in order
    let copilotError = null;  // Track copilot error separately
    
    for (const provider of providerOrder) {
        // Check for cancellation
        if (taskController.isCancelled) {
            throw new Error('Task cancelled by user');
        }
        
        log(`Trying provider: ${provider}...`);
        
        switch (provider) {
            case 'copilot': {
                const copilotResult = await tryCopilot(prompt, preferredModel);
                if (copilotResult.success) {
                    log('Copilot succeeded');
                    return copilotResult.response;
                }
                copilotError = copilotResult.error;
                lastError = copilotResult.error;
                log('Copilot failed:', copilotResult.error);
                
                // Show the copilot error in chat
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: `\n⚠️ *Copilot request failed: ${copilotResult.error}*\n`
                });
                break;
            }
            
            case 'anthropic': {
                const anthropicKey = LLMConfig.getApiKey('anthropic');
                if (anthropicKey) {
                    const model = preferredModel;
                    const displayName = LLMConfig.getDisplayName(model);
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `\n*Trying Anthropic ${displayName}...*\n`
                    });
                    try {
                        const result = await callAnthropicApi(prompt, anthropicKey, model);
                        // Track the model used for attribution
                        lastUsedModel = { provider: 'anthropic', model: model };
                        return cleanLlmResponse(result);
                    } catch (error) {
                        lastError = error.message;
                        log('Anthropic API error:', error.message);
                    }
                } else {
                    // Only log, don't overwrite copilot error with "no API key" message
                    log('Anthropic API key not configured, skipping');
                }
                break;
            }
            
            case 'openai': {
                const openaiKey = LLMConfig.getApiKey('openai');
                if (openaiKey) {
                    const model = preferredModel;
                    const displayName = LLMConfig.getDisplayName(model);
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `\n*Trying OpenAI ${displayName}...*\n`
                    });
                    try {
                        const result = await callOpenAIApi(prompt, openaiKey, model);
                        // Track the model used for attribution
                        lastUsedModel = { provider: 'openai', model: model };
                        return cleanLlmResponse(result);
                    } catch (error) {
                        lastError = error.message;
                        log('OpenAI API error:', error.message);
                    }
                } else {
                    // Only log, don't overwrite copilot error with "no API key" message
                    log('OpenAI API key not configured, skipping');
                }
                break;
            }
        }
    }
    
    // All providers failed - show the most relevant error
    // If copilot found a model but failed, that's the main error
    const errorToShow = copilotError || lastError || 'All providers failed';
    return buildLlmErrorMessage(errorToShow);
}

/**
 * Call LLM specifically for coding tasks (translation, code generation)
 * Uses the configured coding provider
 */
async function callLanguageModelForCoding(prompt) {
    return callLanguageModel(prompt, 'coding');
}


// Try GitHub Copilot with retry logic
async function tryCopilot(prompt, preferredModel = null) {
    const maxRetries = 2;
    
    // Get preferred model from parameter or LLMConfig
    const configuredModel = preferredModel || LLMConfig.getDefaultModel();
    
    // Check if settings changed - if so, clear the failed models cache
    if (lastCopilotModelSetting !== configuredModel) {
        if (failedModelsCache.size > 0) {
            log('Settings changed, clearing failed models cache');
            failedModelsCache.clear();
        }
        lastCopilotModelSetting = configuredModel;
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (!vscode.lm || !vscode.lm.selectChatModels) {
                return { success: false, error: 'VS Code LM API not available (need VS Code 1.90+)' };
            }
            
            // Get available models
            let models = await vscode.lm.selectChatModels({});
            log(`Attempt ${attempt}: Found ${models.length} models`);
            
            // Log all available models for debugging
            if (models.length > 0) {
                log('Available models:', models.map(m => `${m.name || m.id} (${m.family || 'unknown family'})`).join(', '));
            }
            
            if (models.length === 0) {
                // Try copilot vendor specifically
                models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            }
            
            if (models.length === 0) {
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                return { success: false, error: 'No language models available' };
            }
            
            // Filter out models that have previously failed
            const originalCount = models.length;
            models = models.filter(m => {
                const modelId = m.id || m.name || m.family;
                return !failedModelsCache.has(modelId);
            });
            
            if (models.length === 0 && originalCount > 0) {
                // All models have failed before
                const failedList = Array.from(failedModelsCache).join(', ');
                log(`All ${originalCount} models have previously failed: ${failedList}`);
                return { 
                    success: false, 
                    error: `All available models have failed previously (${failedList}). Reload Astra or change settings to retry.` 
                };
            }
            
            if (models.length < originalCount) {
                log(`Filtered out ${originalCount - models.length} previously failed models, ${models.length} remaining`);
            }
            
            // Select model using centralized search order from LLMConfig
            let model = null;
            const modelSearchOrder = LLMConfig.getModelSearchOrder(configuredModel);
            
            // Search in order of preference
            for (const searchFn of modelSearchOrder) {
                model = models.find(searchFn);
                if (model) {
                    log(`Found model by preference: ${model.name || model.id}`);
                    break;
                }
            }
            
            // Fallback to first available
            if (!model) {
                model = models[0];
                log(`Using fallback model: ${model.name || model.id}`);
            }
            
            // Track the model being used
            lastUsedModel = {
                name: model.name || model.id || 'unknown',
                vendor: model.vendor || 'copilot',
                family: model.family || 'unknown',
                id: model.id
            };
            
            debugLog('COPILOT', `Selected model: ${lastUsedModel.name}`, {
                family: lastUsedModel.family,
                promptLength: prompt.length
            });
            
            // Show model in chat
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n*Using ${lastUsedModel.name}...*\n`
            });
            
            log('Prompt length:', prompt.length, 'chars');
            
            // Check if prompt is too large and needs chunking
            const MAX_PROMPT_SIZE = 25000; // ~6k tokens, conservative limit
            
            if (prompt.length > MAX_PROMPT_SIZE) {
                log('Large prompt detected, using chunked processing...');
                return await processLargePromptWithCopilot(model, prompt, MAX_PROMPT_SIZE);
            }
            
            // Normal processing for smaller prompts
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const cancellation = new vscode.CancellationTokenSource();
            
            // Try the selected model, with fallback to other models if it fails
            let modelsToTry = [model];
            
            // Add fallback models (other models from the available list)
            const fallbacks = models.filter(m => m !== model).slice(0, 2);
            modelsToTry = [...modelsToTry, ...fallbacks];
            
            for (let modelIdx = 0; modelIdx < modelsToTry.length; modelIdx++) {
                const currentModel = modelsToTry[modelIdx];
                
                if (modelIdx > 0) {
                    // Update lastUsedModel for fallback
                    lastUsedModel = {
                        name: currentModel.name || currentModel.id || 'unknown',
                        vendor: currentModel.vendor || 'copilot',
                        family: currentModel.family || 'unknown',
                        id: currentModel.id
                    };
                    
                    chatWebviewView?.webview.postMessage({ 
                        type: 'appendResponse', 
                        text: `\n*Trying fallback model: ${lastUsedModel.name}...*\n`
                    });
                    log(`Trying fallback model ${modelIdx}: ${lastUsedModel.name}`);
                }
                
                try {
                    let response = '';
                    const chatResponse = await currentModel.sendRequest(messages, {}, cancellation.token);
                    
                    for await (const chunk of chatResponse.text) {
                        response += chunk;
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: chunk 
                        });
                    }
                    
                    // Clean up any trailing refusal messages
                    const cleanedResponse = cleanLlmResponse(response);
                    
                    // If response was cleaned, send a correction to UI
                    if (cleanedResponse !== response) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'replaceLastResponse', 
                            text: cleanedResponse 
                        });
                    }
                    
                    return { 
                        success: true, 
                        response: cleanedResponse,
                        model: lastUsedModel
                    };
                    
                } catch (modelError) {
                    const errorMsg = modelError.message || String(modelError);
                    const failedModelId = currentModel.id || currentModel.name || currentModel.family;
                    log(`Model ${failedModelId} failed:`, errorMsg);
                    
                    // Add to failed models cache (unless it's a rate limit - those are temporary)
                    if (!errorMsg.includes('rate') && !errorMsg.includes('limit')) {
                        failedModelsCache.add(failedModelId);
                        log(`Added ${failedModelId} to failed models cache. Cache size: ${failedModelsCache.size}`);
                    }
                    
                    if (modelIdx < modelsToTry.length - 1) {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'appendResponse', 
                            text: `\n⚠️ *${lastUsedModel.name} failed (cached), trying next model...*\n`
                        });
                        continue; // Try next model
                    } else {
                        throw modelError; // No more models, throw to outer catch
                    }
                }
            }
            
        } catch (error) {
            const errorMsg = error.message || String(error);
            log(`Copilot attempt ${attempt} error:`, errorMsg);
            log(`Error details:`, error.code, error.cause);
            
            // Add to failed cache for persistent errors (not rate limits)
            if (lastUsedModel && !errorMsg.includes('rate') && !errorMsg.includes('limit')) {
                const failedModelId = lastUsedModel.id || lastUsedModel.name || lastUsedModel.family;
                if (failedModelId && failedModelId !== 'unknown') {
                    failedModelsCache.add(failedModelId);
                    log(`Added ${failedModelId} to failed models cache from outer catch`);
                }
            }
            
            // Check for specific error types
            if (errorMsg.includes('off_topic') || errorMsg.includes('filtered')) {
                return { success: false, error: 'Request was filtered by content policy. Try rephrasing.' };
            }
            if (errorMsg.includes('rate') || errorMsg.includes('limit')) {
                return { success: false, error: 'Rate limited. Please wait a moment and try again.' };
            }
            if (errorMsg.includes('access') || errorMsg.includes('permission') || errorMsg.includes('unauthorized')) {
                return { success: false, error: `Model access denied. The model "${lastUsedModel?.name}" may not be available in your Copilot subscription.` };
            }
            
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 500));
            } else {
                return { success: false, error: `Copilot request failed: ${errorMsg}` };
            }
        }
    }
    
    return { success: false, error: 'Max retries exceeded' };
}

// Process large prompts by chunking context files
async function processLargePromptWithCopilot(model, prompt, maxSize) {
    log('Processing large prompt with chunking...');
    
    // Parse the prompt to separate instructions from context
    const { instructions, contextFiles, query } = parsePromptParts(prompt);
    
    if (contextFiles.length === 0) {
        // No files to chunk - this is likely a summary-based prompt
        // Try truncating to fit the limit instead of failing
        log('No context files found to chunk - attempting truncated prompt');
        
        if (prompt.length > maxSize) {
            // Find a good truncation point (don't cut mid-line)
            let truncateAt = maxSize - 500; // Leave room for truncation notice
            const newlinePos = prompt.lastIndexOf('\n', truncateAt);
            if (newlinePos > truncateAt * 0.7) {
                truncateAt = newlinePos;
            }
            
            const truncatedPrompt = prompt.substring(0, truncateAt) + 
                '\n\n... [context truncated for size limit - respond based on available information above]';
            
            log('Truncated prompt from', prompt.length, 'to', truncatedPrompt.length);
            
            // Try with truncated prompt
            try {
                const messages = [vscode.LanguageModelChatMessage.User(truncatedPrompt)];
                const cancellation = new vscode.CancellationTokenSource();
                const response = await model.sendRequest(messages, {}, cancellation.token);
                
                let fullResponse = '';
                for await (const chunk of response.text) {
                    fullResponse += chunk;
                    chatWebviewView?.webview.postMessage({ type: 'appendResponse', text: chunk });
                }
                
                return { success: true, response: fullResponse };
            } catch (error) {
                log('Truncated prompt also failed:', error.message);
                return { success: false, error: `Prompt too large even after truncation: ${error.message}` };
            }
        }
        
        return { success: false, error: 'Prompt too large and cannot be processed' };
    }
    
    log(`Found ${contextFiles.length} context files to process`);
    
    // Check if this is a documentation request
    const isDocRequest = /document|documentation|deepwiki|full|detailed|comprehensive/i.test(query || prompt);
    
    // Process each file separately and collect summaries
    const summaries = [];
    let allSucceeded = true;
    
    for (let i = 0; i < contextFiles.length; i++) {
        const file = contextFiles[i];
        log(`Processing file ${i + 1}/${contextFiles.length}: ${file.name} (${file.content.length} chars)`);
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n\n---\n\n# 📄 ${file.name}\n\n`
        });
        
        // Build appropriate prompt based on request type
        let filePrompt;
        
        if (isDocRequest) {
            // DeepWiki-style documentation for each file
            filePrompt = `Generate comprehensive DeepWiki-style documentation for this code file.

FILE: ${file.name}
\`\`\`
${file.content.substring(0, maxSize - 2000)}
\`\`\`

Generate documentation with these sections:

## Overview
[What this program/module does - 2-3 sentences]

## Architecture
\`\`\`mermaid
flowchart TD
    A[Start] --> B[Process] --> C[End]
\`\`\`

## Key Components
| Component | Purpose |
|-----------|---------|
| ... | ... |

## Data Flow
### Input Variables
| Name | Type | Purpose |
|------|------|---------|
| ... | ... | ... |

### Processing Steps
1. **Step 1**: ...
2. **Step 2**: ...

### Output
| Name | Type | Purpose |
|------|------|---------|
| ... | ... | ... |

## Business Logic
### Decision Points
- Condition 1: ...
- Condition 2: ...

### Error Handling
| Error | Condition | Action |
|-------|-----------|--------|
| ... | ... | ... |

## External Dependencies
| Program/API | Purpose |
|-------------|---------|
| ... | ... |

## Key Variables
| Name | Type | Purpose |
|------|------|---------|
| ... | ... | ... |

Be thorough. Include actual content from the code.`;
        } else {
            // Concise explanation
            filePrompt = `Analyze this code file and provide a concise summary:

FILE: ${file.name}
\`\`\`
${file.content.substring(0, maxSize - 1000)}
\`\`\`

${query || 'Explain what this code does, its key functions, and main logic flow.'}

Be concise but thorough.`;
        }
        
        try {
            const messages = [vscode.LanguageModelChatMessage.User(filePrompt)];
            const cancellation = new vscode.CancellationTokenSource();
            
            let fileResponse = '';
            const chatResponse = await model.sendRequest(messages, {}, cancellation.token);
            
            for await (const chunk of chatResponse.text) {
                fileResponse += chunk;
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: chunk 
                });
            }
            
            // Clean any trailing refusal messages
            const cleanedResponse = cleanLlmResponse(fileResponse);
            
            summaries.push({
                name: file.name,
                summary: cleanedResponse
            });
            
        } catch (error) {
            log(`Error processing ${file.name}:`, error.message);
            allSucceeded = false;
            summaries.push({
                name: file.name,
                summary: `[Error analyzing: ${error.message}]`
            });
        }
    }
    
    // If we have multiple files, provide a combined summary
    if (summaries.length > 1 && allSucceeded) {
        log('Generating combined summary...');
        
        chatWebviewView?.webview.postMessage({ 
            type: 'appendResponse', 
            text: `\n\n### Overall Summary\n\n`
        });
        
        const combinedPrompt = `Based on these individual file analyses, provide a brief overall summary:

${summaries.map(s => `**${s.name}:**\n${s.summary.substring(0, 500)}...`).join('\n\n')}

${query || 'Summarize how these files work together and their overall purpose.'}`;
        
        try {
            const messages = [vscode.LanguageModelChatMessage.User(combinedPrompt)];
            const cancellation = new vscode.CancellationTokenSource();
            
            const chatResponse = await model.sendRequest(messages, {}, cancellation.token);
            
            for await (const chunk of chatResponse.text) {
                chatWebviewView?.webview.postMessage({ 
                    type: 'appendResponse', 
                    text: chunk 
                });
            }
        } catch (error) {
            log('Error generating combined summary:', error.message);
        }
    }
    
    // Return success if at least one file was processed
    const successCount = summaries.filter(s => !s.summary.startsWith('[Error')).length;
    if (successCount > 0) {
        return { 
            success: true, 
            response: summaries.map(s => `## ${s.name}\n\n${s.summary}`).join('\n\n')
        };
    }
    
    return { success: false, error: 'All chunk processing failed' };
}

// Parse prompt to extract context files and instructions
function parsePromptParts(prompt) {
    const contextFiles = [];
    let instructions = '';
    let query = '';
    
    // Look for file markers in prompt
    // Common patterns: "=== filename ===", "FILE: filename", "--- filename ---"
    const filePattern = /(?:===|FILE:|---)\s*([^\n=]+?)\s*(?:===|---)?[\n\r]+```[\w]*\n?([\s\S]*?)```/gi;
    
    let match;
    while ((match = filePattern.exec(prompt)) !== null) {
        contextFiles.push({
            name: match[1].trim(),
            content: match[2].trim()
        });
    }
    
    // Also try simple pattern: "=== filename (language) ===\ncontent\n\n"
    const simplePattern = /===\s*([^\n(]+?)(?:\s*\([^)]+\))?\s*===\n([\s\S]*?)(?=\n===|\n\n---|\nUSER|$)/gi;
    
    while ((match = simplePattern.exec(prompt)) !== null) {
        const name = match[1].trim();
        // Avoid duplicates
        if (!contextFiles.find(f => f.name === name)) {
            contextFiles.push({
                name: name,
                content: match[2].trim()
            });
        }
    }
    
    // Extract query (usually after USER REQUEST: or at the end)
    const queryMatch = prompt.match(/USER REQUEST:\s*(.+?)(?:\n|$)/i) ||
                       prompt.match(/USER QUESTION:\s*(.+?)(?:\n|$)/i);
    if (queryMatch) {
        query = queryMatch[1].trim();
    }
    
    // Everything before the first file is instructions
    const firstFilePos = prompt.search(/(?:===|FILE:|---)\s*[^\n]+/);
    if (firstFilePos > 0) {
        instructions = prompt.substring(0, firstFilePos).trim();
    }
    
    log('Parsed prompt:', {
        filesFound: contextFiles.length,
        fileNames: contextFiles.map(f => f.name),
        hasQuery: !!query,
        instructionsLength: instructions.length
    });
    
    return { instructions, contextFiles, query };
}


// Call Anthropic Claude API directly
async function callAnthropicApi(prompt, apiKey, model = null) {
    // Use provided model or get default from LLMConfig
    const configuredModel = model || LLMConfig.getDefaultModel();
    
    log(`Anthropic API: Using model ${configuredModel}`);
    
    return new Promise((resolve, reject) => {
        const https = require('https');
        
        const postData = JSON.stringify({
            model: configuredModel,
            max_tokens: 8192,
            messages: [{ role: 'user', content: prompt }]
        });
        
        const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        const error = JSON.parse(data);
                        reject(new Error(error.error?.message || `Anthropic API error ${res.statusCode}`));
                        return;
                    }
                    const json = JSON.parse(data);
                    const text = json.content?.[0]?.text || '';
                    chatWebviewView?.webview.postMessage({ type: 'appendResponse', text });
                    resolve(text);
                } catch (e) {
                    reject(new Error(`Invalid response: ${e.message}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Call OpenAI API directly
async function callOpenAIApi(prompt, apiKey, model = null) {
    // Use provided model or get default from LLMConfig
    const configuredModel = model || LLMConfig.getDefaultModel();
    
    log(`OpenAI API: Using model ${configuredModel}`);
    
    return new Promise((resolve, reject) => {
        const https = require('https');
        
        const postData = JSON.stringify({
            model: configuredModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8192
        });
        
        const options = {
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        const error = JSON.parse(data);
                        reject(new Error(error.error?.message || `OpenAI API error ${res.statusCode}`));
                        return;
                    }
                    const json = JSON.parse(data);
                    const text = json.choices?.[0]?.message?.content || '';
                    chatWebviewView?.webview.postMessage({ type: 'appendResponse', text });
                    resolve(text);
                } catch (e) {
                    reject(new Error(`Invalid response: ${e.message}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Build helpful error message
function buildLlmErrorMessage(error) {
    let copilotStatus = 'Unknown';
    try {
        const copilotExt = vscode.extensions.getExtension('GitHub.copilot') || 
                          vscode.extensions.getExtension('github.copilot');
        const copilotChatExt = vscode.extensions.getExtension('GitHub.copilot-chat') ||
                              vscode.extensions.getExtension('github.copilot-chat');
        
        if (copilotExt?.isActive || copilotChatExt?.isActive) {
            copilotStatus = 'Active but LM API failed';
        } else if (copilotExt || copilotChatExt) {
            copilotStatus = 'Installed but not active';
        } else {
            copilotStatus = 'Not installed';
        }
    } catch (e) {
        copilotStatus = error || 'Error checking';
    }
    
    return `**Language Model not available**

**GitHub Copilot Status:** ${copilotStatus}
**Error:** ${error || 'Unknown'}

---

**Fix Option 1: Reload VS Code (if Copilot installed)**
\`Cmd+Shift+P\` → "Developer: Reload Window"

**Fix Option 2: Check Copilot subscription**
Make sure you have an active GitHub Copilot subscription and are signed in.

**Fix Option 3: Set direct API key in extension settings**
\`Cmd+,\` → Search "astra anthropic" or "astra openai" → Paste key

---

**Context ready:** ${contextFiles.size} files loaded
Check logs: \`View → Output → AstraCode\``;
}

// ============================================================
// UI Updates
// ============================================================

function updateChatUI() {
    chatWebviewView?.webview.postMessage({
        type: 'updateChat',
        history: chatHistory
    });
}

function updateChatStatus() {
    const fileCount = contextFiles.size;
    
    // Rebuild code index when files change (but not if already indexing)
    if (fileCount > 0 && !updateChatStatus.isIndexing) {
        // Only rebuild if index is stale (files changed since last build)
        const indexNeedsRebuild = codeIndex.files.size !== fileCount || 
            !codeIndex.lastUpdated ||
            Array.from(contextFiles.keys()).some(path => !codeIndex.files.has(path));
        
        if (indexNeedsRebuild) {
            // Use setTimeout to debounce rapid file additions
            if (updateChatStatus.indexTimeout) {
                clearTimeout(updateChatStatus.indexTimeout);
            }
            updateChatStatus.indexTimeout = setTimeout(async () => {
                updateChatStatus.isIndexing = true;
                try {
                    await buildCodeIndex({ showProgress: true });
                } finally {
                    updateChatStatus.isIndexing = false;
                }
                // Just update the UI status display, don't trigger another rebuild check
                updateChatStatusUI();
            }, 500);
        }
    } else if (fileCount === 0) {
        // Clear index when no files
        codeIndex.files.clear();
        codeIndex.symbols.clear();
        codeIndex.callGraph.clear();
        codeIndex.reverseCallGraph.clear();
    }
    
    // Always update the UI
    updateChatStatusUI();
}

// Separate function to just update UI without triggering rebuild
function updateChatStatusUI() {
    const fileCount = contextFiles.size;
    
    // Build file list with paths for removal
    const files = Array.from(contextFiles.entries()).map(([path, file]) => ({
        name: file.uri.path.split('/').pop(),
        path: path,
        language: file.language
    }));
    
    const modeText = {
        'auto': 'Auto Mode',
        'local': 'Local Mode (context files)',
        'api': 'API Mode (search codebase)'
    };
    
    // Include index stats in status (compact format)
    let indexInfo = '';
    let indexReady = false;
    
    if (codeIndex.symbols.size > 0) {
        const callableCount = codeIndex.callGraph.size;
        const summaryCount = codeIndex.summaries.size;
        const trigramCount = trigramIndex.index.size;
        
        // Base stats
        indexInfo = ` • ${codeIndex.symbols.size} sym • ${callableCount} funcs`;
        
        // Add trigrams if available
        if (trigramCount > 0) {
            indexInfo += ` • ${trigramCount} tri`;
        }
        
        // Add summaries if available (shows AI-enhanced search is ready)
        if (summaryCount > 0) {
            indexInfo += ` • ${summaryCount} sum`;
        }
        
        // Index is ready when we have symbols AND trigrams
        indexReady = codeIndex.symbols.size > 0 && trigramCount > 0;
    }
    
    // Add light bulb when index is ready 💡
    const statusIndicator = indexReady ? '💡 ' : '';
    
    chatWebviewView?.webview.postMessage({
        type: 'updateStatus',
        mode: currentMode,
        text: statusIndicator + modeText[currentMode] + (fileCount > 0 ? ` • ${fileCount} files${indexInfo}` : ''),
        files: files,
        indexReady: indexReady
    });
}

// ============================================================
// Context File Management
// ============================================================

async function addFileToContext(uri, silent = false) {
    try {
        const fileName = uri.path.split('/').pop();
        const ext = fileName.split('.').pop().toLowerCase();
        
        // Check for PDF - needs special handling
        if (ext === 'pdf') {
            const pdfResult = await extractPdfText(uri);
            if (pdfResult.error) {
                if (!silent) {
                    vscode.window.showWarningMessage(`PDF added but text extraction limited: ${fileName}`);
                }
            }
            
            const fileData = {
                uri: uri,
                content: pdfResult.text || `[PDF file: ${fileName} - could not extract text. Consider using a PDF-to-text tool first.]`,
                language: 'pdf',
                addedAt: new Date().toISOString()
            };
            
            contextFiles.set(uri.fsPath, fileData);
            
            // Persist the file
            if (persistenceManager) {
                persistenceManager.saveContextFile(uri.fsPath, fileData);
                persistenceManager.markDirty();
            }
            
            contextTreeProvider.refresh();
            updateChatStatus();
            log('Added PDF to context:', uri.fsPath);
            if (!silent) {
                vscode.window.showInformationMessage(`Added PDF to AstraCode context: ${fileName}`);
            }
            return;
        }
        
        // Check for other binary files
        if (isBinaryFile(fileName)) {
            if (!silent) {
                vscode.window.showWarningMessage(`Cannot add binary file: ${fileName}`);
            }
            return;
        }
        
        const content = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(content).toString('utf-8');
        
        // Check if content looks like binary (has too many non-printable chars)
        const nonPrintable = text.split('').filter(c => {
            const code = c.charCodeAt(0);
            return code < 32 && code !== 9 && code !== 10 && code !== 13;
        }).length;
        
        if (nonPrintable > text.length * 0.1) {
            if (!silent) {
                vscode.window.showWarningMessage(`File appears to be binary: ${fileName}`);
            }
            return;
        }
        
        const language = detectLanguage(uri.path);
        log('addFileToContext: Detected language:', language, 'for file:', uri.path);
        
        const fileData = {
            uri: uri,
            content: text,
            language: language,
            addedAt: new Date().toISOString()
        };
        
        contextFiles.set(uri.fsPath, fileData);
        
        // Persist the file
        if (persistenceManager) {
            persistenceManager.saveContextFile(uri.fsPath, fileData);
            persistenceManager.markDirty();
        }
        
        contextTreeProvider.refresh();
        updateChatStatus();
        
        log('Added to context:', uri.fsPath);
        if (!silent) {
            vscode.window.showInformationMessage(`Added to AstraCode context: ${fileName}`);
        }
        
    } catch (error) {
        log('Error adding file:', error);
        if (!silent) {
            vscode.window.showErrorMessage(`Failed to add file: ${error.message}`);
        }
        throw error; // Re-throw for directory handler
    }
}

// Extract text from PDF (basic extraction)
async function extractPdfText(uri) {
    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const buffer = Buffer.from(content);
        
        // Try to extract text using basic PDF text extraction
        // PDFs store text in various ways, this handles simple cases
        let text = '';
        const pdfString = buffer.toString('binary');
        
        // Look for text streams in PDF
        const textMatches = pdfString.match(/\(([^)]+)\)/g) || [];
        const extractedParts = [];
        
        for (const match of textMatches) {
            const inner = match.slice(1, -1);
            // Filter out binary/control sequences
            if (inner.length > 2 && /^[\x20-\x7E\s]+$/.test(inner)) {
                extractedParts.push(inner);
            }
        }
        
        // Also try to find BT...ET text blocks
        const btMatches = pdfString.match(/BT[\s\S]*?ET/g) || [];
        for (const block of btMatches) {
            const tjMatches = block.match(/\[([^\]]+)\]\s*TJ/g) || [];
            for (const tj of tjMatches) {
                const parts = tj.match(/\(([^)]+)\)/g) || [];
                for (const part of parts) {
                    const inner = part.slice(1, -1);
                    if (inner.length > 0 && /^[\x20-\x7E\s]+$/.test(inner)) {
                        extractedParts.push(inner);
                    }
                }
            }
        }
        
        text = extractedParts.join(' ').replace(/\s+/g, ' ').trim();
        
        if (text.length < 100) {
            // Not enough text extracted - PDF might be image-based or complex
            return {
                text: `[PDF file - limited text extracted]\n\nExtracted content:\n${text}\n\n[Note: This PDF may contain images or complex formatting. For better results, convert to text first using a PDF tool.]`,
                error: 'Limited extraction'
            };
        }
        
        return { text: `[Extracted from PDF]\n\n${text}`, error: null };
        
    } catch (error) {
        log('PDF extraction error:', error);
        return { 
            text: null, 
            error: error.message 
        };
    }
}

function removeFileFromContext(uri) {
    const path = uri?.fsPath || uri;
    if (contextFiles.has(path)) {
        contextFiles.delete(path);
        contextTreeProvider.refresh();
        updateChatStatus();
        log('Removed from context:', path);
    }
}

function clearContext() {
    contextFiles.clear();
    
    // Also clear the code index
    codeIndex.files.clear();
    codeIndex.symbols.clear();
    codeIndex.variables.clear();
    codeIndex.callGraph.clear();
    codeIndex.reverseCallGraph.clear();
    codeIndex.dependencies.clear();
    codeIndex.summaries.clear();
    codeIndex.fileSummaries.clear();
    codeIndex.overallSummary = null;
    codeIndex.discoveredDomain = null;  // Clear discovered domain
    codeIndex.lastUpdated = null;
    
    contextTreeProvider.refresh();
    updateChatStatus();
    log('Context and index cleared (including domain)');
}

function detectLanguage(path) {
    const ext = path.split('.').pop().toLowerCase();
    const langMap = {
        // Legacy - COBOL
        'cbl': 'cobol', 'cob': 'cobol', 'cobol': 'cobol', 'cpy': 'cobol', 'pco': 'cobol',
        // Legacy - TAL/TACL
        'tal': 'tal', 'tacl': 'tacl', 'tac': 'tacl',
        // C family
        'c': 'c', 'h': 'c',
        'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
        // Java/JVM
        'java': 'java', 'scala': 'scala', 'kt': 'kotlin', 'groovy': 'groovy',
        // C#/.NET
        'cs': 'csharp', 'csx': 'csharp',
        // Python
        'py': 'python', 'pyw': 'python', 'pyx': 'python',
        // JavaScript/TypeScript
        'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
        'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
        'd.ts': 'typescript',
        // SQL variants
        'sql': 'sql', 'ddl': 'sql', 'dml': 'sql', 'prc': 'sql', 'fnc': 'sql',
        'pks': 'sql', 'pkb': 'sql', 'trg': 'sql', 'vw': 'sql', 'plsql': 'sql',
        'psql': 'sql', 'tsql': 'sql',
        // Web
        'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'scss', 'sass': 'sass',
        // Data
        'json': 'json', 'xml': 'xml', 'yaml': 'yaml', 'yml': 'yaml',
        'csv': 'csv', 'tsv': 'tsv',
        // Shell/Scripts
        'sh': 'bash', 'bash': 'bash', 'zsh': 'zsh', 'fish': 'fish',
        'ps1': 'powershell', 'bat': 'batch', 'cmd': 'batch',
        // Other languages
        'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php',
        'swift': 'swift', 'fs': 'fsharp', 'vb': 'vb',
        'pl': 'perl', 'r': 'r', 'lua': 'lua',
        // Config
        'md': 'markdown', 'txt': 'text', 'log': 'log',
        'ini': 'ini', 'cfg': 'ini', 'conf': 'ini', 'properties': 'properties',
        'toml': 'toml', 'env': 'env',
        // Documents
        'pdf': 'pdf', 'doc': 'document', 'docx': 'document', 'rtf': 'document'
    };
    return langMap[ext] || ext || 'text';
}

/**
 * Get file extension for a target language
 */
function getFileExtension(language) {
    const extensions = {
        // Common languages
        'java': 'java',
        'javascript': 'js',
        'typescript': 'ts',
        'python': 'py',
        'c': 'c',
        'cpp': 'cpp',
        'c++': 'cpp',
        'csharp': 'cs',
        'c#': 'cs',
        'go': 'go',
        'golang': 'go',
        'rust': 'rs',
        'ruby': 'rb',
        'php': 'php',
        'swift': 'swift',
        'kotlin': 'kt',
        'scala': 'scala',
        
        // Legacy languages
        'cobol': 'cbl',
        'fortran': 'f90',
        'pascal': 'pas',
        'ada': 'adb',
        'tal': 'tal',
        
        // Scripting
        'perl': 'pl',
        'lua': 'lua',
        'r': 'R',
        'julia': 'jl',
        'shell': 'sh',
        'bash': 'sh',
        'powershell': 'ps1',
        
        // Web
        'html': 'html',
        'css': 'css',
        'jsx': 'jsx',
        'tsx': 'tsx',
        'vue': 'vue',
        
        // Data
        'sql': 'sql',
        'json': 'json',
        'yaml': 'yaml',
        'xml': 'xml'
    };
    
    return extensions[language.toLowerCase()] || language.toLowerCase();
}

/**
 * Extract symbols (functions, classes, variables) from code
 * Returns array of { name, type, line }
 */
function extractSymbolsFromCode(content, language) {
    const symbols = [];
    const lines = content.split('\n');
    const langLower = (language || '').toLowerCase();
    
    // Language-specific patterns
    const patterns = {
        'java': [
            { regex: /(?:public|private|protected)?\s*(?:static)?\s*class\s+(\w+)/g, type: 'class' },
            { regex: /(?:public|private|protected)?\s*(?:static)?\s*(?:void|int|String|boolean|double|float|long|\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g, type: 'method' },
            { regex: /(?:public|private|protected)?\s*(?:static)?\s*(?:final)?\s*(?:int|String|boolean|double|float|long|\w+)\s+(\w+)\s*[=;]/g, type: 'field' }
        ],
        'python': [
            { regex: /^class\s+(\w+)/gm, type: 'class' },
            { regex: /^def\s+(\w+)/gm, type: 'function' },
            { regex: /^(\w+)\s*=/gm, type: 'variable' }
        ],
        'javascript': [
            { regex: /class\s+(\w+)/g, type: 'class' },
            { regex: /function\s+(\w+)/g, type: 'function' },
            { regex: /(?:const|let|var)\s+(\w+)/g, type: 'variable' },
            { regex: /(\w+)\s*[=:]\s*(?:async\s+)?function/g, type: 'function' },
            { regex: /(\w+)\s*[=:]\s*\([^)]*\)\s*=>/g, type: 'function' }
        ],
        'typescript': [
            { regex: /class\s+(\w+)/g, type: 'class' },
            { regex: /interface\s+(\w+)/g, type: 'interface' },
            { regex: /type\s+(\w+)/g, type: 'type' },
            { regex: /function\s+(\w+)/g, type: 'function' },
            { regex: /(?:const|let|var)\s+(\w+)/g, type: 'variable' }
        ],
        'c': [
            { regex: /(?:struct|union)\s+(\w+)/g, type: 'struct' },
            { regex: /^(?:static\s+)?(?:inline\s+)?(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*\{/gm, type: 'function' },
            { regex: /#define\s+(\w+)/g, type: 'macro' }
        ],
        'cpp': [
            { regex: /class\s+(\w+)/g, type: 'class' },
            { regex: /(?:struct|union)\s+(\w+)/g, type: 'struct' },
            { regex: /namespace\s+(\w+)/g, type: 'namespace' }
        ],
        'cobol': [
            { regex: /PROGRAM-ID\.\s+(\S+)/gi, type: 'program' },
            { regex: /^\s*\d+\s+(\w[\w-]+)\s+(?:PIC|PICTURE)/gim, type: 'variable' },
            { regex: /^\s*(\w[\w-]+)\s+SECTION\./gim, type: 'section' },
            { regex: /^\s*(\w[\w-]+)\.\s*$/gm, type: 'paragraph' }
        ],
        'tal': [
            { regex: /^(?:INT|REAL|FIXED|STRING|STRUCT)\s+(\w+)/gim, type: 'variable' },
            { regex: /^(?:PROC|SUBPROC)\s+(\w+)/gim, type: 'procedure' },
            { regex: /^DEFINE\s+(\w+)/gim, type: 'define' }
        ]
    };
    
    // Get patterns for this language, or use generic patterns
    const langPatterns = patterns[langLower] || [
        { regex: /class\s+(\w+)/g, type: 'class' },
        { regex: /function\s+(\w+)/g, type: 'function' },
        { regex: /def\s+(\w+)/g, type: 'function' },
        { regex: /(?:const|let|var|int|string|bool)\s+(\w+)/gi, type: 'variable' }
    ];
    
    // Extract symbols
    for (const pattern of langPatterns) {
        let match;
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        while ((match = regex.exec(content)) !== null) {
            const name = match[1];
            if (name && name.length > 1 && !symbols.some(s => s.name === name)) {
                // Find line number
                const beforeMatch = content.substring(0, match.index);
                const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
                
                symbols.push({
                    name,
                    type: pattern.type,
                    line: lineNum
                });
            }
        }
    }
    
    return symbols;
}

// Check if a path is a binary file (skip these)
function isBinaryFile(filename) {
    const binaryExts = [
        'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib',
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z', 'jar', 'war',
        'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
        'ttf', 'otf', 'woff', 'woff2', 'eot',
        'class', 'pyc', 'pyo'
    ];
    const ext = filename.split('.').pop().toLowerCase();
    return binaryExts.includes(ext);
}

// Add file or directory to context
async function addToContext(uri) {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        
        if (stat.type === vscode.FileType.Directory) {
            await addDirectoryToContext(uri);
        } else if (stat.type === vscode.FileType.File) {
            await addFileToContext(uri);
        }
    } catch (error) {
        log('Error adding to context:', error);
        vscode.window.showErrorMessage(`Failed to add: ${error.message}`);
    }
}

// Recursively add directory contents
async function addDirectoryToContext(dirUri, depth = 0) {
    if (depth > 3) {
        log('Max depth reached, skipping:', dirUri.fsPath);
        return;
    }
    
    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        let addedCount = 0;
        
        for (const [name, type] of entries) {
            // Skip hidden files and common non-code directories
            if (name.startsWith('.') || 
                name === 'node_modules' || 
                name === '__pycache__' ||
                name === 'target' ||
                name === 'build' ||
                name === 'dist' ||
                name === 'bin' ||
                name === 'obj') {
                continue;
            }
            
            const childUri = vscode.Uri.joinPath(dirUri, name);
            
            if (type === vscode.FileType.Directory) {
                await addDirectoryToContext(childUri, depth + 1);
            } else if (type === vscode.FileType.File) {
                // Skip binary files
                if (isBinaryFile(name)) {
                    continue;
                }
                
                try {
                    await addFileToContext(childUri, true); // silent mode
                    addedCount++;
                } catch (e) {
                    // Skip files we can't read
                    log('Skipping unreadable file:', name);
                }
            }
        }
        
        if (depth === 0) {
            vscode.window.showInformationMessage(`Added ${contextFiles.size} files from directory`);
        }
        
    } catch (error) {
        log('Error reading directory:', error);
    }
}

// ============================================================
// Extension Activation
// ============================================================

let contextTreeProvider;

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AstraCode');
    log('AstraCode v5.1.3 activating...');
    
    // Initialize the new modular CodeIndex
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
    
    // Initialize session memory
    sessionMemory = new SessionMemory({
        maxTurns: 100,
        log: log
    });
    log('SessionMemory initialized');
    
    // Initialize persistence manager
    persistenceManager = new PersistenceManager(context);
    
    // Restore state from previous session
    try {
        log('Restoring state from previous session...');
        const restoredState = await persistenceManager.restoreAll();
        
        // Restore context files
        if (restoredState.contextFiles && restoredState.contextFiles.size > 0) {
            for (const [path, file] of restoredState.contextFiles) {
                contextFiles.set(path, file);
            }
            log('Restored', contextFiles.size, 'context files');
        }
        
        // Restore chat history
        if (restoredState.chatHistory && restoredState.chatHistory.length > 0) {
            chatHistory = restoredState.chatHistory;
            log('Restored', chatHistory.length, 'chat messages');
        }
        
        // Restore mode
        if (restoredState.currentMode) {
            currentMode = restoredState.currentMode;
            log('Restored mode:', currentMode);
        }
        
        // Log last session info
        if (restoredState.lastSession) {
            log('Last session:', restoredState.lastSession.timestamp);
        }
    } catch (error) {
        log('Error restoring state:', error.message);
    }
    
    // Set state references for persistence manager
    persistenceManager.setStateReferences({
        contextFiles: contextFiles,
        chatHistory: chatHistory,
        currentMode: currentMode,
        codeIndex: codeIndex
    });
    
    // Start auto-save
    persistenceManager.startAutoSave();
    
    // Initialize search module
    initializeSearchModule();
    
    // Create status bar item for summary progress
    summaryStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    summaryStatusBarItem.name = 'AstraCode Summary';
    context.subscriptions.push(summaryStatusBarItem);
    
    // Register context files tree provider
    contextTreeProvider = new ContextFilesProvider();
    vscode.window.registerTreeDataProvider('astra.contextView', contextTreeProvider);
    
    // Refresh tree with restored context files
    if (contextFiles.size > 0) {
        contextTreeProvider.refresh();
    }
    
    // Register chat webview provider with persistence support
    const chatProvider = new ChatViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('astra.chatView', chatProvider, {
            webviewOptions: {
                retainContextWhenHidden: true  // Keep webview state when hidden
            }
        })
    );
    
    // Try to load persisted vector index
    loadVectorIndex().then(loaded => {
        if (loaded) {
            log('Loaded persisted vector index');
        }
    });
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('astra.openChat', () => {
            vscode.commands.executeCommand('astra.chatView.focus');
        }),
        
        vscode.commands.registerCommand('astra.addFileToContext', async (uri) => {
            if (!uri && vscode.window.activeTextEditor) {
                uri = vscode.window.activeTextEditor.document.uri;
            }
            if (uri) {
                await addFileToContext(uri);
            }
        }),
        
        vscode.commands.registerCommand('astra.removeFileFromContext', (item) => {
            if (item?.resourceUri) {
                removeFileFromContext(item.resourceUri);
            }
        }),
        
        vscode.commands.registerCommand('astra.clearContext', () => {
            clearContext();
            vscode.window.showInformationMessage('AstraCode context cleared');
        }),
        
        vscode.commands.registerCommand('astra.rebuildIndex', async () => {
            if (contextFiles.size === 0) {
                vscode.window.showWarningMessage('No files in context to index');
                return;
            }
            vscode.window.showInformationMessage(`Rebuilding index for ${contextFiles.size} files...`);
            updateChatStatus.isIndexing = true;
            try {
                // Build symbol index (legacy)
                const stats = await buildCodeIndex({ showProgress: true });
                
                // Build vector index (legacy)
                chatWebviewView?.webview.postMessage({ 
                    type: 'indexProgress', 
                    progress: 50, 
                    message: 'Building vector index...' 
                });
                
                await buildVectorIndex({
                    showProgress: true,
                    onProgress: (pct, msg) => {
                        chatWebviewView?.webview.postMessage({ 
                            type: 'indexProgress', 
                            progress: 50 + Math.round(pct / 2), 
                            message: msg 
                        });
                    }
                });
                
                // Also build using new modular CodeIndex (parallel data structure for now)
                if (codeIndexManager) {
                    log('Building modular CodeIndex...');
                    await codeIndexManager.build(contextFiles);
                    const modularStats = codeIndexManager.getStats();
                    log('Modular CodeIndex stats:', JSON.stringify(modularStats));
                }
                
                const vectorStats = getVectorIndexStats();
                const vectorMsg = vectorStats ? `, ${vectorStats.chunks} vectors` : '';
                
                vscode.window.showInformationMessage(
                    `Index rebuilt: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions${vectorMsg}`
                );
            } finally {
                updateChatStatus.isIndexing = false;
            }
            updateChatStatusUI();
        }),
        
        vscode.commands.registerCommand('astra.generateSummaries', async () => {
            if (codeIndex.symbols.size === 0) {
                vscode.window.showWarningMessage('No code indexed yet. Add files and rebuild index first.');
                return;
            }
            
            const funcCount = codeIndex.callGraph.size;
            const choice = await vscode.window.showQuickPick([
                { label: `All ${funcCount} functions`, value: null },
                { label: 'Top 500 by importance', value: 500 },
                { label: 'Top 200 by importance', value: 200 },
                { label: 'Top 100 by importance', value: 100 }
            ], {
                placeHolder: `Generate AI summaries for functions (current: ${codeIndex.summaries.size})`
            });
            
            if (!choice) return;
            
            vscode.window.showInformationMessage(`Generating summaries for ${choice.value || 'all'} functions...`);
            
            try {
                await generateCodeSummaries(choice.value);
                updateChatStatusUI();
                vscode.window.showInformationMessage(`Generated ${codeIndex.summaries.size} function summaries`);
            } catch (err) {
                vscode.window.showErrorMessage(`Summary generation failed: ${err.message}`);
            }
        }),
        
        vscode.commands.registerCommand('astra.clearIndex', async () => {
            // Clear symbol index
            codeIndex.files.clear();
            codeIndex.symbols.clear();
            codeIndex.variables.clear();
            codeIndex.callGraph.clear();
            codeIndex.reverseCallGraph.clear();
            codeIndex.dependencies.clear();
            codeIndex.summaries.clear();
            codeIndex.fileSummaries.clear();
            codeIndex.overallSummary = null;
            codeIndex.discoveredDomain = null;  // Clear discovered domain
            codeIndex.lastUpdated = null;
            
            // Clear vector index
            await clearVectorIndex();
            
            // Clear search indexes
            searchModule.clearSearchIndexes();
            
            updateChatStatusUI();
            vscode.window.showInformationMessage('All indexes cleared (symbol + vector + domain)');
            log('All indexes cleared manually');
        }),
        
        vscode.commands.registerCommand('astra.clearFailedModels', () => {
            const count = failedModelsCache.size;
            failedModelsCache.clear();
            lastCopilotModelSetting = null;  // Also reset the setting tracker
            if (count > 0) {
                vscode.window.showInformationMessage(`Cleared ${count} failed model(s) from cache. All models will be retried.`);
                log(`Cleared ${count} failed models from cache`);
            } else {
                vscode.window.showInformationMessage('No failed models in cache.');
            }
        }),
        
        vscode.commands.registerCommand('astra.cancelTask', () => {
            if (taskController.currentTask) {
                const taskName = taskController.currentTask;
                const elapsed = taskController.startTime 
                    ? Math.round((Date.now() - taskController.startTime.getTime()) / 1000)
                    : 0;
                    
                taskController.cancel();
                chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing: false });
                chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
                
                vscode.window.showWarningMessage(`Cancelled: ${taskName} (ran for ${elapsed}s)`);
                log(`Task cancelled via command palette: ${taskName} after ${elapsed}s`);
            } else {
                vscode.window.showInformationMessage('No task currently running.');
            }
        }),
        
        vscode.commands.registerCommand('astra.showIndexStats', () => {
            if (codeIndex.files.size === 0 && vectorIndex.chunks.length === 0) {
                vscode.window.showInformationMessage('No index built yet. Add files first.');
                return;
            }
            
            const funcs = Array.from(codeIndex.symbols.values())
                .filter(s => s.type === 'function' || s.type === 'method' || s.type === 'procedure');
            const classes = Array.from(codeIndex.symbols.values())
                .filter(s => s.type === 'class' || s.type === 'struct');
            
            const vectorStats = getVectorIndexStats();
            const vectorSection = vectorStats 
                ? `\n\n🔍 Vector Index:\n• Chunks: ${vectorStats.chunks}\n• Files: ${vectorStats.files}\n• Memory: ${vectorStats.memorySizeMB} MB`
                : '\n\n🔍 Vector Index: Not built';
            
            const msg = `📊 Index Stats:

📁 Symbol Index:
• Files: ${codeIndex.files.size}
• Symbols: ${codeIndex.symbols.size}
• Functions/Methods: ${funcs.length}
• Classes/Structs: ${classes.length}
• Call Graph Entries: ${codeIndex.callGraph.size}${vectorSection}`;
            
            vscode.window.showInformationMessage(msg, { modal: true });
        }),
        
        vscode.commands.registerCommand('astra.showCallGraph', async () => {
            if (codeIndex.callGraph.size === 0) {
                vscode.window.showWarningMessage('No call graph built yet. Add code files first.');
                return;
            }
            
            // Generate HTML content
            const htmlContent = generateCallGraphHtml();
            
            // Save to .astra folder
            let savedPath = null;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const astraDir = vscode.Uri.file(workspaceRoot + '/.astra');
                
                try {
                    await vscode.workspace.fs.createDirectory(astraDir);
                } catch (e) { /* ignore if exists */ }
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                const filePath = vscode.Uri.file(workspaceRoot + `/.astra/call-graph-${timestamp}.html`);
                
                await vscode.workspace.fs.writeFile(filePath, Buffer.from(htmlContent, 'utf8'));
                savedPath = filePath.fsPath;
                log('Call graph saved to:', savedPath);
            }
            
            // Create webview panel for visual call graph
            const panel = vscode.window.createWebviewPanel(
                'astraCallGraph',
                'AstraCode Call Graph',
                vscode.ViewColumn.One,
                {
                    enableScripts: true
                }
            );
            
            // Add "Open in Browser" button to the HTML
            const htmlWithBrowserButton = htmlContent.replace(
                '<h1>⬡ Call Graph Analysis</h1>',
                `<h1>⬡ Call Graph Analysis</h1>
                <div style="margin-bottom: 15px;">
                    ${savedPath ? `<button onclick="copyPath()" style="padding: 8px 16px; background: #0e639c; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">📋 Copy File Path</button>
                    <span style="color: #808080; font-size: 12px;">Open in browser: ${savedPath}</span>
                    <script>function copyPath() { navigator.clipboard.writeText('${savedPath.replace(/\\/g, '\\\\')}'); }</script>` : ''}
                </div>`
            );
            
            panel.webview.html = htmlWithBrowserButton;
            
            // Show info message with option to open in browser
            if (savedPath) {
                const choice = await vscode.window.showInformationMessage(
                    'Call graph generated! Open in browser for better zoom/pan?',
                    'Open in Browser',
                    'Just View Here'
                );
                
                if (choice === 'Open in Browser') {
                    vscode.env.openExternal(vscode.Uri.file(savedPath));
                }
            }
        }),
        
        vscode.commands.registerCommand('astra.openCallGraphInBrowser', async () => {
            if (codeIndex.callGraph.size === 0) {
                vscode.window.showWarningMessage('No call graph built yet. Add code files first.');
                return;
            }
            
            // Generate and save HTML
            const htmlContent = generateCallGraphHtml();
            
            let filePath;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const astraDir = vscode.Uri.file(workspaceRoot + '/.astra');
                
                try {
                    await vscode.workspace.fs.createDirectory(astraDir);
                } catch (e) { /* ignore if exists */ }
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                filePath = vscode.Uri.file(workspaceRoot + `/.astra/call-graph-${timestamp}.html`);
            } else {
                // Use temp directory
                const os = require('os');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                filePath = vscode.Uri.file(os.tmpdir() + `/astra-call-graph-${timestamp}.html`);
            }
            
            await vscode.workspace.fs.writeFile(filePath, Buffer.from(htmlContent, 'utf8'));
            
            // Open in default browser
            vscode.env.openExternal(filePath);
            vscode.window.showInformationMessage(`Call graph opened in browser: ${filePath.fsPath}`);
        }),
        
        vscode.commands.registerCommand('astra.showCallersOf', async () => {
            if (codeIndex.symbols.size === 0) {
                vscode.window.showWarningMessage('No index built yet. Add code files first.');
                return;
            }
            
            // Get list of functions
            const funcs = Array.from(codeIndex.symbols.entries())
                .filter(([k, v]) => v.type === 'function' || v.type === 'method' || v.type === 'procedure')
                .map(([k, v]) => ({ label: v.name, description: `${v.file?.split('/').pop()}:${v.line}`, detail: v.signature || '' }));
            
            const selected = await vscode.window.showQuickPick(funcs, {
                placeHolder: 'Select a function to see what calls it'
            });
            
            if (selected) {
                const trace = traceSymbol(selected.label);
                let msg = `## ${selected.label}\n\n`;
                
                if (trace.callers.length > 0) {
                    msg += `### Called by (${trace.callers.length}):\n`;
                    for (const c of trace.callers) {
                        msg += `- ${c.name} (${c.file?.split('/').pop()}:${c.line})\n`;
                    }
                } else {
                    msg += `### No callers found (entry point?)\n`;
                }
                
                if (trace.callees.length > 0) {
                    msg += `\n### Calls (${trace.callees.length}):\n`;
                    for (const c of trace.callees) {
                        msg += `- ${c.name} (${c.file?.split('/').pop()}:${c.line})\n`;
                    }
                }
                
                // Show in a new document
                const doc = await vscode.workspace.openTextDocument({
                    content: msg,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        }),
        
        vscode.commands.registerCommand('astra.semanticSearch', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Semantic Search',
                placeHolder: 'e.g., "find code that validates wire transfers"'
            });
            
            if (!query) return;
            
            // Check if we have any files to search
            if (contextFiles.size === 0) {
                vscode.window.showWarningMessage('No files in context. Add files using right-click → "AstraCode: Add File to Context"');
                return;
            }
            
            // Check if we have an index built
            if (codeIndex.symbols.size === 0 && vectorIndex.chunks.length === 0) {
                const indexState = `Context files: ${contextFiles.size}, Symbols: ${codeIndex.symbols.size}`;
                log('Search - index not built:', indexState);
                const build = await vscode.window.showWarningMessage(
                    `Index not built. Build it now? (${contextFiles.size} files in context)`,
                    'Build Index', 'Search anyway'
                );
                if (build === 'Build Index') {
                    await vscode.commands.executeCommand('astra.rebuildIndex');
                }
            }
            
            // If no vector index, offer to build it
            if (vectorIndex.chunks.length === 0 && codeIndex.symbols.size > 0) {
                const build = await vscode.window.showWarningMessage(
                    'Vector index not built. Build it now for semantic search?',
                    'Build', 'Search without vectors'
                );
                if (build === 'Build') {
                    await vscode.commands.executeCommand('astra.rebuildIndex');
                }
            }
            
            log('Starting semantic search for:', query);
            
            // Perform hybrid search with progress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Searching...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Running hybrid search...' });
                
                try {
                    const results = await hybridSearch(query, { maxResults: 20 });
                    
                    log('Search complete, results:', results.length);
                    
                    if (results.length === 0) {
                        const indexState = `Context: ${contextFiles.size} files, Symbols: ${codeIndex.symbols.size}, Vectors: ${vectorIndex.chunks.length}`;
                        log('No results found. Index state:', indexState);
                        vscode.window.showInformationMessage(`No results found for "${query}". Try different keywords. (${indexState})`);
                        return;
                    }
                    
                    // Format results as markdown
                    let content = `# 🔍 Search Results for "${query}"\n\n`;
                    content += `Found **${results.length}** results using: `;
                    const methods = new Set();
                    results.forEach(r => r.sources.forEach(s => methods.add(s)));
                    content += Array.from(methods).join(', ') + '\n\n---\n\n';
                    
                    for (let i = 0; i < results.length; i++) {
                        const r = results[i];
                        const sources = Array.from(r.sources).map(s => {
                            if (s === 'symbol') return '📊';
                            if (s === 'grep') return '🔤';
                            if (s === 'vector') return '🧠';
                            if (s === 'text') return '📝';
                            return s;
                        }).join('');
                        
                        content += `### ${i + 1}. ${r.symbol || r.fileName}:${r.line} ${sources}\n`;
                        content += `**File:** \`${r.file}\`\n`;
                        content += `**Score:** ${(r.score * 100).toFixed(0)}%\n`;
                        if (r.preview) {
                            content += `\`\`\`\n${r.preview.trim()}\n\`\`\`\n`;
                        }
                        content += '\n';
                    }
                    
                    // Show results in a new document
                    const doc = await vscode.workspace.openTextDocument({
                        content,
                        language: 'markdown'
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                    
                } catch (error) {
                    log('Semantic search error:', error.message);
                    vscode.window.showErrorMessage(`Search failed: ${error.message}`);
                }
            });
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
            
            // Also show in chat
            chatWebviewView?.webview.postMessage({ 
                type: 'appendResponse', 
                text: `\n**🔧 Verbose Search Mode: ${status}**\n\n`
            });
        }),
        
        vscode.commands.registerCommand('astra.addSelectionToContext', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.selection && !editor.selection.isEmpty) {
                const selection = editor.document.getText(editor.selection);
                const fileName = editor.document.uri.path.split('/').pop();
                const language = detectLanguage(fileName);
                
                // Add as a virtual file
                const virtualPath = `selection:${fileName}:${Date.now()}`;
                contextFiles.set(virtualPath, {
                    uri: editor.document.uri,
                    content: selection,
                    language: language
                });
                
                contextTreeProvider.refresh();
                updateChatStatus();
                vscode.window.showInformationMessage('Selection added to AstraCode context');
            }
        })
    );
    
    log('AstraCode activated');
}

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
    
    // Clear any pending timeout
    if (updateChatStatus.indexTimeout) {
        clearTimeout(updateChatStatus.indexTimeout);
        updateChatStatus.indexTimeout = null;
    }
    
    // Clean up resources
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
    chatHistory = [];
    
    // Clear search indexes
    searchModule.clearSearchIndexes();
    
    log('AstraCode deactivated');
}

module.exports = { activate, deactivate };
