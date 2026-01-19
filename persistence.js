/**
 * AstraCode Persistence Module v5.1
 * 
 * Handles saving and restoring extension state across sessions.
 * Now includes session memory persistence and optional index persistence.
 */

const vscode = require('vscode');

// ============================================================
// STORAGE KEYS
// ============================================================

const STORAGE_KEYS = {
    CONTEXT_FILES: 'astra.contextFiles',
    CHAT_HISTORY: 'astra.chatHistory',
    CURRENT_MODE: 'astra.currentMode',
    INDEX_METADATA: 'astra.indexMetadata',
    USER_PREFERENCES: 'astra.userPreferences',
    LAST_SESSION: 'astra.lastSession',
    SESSION_MEMORY: 'astra.sessionMemory',
    SYMBOL_INDEX: 'astra.symbolIndex',
    FILE_SUMMARIES: 'astra.fileSummaries'
};

const DEFAULT_CONFIG = {
    autoSaveInterval: 5000,
    maxChatHistory: 100,
    maxFileContentSize: 100 * 1024,
    maxSessionTurns: 50,
    indexPersistenceEnabled: true
};

// ============================================================
// PERSISTENCE MANAGER CLASS
// ============================================================

class PersistenceManager {
    constructor(context, config = {}) {
        this.context = context;
        this.workspaceState = context.workspaceState;
        this.globalState = context.globalState;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.autoSaveTimer = null;
        this.isDirty = false;
        this.lastSaveTime = null;
        this.stateRefs = {
            contextFiles: null,
            chatHistory: null,
            currentMode: null,
            codeIndex: null,
            sessionMemory: null
        };
        this.log('PersistenceManager initialized');
    }

    setStateReferences(refs) {
        this.stateRefs = { ...this.stateRefs, ...refs };
        this.log('State references set', Object.keys(refs));
    }

    startAutoSave() {
        if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
        this.autoSaveTimer = setInterval(() => {
            if (this.isDirty) {
                this.saveAll().catch(err => this.log('Auto-save error:', err.message));
            }
        }, this.config.autoSaveInterval);
        this.log('Auto-save started');
    }

