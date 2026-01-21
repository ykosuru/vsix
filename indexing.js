/**
 * AstraCode Indexing Module v6.0
 * 
 * Simplified indexing orchestration for unified CodebaseIndex.
 * 
 * This module provides:
 * - Progress tracking during index builds
 * - Orchestration with chat messages and UI updates
 * - Legacy compatibility wrappers
 * 
 * The actual indexing logic is now in CodebaseIndex.
 * File parsing is handled by index-module.js.
 * 
 * Usage:
 *   const { buildIndex, IndexingState } = require('./indexing-v6');
 *   const { CodebaseIndex } = require('./codebase-index');
 *   
 *   const index = new CodebaseIndex({ log });
 *   await buildIndex(index, contextFiles, { onProgress, onChatMessage, log });
 */

// ============================================================
// INDEXING STATE - Tracks progress across phases
// ============================================================

const IndexingState = {
    isIndexing: false,
    phase: 'idle',        // idle, parsing, callgraph, trigrams, inverted, complete
    progress: 0,          // 0-100
    filesIndexed: 0,
    symbolsFound: 0,
    functionsFound: 0,
    summariesFound: 0,
    errors: [],
    startTime: null,
    
    start() {
        this.isIndexing = true;
        this.phase = 'parsing';
        this.progress = 0;
        this.filesIndexed = 0;
        this.symbolsFound = 0;
        this.functionsFound = 0;
        this.summariesFound = 0;
        this.errors = [];
        this.startTime = Date.now();
    },
    
    setPhase(phase, progress) {
        this.phase = phase;
        this.progress = progress;
    },
    
    complete() {
        this.isIndexing = false;
        this.phase = 'complete';
        this.progress = 100;
    },
    
    error(err) {
        this.errors.push(err);
    },
    
    getStats() {
        return {
            phase: this.phase,
            progress: this.progress,
            files: this.filesIndexed,
            symbols: this.symbolsFound,
            functions: this.functionsFound,
            summaries: this.summariesFound,
            duration: this.startTime ? Date.now() - this.startTime : 0,
            errors: this.errors.length
        };
    }
};

// ============================================================
// MAIN BUILD FUNCTION
// ============================================================

/**
 * Build the codebase index with progress reporting
 * 
 * @param {CodebaseIndex} codebaseIndex - The unified index to build
 * @param {Map} contextFiles - Map of filePath -> { content, language }
 * @param {Object} options - Build options
 * @returns {Object} Build statistics
 */
async function buildIndex(codebaseIndex, contextFiles, options = {}) {
    const {
        log = console.log,
        onProgress = null,
        onChatMessage = null,
        verbose = false
    } = options;
    
    const totalFiles = contextFiles.size;
    
    log(`Building index for ${totalFiles} files...`);
    IndexingState.start();
    
    // Send initial message to chat
    if (verbose && onChatMessage) {
        onChatMessage(`\n**ðŸ”§ Building Code Index**\n`);
        onChatMessage(`- Files to process: ${totalFiles}\n\n`);
    }
    
    try {
        // Build the unified index
        const stats = await codebaseIndex.build(contextFiles, {
            onProgress: (pct, message, currentStats) => {
                IndexingState.setPhase(getPhaseFromProgress(pct), pct);
                // Use stats from CodebaseIndex if available, otherwise use IndexingState
                if (currentStats) {
                    IndexingState.filesIndexed = currentStats.files || 0;
                    IndexingState.symbolsFound = currentStats.symbols || 0;
                    IndexingState.functionsFound = currentStats.functions || 0;
                    IndexingState.summariesFound = currentStats.summaries || 0;
                }
                onProgress?.(pct, message, currentStats || IndexingState.getStats());
            },
            onChatMessage,
            verbose
        });
        
        // Update state with final stats
        IndexingState.filesIndexed = stats.files;
        IndexingState.symbolsFound = stats.symbols;
        IndexingState.functionsFound = stats.functions;
        IndexingState.summariesFound = stats.summaries;
        IndexingState.complete();
        
        // Send completion message
        if (verbose && onChatMessage) {
            onChatMessage(`\nâœ… **Indexing Complete**\n`);
            onChatMessage(`- ${stats.files} files parsed\n`);
            onChatMessage(`- ${stats.symbols} symbols found\n`);
            onChatMessage(`- ${stats.functions} functions indexed\n`);
            onChatMessage(`- ${stats.summaries} summaries extracted\n`);
            onChatMessage(`- ${stats.callGraphEdges} call graph edges\n`);
            onChatMessage(`- ${stats.invertedTerms} search terms\n`);
            onChatMessage(`- ${stats.trigramTerms} trigram terms\n`);
            onChatMessage(`- Built in ${stats.buildTime}ms\n\n`);
        }
        
        log(`Indexing complete:`, stats);
        
        return stats;
        
    } catch (error) {
        IndexingState.error({ phase: IndexingState.phase, error: error.message });
        log(`Indexing error: ${error.message}`);
        
        if (onChatMessage) {
            onChatMessage(`\n**âŒ Indexing Error:** ${error.message}\n`);
        }
        
        throw error;
    }
}

