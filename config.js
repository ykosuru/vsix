/**
 * AstraCode Configuration
 * Centralized configuration management for LLM and agent settings
 */

const vscode = require('vscode');

// ============================================================
// LLM CONFIGURATION
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
        return config.get('llm.defaultModel') || 'claude-sonnet-4-5';
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
            'gpt-5.2-codex': 'GPT 5.2 Codex',
            'gpt-5-mini': 'GPT-5 Mini',
            'gpt-5o-mini': 'GPT-5o Mini',
            'gpt-5o': 'GPT-5o',
            'gpt-4o-mini': 'GPT-4o Mini',
            'gpt-4o': 'GPT-4o',
            'gpt-4-turbo': 'GPT-4 Turbo',
            'gpt-4': 'GPT-4',
            'gpt-3.5-turbo': 'GPT-3.5',
            'claude-sonnet-4-5': 'Claude Sonnet 4.5',
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
        if (modelLower.includes('claude-sonnet-4-5') || modelLower.includes('sonnet 4.5') || modelLower.includes('sonnet-4.5')) return 'Claude Sonnet 4.5';
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
            // Claude Sonnet 4.5 (highest priority)
            m => (m.family?.toLowerCase().includes('claude-sonnet-4-5') ||
                  m.name?.toLowerCase().includes('claude-sonnet-4-5') ||
                  m.id?.toLowerCase().includes('claude-sonnet-4-5') ||
                  m.name?.toLowerCase().includes('sonnet 4.5') ||
                  m.id?.toLowerCase().includes('sonnet-4.5')),
            // Claude Sonnet 4
            m => (m.family?.toLowerCase().includes('claude-sonnet-4') ||
                  m.name?.toLowerCase().includes('claude-sonnet-4') ||
                  m.id?.toLowerCase().includes('claude-sonnet-4')),
            // Claude 3.5 Sonnet
            m => (m.family?.toLowerCase().includes('claude-3-5-sonnet') ||
                  m.name?.toLowerCase().includes('claude-3-5-sonnet') ||
                  m.name?.toLowerCase().includes('claude 3.5')),
            // Any Claude model
            m => (m.family?.toLowerCase().includes('claude') ||
                  m.name?.toLowerCase().includes('claude')),
            // GPT 5.2 Codex (first fallback after Claude)
            m => (m.family?.toLowerCase().includes('gpt-5.2-codex') ||
                  m.name?.toLowerCase().includes('gpt-5.2-codex') ||
                  m.id?.toLowerCase().includes('gpt-5.2-codex') ||
                  m.name?.toLowerCase().includes('codex')),
            // GPT-5-mini (second fallback)
            m => (m.family?.toLowerCase().includes('gpt-5-mini') ||
                  m.name?.toLowerCase().includes('gpt-5-mini') ||
                  m.id?.toLowerCase().includes('gpt-5-mini')),
            // GPT-5o-mini
            m => (m.family?.toLowerCase().includes('gpt-5o-mini') ||
                  m.name?.toLowerCase().includes('gpt-5o-mini')),
            // GPT-4o (fallback)
            m => (m.family?.toLowerCase().includes('gpt-4o') ||
                  m.name?.toLowerCase().includes('gpt-4o')),
            // GPT-4
            m => (m.family?.toLowerCase().includes('gpt-4') ||
                  m.name?.toLowerCase().includes('gpt-4')),
            // Any model (last resort)
            () => true
        ];
    }
};

// ============================================================
// AGENT CONFIGURATION
// ============================================================

const AGENT_CONFIG = {
    enableJudge: true,              // Enable judge LLM to validate answers
    verboseSearch: true,            // Log detailed search hits for debugging
    // Code extraction settings (configurable)
    maxSymbolsInContext: 30,        // Max symbols to include in search context
    codeSnippetLines: 25,           // Lines of code per symbol snippet
    maxChunks: 8,                   // Max chunks for analysis
    maxBatchSize: 3,                // Batch size for hierarchical merge
    maxCombinedSize: 15000,         // Trigger hierarchical merge above this size
    maxAnalysisLength: 10000        // Max length for chunk analysis
};

// ============================================================
// SUMMARY CONFIGURATION
// ============================================================

const SUMMARY_CONFIG = {
    ENABLE_AUTO_SUMMARY: true,       // Default, overridden by settings
    SUMMARY_BATCH_SIZE: 10,          // Functions per LLM batch call
    MAX_FUNCTION_SIZE: 5000,         // Max chars to send for summarization
    MIN_FUNCTION_SIZE: 50,           // Skip tiny functions
    CONTEXT_WINDOW_LIMIT: 18000,     // Max chars for context
    CHUNK_SIZE_FOR_QUERY: 10000,     // Chunk size for detailed queries
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

// ============================================================
// VECTOR INDEX CONFIGURATION
// ============================================================

const VECTOR_CONFIG = {
    CHUNK_SIZE: 500,             // Target chars per chunk
    CHUNK_OVERLAP: 50,           // Overlap between chunks
    MIN_CHUNK_SIZE: 50,          // Minimum chunk size to embed
    MAX_CHUNKS_PER_FILE: 100,    // Limit chunks per file
    TOP_K_RESULTS: 10,           // Default number of results
    EMBEDDING_BATCH_SIZE: 20,    // Chunks to embed per batch
    SIMILARITY_THRESHOLD: 0.3    // Minimum similarity for results
};

// ============================================================
// TRIGRAM CONFIGURATION
// ============================================================

const TRIGRAM_CONFIG = {
    MIN_QUERY_LENGTH: 3,         // Minimum query length for trigram search
    MAX_RESULTS: 100,            // Maximum results to return
    MAX_FILE_SIZE: 500000,       // Skip files larger than this
    CASE_SENSITIVE: false,       // Case-insensitive by default
    MAX_POSITIONS_PER_FILE: 1000 // Limit positions stored per file per trigram
};

// ============================================================
// INDEXING CONFIGURATION
// ============================================================

const INDEX_CONFIG = {
    BATCH_SIZE: 50,                      // Files per batch
    BATCH_DELAY: 10,                     // ms delay between batches (yield to UI)
    MAX_FILES_FOR_FULL_INDEX: 1000,      // Above this, use lightweight indexing
    MAX_SYMBOLS_PER_FILE: 500,           // Limit symbols per file in lightweight mode
    MAX_VARS_PER_FILE: 100,              // Limit variables per file in lightweight mode
    SEARCH_RESULT_LIMIT: 100             // Max search results
};

module.exports = {
    LLMConfig,
    AGENT_CONFIG,
    SUMMARY_CONFIG,
    getSummaryConfig,
    VECTOR_CONFIG,
    TRIGRAM_CONFIG,
    INDEX_CONFIG
};