    stopAutoSave() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
    }

    markDirty() { this.isDirty = true; }

    async saveAll() {
        try {
            await Promise.all([
                this.saveContextFiles(),
                this.saveChatHistory(),
                this.saveCurrentMode(),
                this.saveSessionMemory(),
                this.saveSessionInfo()
            ]);
            this.isDirty = false;
            this.lastSaveTime = new Date();
            this.log('All state saved');
        } catch (error) {
            this.log('Error saving state:', error.message);
            throw error;
        }
    }

    async restoreAll() {
        try {
            return {
                contextFiles: await this.restoreContextFiles(),
                chatHistory: await this.restoreChatHistory(),
                currentMode: await this.restoreCurrentMode(),
                sessionMemory: await this.restoreSessionMemory(),
                lastSession: await this.getLastSession()
            };
        } catch (error) {
            this.log('Error restoring state:', error.message);
            return { contextFiles: new Map(), chatHistory: [], currentMode: 'auto', sessionMemory: null, lastSession: null };
        }
    }

    // Context Files
    async saveContextFiles() {
        if (!this.stateRefs.contextFiles) return;
        const serialized = [];
        for (const [path, file] of this.stateRefs.contextFiles) {
            const content = file.content.length > this.config.maxFileContentSize
                ? file.content.substring(0, this.config.maxFileContentSize) + '\n\n[... truncated ...]'
                : file.content;
            serialized.push({ path, uri: file.uri?.toString() || path, content, language: file.language, addedAt: file.addedAt || new Date().toISOString() });
        }
        await this.workspaceState.update(STORAGE_KEYS.CONTEXT_FILES, serialized);
    }

    async restoreContextFiles() {
        const serialized = this.workspaceState.get(STORAGE_KEYS.CONTEXT_FILES, []);
        const contextFiles = new Map();
        for (const file of serialized) {
            try {
                let content = file.content, uri = null;
                try {
                    uri = vscode.Uri.parse(file.uri);
                    const freshContent = await vscode.workspace.fs.readFile(uri);
                    content = Buffer.from(freshContent).toString('utf8');
                } catch (e) { /* use cached */ }
                contextFiles.set(file.path, { uri, content, language: file.language, addedAt: file.addedAt });
            } catch (error) { this.log('Error restoring file:', file.path); }
        }
        return contextFiles;
    }

    async saveContextFile(path, file) {
        const serialized = this.workspaceState.get(STORAGE_KEYS.CONTEXT_FILES, []);
        const filtered = serialized.filter(f => f.path !== path);
        filtered.push({
            path, uri: file.uri?.toString() || path,
            content: file.content.length > this.config.maxFileContentSize ? file.content.substring(0, this.config.maxFileContentSize) + '\n\n[... truncated ...]' : file.content,
            language: file.language, addedAt: new Date().toISOString()
        });
        await this.workspaceState.update(STORAGE_KEYS.CONTEXT_FILES, filtered);
    }

    async removeContextFile(path) {
        const serialized = this.workspaceState.get(STORAGE_KEYS.CONTEXT_FILES, []);
        await this.workspaceState.update(STORAGE_KEYS.CONTEXT_FILES, serialized.filter(f => f.path !== path));
    }

    async clearContextFiles() {
        await this.workspaceState.update(STORAGE_KEYS.CONTEXT_FILES, []);
    }

    // Chat History
    async saveChatHistory() {
        if (!this.stateRefs.chatHistory) return;
        const recentHistory = this.stateRefs.chatHistory.slice(-this.config.maxChatHistory);
        const serialized = recentHistory.map(msg => ({
            role: msg.role, content: msg.content,
            timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp
        }));
        await this.workspaceState.update(STORAGE_KEYS.CHAT_HISTORY, serialized);
    }

    async restoreChatHistory() {
        const serialized = this.workspaceState.get(STORAGE_KEYS.CHAT_HISTORY, []);
        return serialized.map(msg => ({ role: msg.role, content: msg.content, timestamp: new Date(msg.timestamp) }));
    }

    async appendChatMessage(message) {
        const serialized = this.workspaceState.get(STORAGE_KEYS.CHAT_HISTORY, []);
        serialized.push({
            role: message.role, content: message.content,
            timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : new Date().toISOString()
        });
        await this.workspaceState.update(STORAGE_KEYS.CHAT_HISTORY, serialized.slice(-this.config.maxChatHistory));
    }

    async clearChatHistory() {
        await this.workspaceState.update(STORAGE_KEYS.CHAT_HISTORY, []);
    }

    // Session Memory (NEW)
    async saveSessionMemory() {
        if (!this.stateRefs.sessionMemory || typeof this.stateRefs.sessionMemory.export !== 'function') return;
        const exported = this.stateRefs.sessionMemory.export();
        await this.workspaceState.update(STORAGE_KEYS.SESSION_MEMORY, exported);
        this.log('Saved session memory:', exported.turns?.length || 0, 'turns');
    }

    async restoreSessionMemory() {
        return this.workspaceState.get(STORAGE_KEYS.SESSION_MEMORY, null);
    }

    async clearSessionMemory() {
        await this.workspaceState.update(STORAGE_KEYS.SESSION_MEMORY, null);
    }

    // Mode & Preferences
    async saveCurrentMode() {
        await this.workspaceState.update(STORAGE_KEYS.CURRENT_MODE, this.stateRefs.currentMode || 'auto');
    }

    async restoreCurrentMode() {
        return this.workspaceState.get(STORAGE_KEYS.CURRENT_MODE, 'auto');
    }

    async saveUserPreferences(prefs) {
        await this.globalState.update(STORAGE_KEYS.USER_PREFERENCES, prefs);
    }

    async restoreUserPreferences() {
        return this.globalState.get(STORAGE_KEYS.USER_PREFERENCES, {});
    }

    // Session Info
    async saveSessionInfo() {
        await this.workspaceState.update(STORAGE_KEYS.LAST_SESSION, {
            timestamp: new Date().toISOString(),
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
            contextFileCount: this.stateRefs.contextFiles?.size || 0,
            chatMessageCount: this.stateRefs.chatHistory?.length || 0,
            sessionTurnCount: this.stateRefs.sessionMemory?.turns?.length || 0,
            mode: this.stateRefs.currentMode || 'auto'
        });
    }

    async getLastSession() {
        return this.workspaceState.get(STORAGE_KEYS.LAST_SESSION, null);
    }

    // Index Metadata
    async saveIndexMetadata(metadata) {
        await this.workspaceState.update(STORAGE_KEYS.INDEX_METADATA, {
            lastBuilt: metadata.lastBuilt || new Date().toISOString(),
            fileCount: metadata.fileCount || 0,
            symbolCount: metadata.symbolCount || 0,
            summaryCount: metadata.summaryCount || 0,
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
            version: metadata.version || '5.1.0'
        });
    }

    async getIndexMetadata() {
        return this.workspaceState.get(STORAGE_KEYS.INDEX_METADATA, null);
    }

    async isIndexStale() {
        const meta = await this.getIndexMetadata();
        if (!meta) return true;
        const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
        if (meta.workspaceFolder !== currentWorkspace) return true;
        const hoursSinceBuilt = (Date.now() - new Date(meta.lastBuilt).getTime()) / (1000 * 60 * 60);
        return hoursSinceBuilt > 24;
    }

    // Symbol Index Persistence
    async saveSymbolIndex(codeIndex) {
        if (!this.config.indexPersistenceEnabled || !codeIndex) return;
        try {
            const serialized = {
                version: '1.0.0', savedAt: new Date().toISOString(),
                symbols: Array.from(codeIndex.symbols?.entries() || []).slice(0, 5000),
                callGraph: Array.from(codeIndex.callGraph?.entries() || []).map(([k, v]) => [k, Array.from(v)]).slice(0, 2000),
                reverseCallGraph: Array.from(codeIndex.reverseCallGraph?.entries() || []).map(([k, v]) => [k, Array.from(v)]).slice(0, 2000)
            };
            await this.workspaceState.update(STORAGE_KEYS.SYMBOL_INDEX, serialized);
        } catch (error) { this.log('Error saving symbol index:', error.message); }
    }

    async restoreSymbolIndex() {
        if (!this.config.indexPersistenceEnabled) return null;
        return this.workspaceState.get(STORAGE_KEYS.SYMBOL_INDEX, null);
    }

    async saveFileSummaries(fileSummaries) {
        if (!this.config.indexPersistenceEnabled || !fileSummaries) return;
        const serialized = Array.from(fileSummaries.entries()).slice(0, 500);
        await this.workspaceState.update(STORAGE_KEYS.FILE_SUMMARIES, serialized);
    }

    async restoreFileSummaries() {
        if (!this.config.indexPersistenceEnabled) return new Map();
        return new Map(this.workspaceState.get(STORAGE_KEYS.FILE_SUMMARIES, []));
    }

    // ============================================================
    // CODE INDEX PERSISTENCE (symbols, callGraph, summaries)
    // ============================================================

    /**
     * Save the entire code index to workspace storage
     * This includes symbols, call graph, and summaries
     */
    async saveCodeIndex(codeIndex) {
        if (!this.config.indexPersistenceEnabled || !codeIndex) return;
        
        try {
            const startTime = Date.now();
            
            // Serialize symbols (limit to most important for storage efficiency)
            const symbolsArray = [];
            let count = 0;
            const MAX_SYMBOLS = 50000; // Limit for storage
            for (const [key, symbol] of codeIndex.symbols) {
                if (count >= MAX_SYMBOLS) break;
                symbolsArray.push([key, {
                    name: symbol.name,
                    type: symbol.type,
                    file: symbol.file,
                    line: symbol.line,
                    signature: symbol.signature,
                    params: symbol.params
                }]);
                count++;
            }
            
            // Serialize call graph
            const callGraphArray = [];
            for (const [func, calls] of codeIndex.callGraph) {
                callGraphArray.push([func, Array.from(calls)]);
            }
            
            // Serialize reverse call graph
            const reverseCallGraphArray = [];
            for (const [func, callers] of codeIndex.reverseCallGraph) {
                reverseCallGraphArray.push([func, Array.from(callers)]);
            }
            
            // Serialize summaries (these are expensive to regenerate!)
            const summariesArray = [];
            for (const [key, summary] of codeIndex.summaries) {
                summariesArray.push([key, summary]);
            }
            
            // Serialize file summaries
            const fileSummariesArray = [];
            for (const [path, summary] of codeIndex.fileSummaries) {
                fileSummariesArray.push([path, summary]);
            }
            
            // Create metadata for validation on restore
            const metadata = {
                version: '5.1.0',
                savedAt: new Date().toISOString(),
                symbolCount: symbolsArray.length,
                callGraphSize: callGraphArray.length,
                summaryCount: summariesArray.length,
                fileSummaryCount: fileSummariesArray.length,
                fileHash: this.computeFileHash()
            };
            
            // Save in chunks to avoid storage limits
            await this.workspaceState.update('astra.codeIndex.metadata', metadata);
            await this.workspaceState.update('astra.codeIndex.symbols', symbolsArray);
            await this.workspaceState.update('astra.codeIndex.callGraph', callGraphArray);
            await this.workspaceState.update('astra.codeIndex.reverseCallGraph', reverseCallGraphArray);
            await this.workspaceState.update('astra.codeIndex.summaries', summariesArray);
            await this.workspaceState.update('astra.codeIndex.fileSummaries', fileSummariesArray);
            
            const elapsed = Date.now() - startTime;
            this.log(`Code index saved in ${elapsed}ms: ${symbolsArray.length} symbols, ${summariesArray.length} summaries`);
            
        } catch (error) {
            this.log('Error saving code index:', error.message);
        }
    }

    /**
     * Restore the code index from workspace storage
     * Returns null if no valid index found or if files have changed
     */
    async restoreCodeIndex() {
        if (!this.config.indexPersistenceEnabled) return null;
        
        try {
            const startTime = Date.now();
            
            // Check metadata
            const metadata = this.workspaceState.get('astra.codeIndex.metadata', null);
            if (!metadata) {
                this.log('No saved code index found');
                return null;
            }
            
            // Validate file hash (if files changed, need to rebuild)
            const currentHash = this.computeFileHash();
            if (metadata.fileHash !== currentHash) {
                this.log('File hash mismatch - index needs rebuild');
                return null;
            }
            
            // Restore data
            const symbolsArray = this.workspaceState.get('astra.codeIndex.symbols', []);
            const callGraphArray = this.workspaceState.get('astra.codeIndex.callGraph', []);
            const reverseCallGraphArray = this.workspaceState.get('astra.codeIndex.reverseCallGraph', []);
            const summariesArray = this.workspaceState.get('astra.codeIndex.summaries', []);
            const fileSummariesArray = this.workspaceState.get('astra.codeIndex.fileSummaries', []);
            
            // Convert back to Maps
            const symbols = new Map(symbolsArray);
            const callGraph = new Map(callGraphArray.map(([k, v]) => [k, new Set(v)]));
            const reverseCallGraph = new Map(reverseCallGraphArray.map(([k, v]) => [k, new Set(v)]));
            const summaries = new Map(summariesArray);
            const fileSummaries = new Map(fileSummariesArray);
            
            const elapsed = Date.now() - startTime;
            this.log(`Code index restored in ${elapsed}ms: ${symbols.size} symbols, ${summaries.size} summaries`);
            
            return {
                symbols,
                callGraph,
                reverseCallGraph,
                summaries,
                fileSummaries,
                metadata
            };
            
        } catch (error) {
            this.log('Error restoring code index:', error.message);
            return null;
        }
    }

    /**
     * Compute a hash of context files for cache invalidation
     */
    computeFileHash() {
        if (!this.stateRefs.contextFiles) return '';
        const files = Array.from(this.stateRefs.contextFiles.keys()).sort();
        return files.join('|').substring(0, 500); // Simple hash based on file paths
    }

    /**
     * Clear the saved code index
     */
    async clearCodeIndex() {
        await this.workspaceState.update('astra.codeIndex.metadata', undefined);
        await this.workspaceState.update('astra.codeIndex.symbols', undefined);
        await this.workspaceState.update('astra.codeIndex.callGraph', undefined);
        await this.workspaceState.update('astra.codeIndex.reverseCallGraph', undefined);
        await this.workspaceState.update('astra.codeIndex.summaries', undefined);
        await this.workspaceState.update('astra.codeIndex.fileSummaries', undefined);
        this.log('Code index cache cleared');
    }

    // Utilities
    async clearAll() {
        await Promise.all(Object.values(STORAGE_KEYS).map(key => this.workspaceState.update(key, undefined)));
        await this.clearCodeIndex();
        this.log('Cleared all persisted state');
    }

    getStorageStats() {
        const contextFiles = this.workspaceState.get(STORAGE_KEYS.CONTEXT_FILES, []);
        const chatHistory = this.workspaceState.get(STORAGE_KEYS.CHAT_HISTORY, []);
        const sessionMemory = this.workspaceState.get(STORAGE_KEYS.SESSION_MEMORY, null);
        return {
            contextFileCount: contextFiles.length,
            chatMessageCount: chatHistory.length,
            sessionTurnCount: sessionMemory?.turns?.length || 0,
            lastSaveTime: this.lastSaveTime?.toISOString(),
            isDirty: this.isDirty
        };
    }

    async exportState() {
        return {
            version: '5.1.0', exportedAt: new Date().toISOString(),
            contextFiles: this.workspaceState.get(STORAGE_KEYS.CONTEXT_FILES, []),
            chatHistory: this.workspaceState.get(STORAGE_KEYS.CHAT_HISTORY, []),
            currentMode: this.workspaceState.get(STORAGE_KEYS.CURRENT_MODE, 'auto'),
            sessionMemory: this.workspaceState.get(STORAGE_KEYS.SESSION_MEMORY, null),
            indexMetadata: this.workspaceState.get(STORAGE_KEYS.INDEX_METADATA, null),
            userPreferences: this.globalState.get(STORAGE_KEYS.USER_PREFERENCES, {})
        };
    }

    async importState(state) {
        if (state.contextFiles) await this.workspaceState.update(STORAGE_KEYS.CONTEXT_FILES, state.contextFiles);
        if (state.chatHistory) await this.workspaceState.update(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);
        if (state.currentMode) await this.workspaceState.update(STORAGE_KEYS.CURRENT_MODE, state.currentMode);
        if (state.sessionMemory) await this.workspaceState.update(STORAGE_KEYS.SESSION_MEMORY, state.sessionMemory);
        if (state.userPreferences) await this.globalState.update(STORAGE_KEYS.USER_PREFERENCES, state.userPreferences);
        this.log('State imported');
    }

    log(...args) { console.log('[AstraCode Persistence]', ...args); }

    dispose() { this.stopAutoSave(); this.log('PersistenceManager disposed'); }
}

module.exports = { PersistenceManager, STORAGE_KEYS, DEFAULT_CONFIG };