/**
 * Get phase name from progress percentage
 */
function getPhaseFromProgress(pct) {
    if (pct < 50) return 'parsing';
    if (pct < 60) return 'callgraph';
    if (pct < 75) return 'trigrams';
    if (pct < 100) return 'inverted';
    return 'complete';
}

// ============================================================
// INCREMENTAL UPDATES (for file add/remove)
// ============================================================

/**
 * Add a single file to the index
 * Note: This requires rebuilding search indexes for full consistency
 */
async function addFileToIndex(codebaseIndex, filePath, fileData, options = {}) {
    const { log = console.log, rebuildSearchIndexes = true } = options;
    
    log(`Adding file to index: ${filePath}`);
    
    // For now, just rebuild the entire index
    // A more sophisticated implementation could do incremental updates
    if (rebuildSearchIndexes) {
        const contextFiles = new Map(codebaseIndex.files);
        contextFiles.set(filePath, fileData);
        await codebaseIndex.build(contextFiles, options);
    }
}

/**
 * Remove a file from the index
 */
async function removeFileFromIndex(codebaseIndex, filePath, options = {}) {
    const { log = console.log, rebuildSearchIndexes = true } = options;
    
    log(`Removing file from index: ${filePath}`);
    
    if (rebuildSearchIndexes) {
        const contextFiles = new Map(codebaseIndex.files);
        contextFiles.delete(filePath);
        await codebaseIndex.build(contextFiles, options);
    }
}

// ============================================================
// LEGACY COMPATIBILITY
// ============================================================

/**
 * Legacy wrapper for buildAllIndexes
 * Maps old API to new CodebaseIndex
 */
async function buildAllIndexes(contextFiles, codeIndex, options = {}) {
    const { CodebaseIndex } = require('./codebase-index');
    
    // Create a new CodebaseIndex if we're given the old codeIndex structure
    const codebaseIndex = new CodebaseIndex({
        log: options.log || console.log,
        enableTrigrams: options.buildTrigrams !== false,
        enableInvertedIndex: options.buildInverted !== false,
        enableCallGraph: true
    });
    
    const stats = await buildIndex(codebaseIndex, contextFiles, options);
    
    // Copy data back to old codeIndex structure for compatibility
    if (codeIndex) {
        codeIndex.files = codebaseIndex.files;
        codeIndex.symbols = codebaseIndex.symbols;
        codeIndex.variables = codebaseIndex.variables;
        codeIndex.callGraph = codebaseIndex.callGraph;
        codeIndex.reverseCallGraph = codebaseIndex.reverseCallGraph;
        codeIndex.dependencies = codebaseIndex.dependencies;
        
        // Copy summaries from symbols
        if (!codeIndex.summaries) codeIndex.summaries = new Map();
        for (const [key, symbol] of codebaseIndex.symbols) {
            if (symbol.summary) {
                codeIndex.summaries.set(key, {
                    name: symbol.name,
                    file: symbol.file,
                    line: symbol.line,
                    type: symbol.type,
                    summary: symbol.summary
                });
            }
        }
        
        codeIndex.lastUpdated = new Date();
    }
    
    // Return stats in old format
    return {
        files: stats.files,
        symbols: stats.symbols,
        functions: stats.functions,
        summaries: stats.summaries,
        callGraphEdges: stats.callGraphEdges,
        variables: stats.variables,
        trigrams: stats.trigramTerms,
        invertedTerms: stats.invertedTerms,
        duration: stats.buildTime,
        errors: IndexingState.errors.length,
        // Include the new codebaseIndex for migration
        _codebaseIndex: codebaseIndex
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // New API
    buildIndex,
    addFileToIndex,
    removeFileFromIndex,
    IndexingState,
    
    // Legacy compatibility
    buildAllIndexes
};
