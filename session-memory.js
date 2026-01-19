/**
 * AstraCode Session Memory Module
 * 
 * Tracks conversation history within a session and allows users to:
 * - Reference previous responses by number (@1, @2, etc.)
 * - Use previous code blocks in new queries
 * - Compare responses
 * - Build on previous analysis
 * 
 * Usage:
 *   const { SessionMemory } = require('./session-memory');
 *   const memory = new SessionMemory();
 *   
 *   // Add a turn
 *   memory.addTurn(userMessage, assistantResponse);
 *   
 *   // Reference previous response
 *   const expanded = memory.expandReferences("compare @2 with @3");
 *   
 *   // Get code blocks from a response
 *   const code = memory.getCodeBlocks(2);
 *   
 *   // Export for persistence
 *   const state = memory.export();
 *   
 *   // Import from persistence
 *   memory.import(state);
 */

// ============================================================
// SESSION MEMORY CLASS
// ============================================================

class SessionMemory {
    constructor(options = {}) {
        this.maxTurns = options.maxTurns || 50;           // Maximum turns to keep
        this.maxContentSize = options.maxContentSize || 100000; // Max chars per response
        this.turns = [];                                   // Array of conversation turns
        this.codeBlocks = new Map();                       // Extracted code blocks by turn
        this.summaries = new Map();                        // Short summaries of each turn
        this.tags = new Map();                             // User-defined tags for turns
        this.bookmarks = new Set();                        // Bookmarked turn numbers
        this.lastAccessed = new Map();                     // Track which turns are referenced
        this.createdAt = new Date();
        this.log = options.log || console.log;
    }

    /**
     * Add a conversation turn
     * @param {string} userMessage - User's message
     * @param {string} assistantResponse - Assistant's response
     * @param {Object} metadata - Optional metadata (model, duration, etc.)
     * @returns {number} Turn number
     */
    addTurn(userMessage, assistantResponse, metadata = {}) {
        const turnNumber = this.turns.length + 1;
        
        // Truncate if too large
        const truncatedResponse = assistantResponse.length > this.maxContentSize
            ? assistantResponse.substring(0, this.maxContentSize) + '\n\n[... truncated ...]'
            : assistantResponse;
        
        const turn = {
            number: turnNumber,
            timestamp: new Date(),
            user: userMessage,
            assistant: truncatedResponse,
            metadata: {
                ...metadata,
                userLength: userMessage.length,
                assistantLength: assistantResponse.length,
                truncated: assistantResponse.length > this.maxContentSize
            }
        };
        
        this.turns.push(turn);
        
        // Extract and cache code blocks
        const codeBlocks = this.extractCodeBlocks(truncatedResponse);
        if (codeBlocks.length > 0) {
            this.codeBlocks.set(turnNumber, codeBlocks);
        }
        
        // Generate a short summary
        this.summaries.set(turnNumber, this.generateSummary(userMessage, truncatedResponse));
        
        // Trim old turns if needed
        this.trimOldTurns();
        
        this.log(`[SessionMemory] Added turn ${turnNumber}: "${userMessage.substring(0, 50)}..."`);
        
        return turnNumber;
    }

    /**
     * Get a specific turn
     * @param {number} turnNumber - Turn number (1-indexed)
     * @returns {Object|null} Turn object or null
     */
    getTurn(turnNumber) {
        const index = turnNumber - 1;
        if (index < 0 || index >= this.turns.length) {
            return null;
        }
        
        this.lastAccessed.set(turnNumber, new Date());
        return this.turns[index];
    }

    /**
     * Get the last N turns
     * @param {number} n - Number of turns to get
     * @returns {Array} Array of turns
     */
    getLastTurns(n = 5) {
        return this.turns.slice(-n);
    }

    /**
     * Get assistant response from a turn
     * @param {number} turnNumber - Turn number
     * @returns {string|null} Response or null
     */
    getResponse(turnNumber) {
        const turn = this.getTurn(turnNumber);
        return turn ? turn.assistant : null;
    }

    /**
     * Get user message from a turn
     * @param {number} turnNumber - Turn number
     * @returns {string|null} User message or null
     */
    getUserMessage(turnNumber) {
        const turn = this.getTurn(turnNumber);
        return turn ? turn.user : null;
    }

    /**
     * Extract code blocks from a response
     * @param {string} text - Response text
     * @returns {Array} Array of {language, code, startIndex, endIndex}
     */
    extractCodeBlocks(text) {
        const blocks = [];
        const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
        let match;
        
        while ((match = codeBlockRegex.exec(text)) !== null) {
            blocks.push({
                language: match[1] || 'text',
                code: match[2].trim(),
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }
        
        return blocks;
    }

    /**
     * Get code blocks from a specific turn
     * @param {number} turnNumber - Turn number
     * @param {number} blockIndex - Optional specific block index
     * @returns {Array|Object|null} Code blocks or specific block
     */
    getCodeBlocks(turnNumber, blockIndex = null) {
        const blocks = this.codeBlocks.get(turnNumber);
        if (!blocks) return null;
        
        if (blockIndex !== null) {
            return blocks[blockIndex] || null;
        }
        
        return blocks;
    }

    /**
     * Generate a short summary of a turn
     * @param {string} userMessage - User message
     * @param {string} response - Assistant response
     * @returns {string} Short summary
     */
    generateSummary(userMessage, response) {
        // Use first line of user message
        const userSummary = userMessage.split('\n')[0].substring(0, 50);
        
        // Count code blocks
        const codeBlocks = this.extractCodeBlocks(response);
        const codeInfo = codeBlocks.length > 0 
            ? ` [${codeBlocks.length} code block${codeBlocks.length > 1 ? 's' : ''}]`
            : '';
        
        // Check for common response types
        let responseType = '';
        if (response.includes('```')) responseType = '💻';
        else if (response.includes('##') || response.includes('**')) responseType = '📝';
        else if (response.length < 200) responseType = '💬';
        else responseType = '📄';
        
        return `${responseType} ${userSummary}...${codeInfo}`;
    }

    /**
     * Expand @N references in user message
     * @param {string} message - User message with references
     * @returns {Object} {expanded: string, references: Array}
     */
    /**
     * Check if message contains @N references
     * @param {string} message - Message to check
     * @returns {boolean} True if contains references
     */
    hasReferences(message) {
        if (!message || typeof message !== 'string') return false;
        // Pattern: @N or @N.code or @N.code[M] or @last
        const refPattern = /@(\d+|last)(?:\.(response|code|user|summary))?(?:\[(\d+)\])?/i;
        return refPattern.test(message);
    }

    /**
     * Expand @N references in a message
     * @param {string} message - Message with @N references
     * @returns {{expanded: string, references: Array}} Expanded message and reference info
     */
    expandReferences(message) {
        const references = [];
        
        // Pattern: @N or @N.code or @N.code[M] or @last
        const refPattern = /@(\d+|last)(?:\.(response|code|user|summary))?(?:\[(\d+)\])?/gi;
        
        let expanded = message.replace(refPattern, (match, turnRef, property, index) => {
            // Resolve turn number
            let turnNumber;
            if (turnRef.toLowerCase() === 'last') {
                turnNumber = this.turns.length;
            } else {
                turnNumber = parseInt(turnRef);
            }
            
            if (turnNumber < 1 || turnNumber > this.turns.length) {
                references.push({ ref: match, error: `Turn ${turnNumber} not found` });
                return match; // Keep original if not found
            }
            
            const turn = this.getTurn(turnNumber);
            references.push({ ref: match, turnNumber, property: property || 'response' });
            
            // Resolve property
            switch ((property || 'response').toLowerCase()) {
                case 'code':
                    const blocks = this.getCodeBlocks(turnNumber);
                    if (!blocks || blocks.length === 0) {
                        return `[No code blocks in turn ${turnNumber}]`;
                    }
                    if (index !== undefined) {
                        const blockNum = parseInt(index);
                        if (blocks[blockNum]) {
                            return blocks[blockNum].code;
                        }
                        return `[Code block ${blockNum} not found in turn ${turnNumber}]`;
                    }
                    // Return all code blocks
                    return blocks.map(b => b.code).join('\n\n');
                    
                case 'user':
                    return turn.user;
                    
                case 'summary':
                    return this.summaries.get(turnNumber) || turn.user.substring(0, 100);
                    
                case 'response':
                default:
                    return turn.assistant;
            }
        });
        
        return { expanded, references };
    }

    /**
     * Bookmark a turn for quick reference
     * @param {number} turnNumber - Turn to bookmark
     */
    bookmark(turnNumber) {
        if (turnNumber >= 1 && turnNumber <= this.turns.length) {
            this.bookmarks.add(turnNumber);
        }
    }

    /**
     * Remove a bookmark
     * @param {number} turnNumber - Turn to unbookmark
     */
    unbookmark(turnNumber) {
        this.bookmarks.delete(turnNumber);
    }

    /**
     * Get all bookmarked turns
     * @returns {number[]} Array of bookmarked turn numbers
     */
    getBookmarks() {
        return Array.from(this.bookmarks).sort((a, b) => a - b);
    }

    /**
     * Tag a turn with a name
     * @param {number} turnNumber - Turn to tag
     * @param {string} tag - Tag name
     */
    tagTurn(turnNumber, tag) {
        if (turnNumber < 1 || turnNumber > this.turns.length) return;
        
        if (!this.tags.has(tag)) {
            this.tags.set(tag, new Set());
        }
        this.tags.get(tag).add(turnNumber);
    }

    /**
     * Get turns with a specific tag
     * @param {string} tag - Tag name
     * @returns {number[]} Array of turn numbers
     */
    getTurnsByTag(tag) {
        const turns = this.tags.get(tag);
        return turns ? Array.from(turns).sort((a, b) => a - b) : [];
    }

    /**
     * Search through history
     * @param {string} query - Search query
     * @returns {Array} Matching turns with context
     */
    search(query) {
        const queryLower = query.toLowerCase();
        const results = [];
        
        for (const turn of this.turns) {
            const matches = [];
            
            if (turn.user.toLowerCase().includes(queryLower)) {
                matches.push('user message');
            }
            if (turn.assistant.toLowerCase().includes(queryLower)) {
                matches.push('response');
            }
            
            if (matches.length > 0) {
                results.push({
                    turnNumber: turn.number,
                    timestamp: turn.timestamp,
                    summary: this.summaries.get(turn.number),
                    matches: matches
                });
            }
        }
        
        return results;
    }

    /**
     * Format turn list for display
     * @param {Object} options - Formatting options
     * @returns {string} Formatted list
     */
    formatTurnList(options = {}) {
        const { maxTurns = 10, showTimestamp = false, showBookmarks = true } = options;
        const recentTurns = this.turns.slice(-maxTurns);
        
        const lines = recentTurns.map(turn => {
            const bookmark = showBookmarks && this.bookmarks.has(turn.number) ? '⭐ ' : '';
            const summary = this.summaries.get(turn.number) || turn.user.substring(0, 50) + '...';
            const timestamp = showTimestamp 
                ? ` (${turn.timestamp.toLocaleTimeString()})` 
                : '';
            return `${bookmark}@${turn.number}: ${summary}${timestamp}`;
        });
        
        return lines.join('\n');
    }

    /**
     * Get session statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        let totalCodeBlocks = 0;
        for (const blocks of this.codeBlocks.values()) {
            totalCodeBlocks += blocks.length;
        }
        
        return {
            totalTurns: this.turns.length,
            totalCharacters: this.turns.reduce((sum, t) => 
                sum + t.user.length + t.assistant.length, 0),
            totalCodeBlocks,
            bookmarks: this.bookmarks.size,
            tags: this.tags.size,
            createdAt: this.createdAt
        };
    }

    /**
     * Clear all session data
     */
    clear() {
        this.turns = [];
        this.codeBlocks.clear();
        this.summaries.clear();
        this.tags.clear();
        this.bookmarks.clear();
        this.lastAccessed.clear();
        this.createdAt = new Date();
    }

    /**
     * Trim old turns to stay within maxTurns limit
     */
    trimOldTurns() {
        if (this.turns.length <= this.maxTurns) return;
        
        const removeCount = this.turns.length - this.maxTurns;
        const removedTurns = this.turns.splice(0, removeCount);
        
        // Clean up associated data for removed turns
        for (const turn of removedTurns) {
            this.codeBlocks.delete(turn.number);
            this.summaries.delete(turn.number);
            this.bookmarks.delete(turn.number);
            this.lastAccessed.delete(turn.number);
            
            // Remove from all tags
            for (const tagSet of this.tags.values()) {
                tagSet.delete(turn.number);
            }
        }
        
        // Renumber remaining turns
        this.turns.forEach((turn, index) => {
            const oldNumber = turn.number;
            const newNumber = index + 1;
            if (oldNumber !== newNumber) {
                turn.number = newNumber;
                
                // Update associated data
                if (this.codeBlocks.has(oldNumber)) {
                    this.codeBlocks.set(newNumber, this.codeBlocks.get(oldNumber));
                    this.codeBlocks.delete(oldNumber);
                }
                if (this.summaries.has(oldNumber)) {
                    this.summaries.set(newNumber, this.summaries.get(oldNumber));
                    this.summaries.delete(oldNumber);
                }
                if (this.bookmarks.has(oldNumber)) {
                    this.bookmarks.delete(oldNumber);
                    this.bookmarks.add(newNumber);
                }
            }
        });
        
        this.log(`[SessionMemory] Trimmed ${removeCount} old turns`);
    }

    // ========================================
    // PERSISTENCE METHODS (NEW)
    // ========================================

    /**
     * Export session memory for persistence
     * @returns {Object} Serializable state object
     */
    export() {
        return {
            version: '1.0.0',
            exportedAt: new Date().toISOString(),
            createdAt: this.createdAt.toISOString(),
            maxTurns: this.maxTurns,
            maxContentSize: this.maxContentSize,
            turns: this.turns.map(turn => ({
                number: turn.number,
                timestamp: turn.timestamp.toISOString(),
                user: turn.user,
                assistant: turn.assistant,
                metadata: turn.metadata
            })),
            codeBlocks: Array.from(this.codeBlocks.entries()),
            summaries: Array.from(this.summaries.entries()),
            tags: Array.from(this.tags.entries()).map(([tag, turns]) => 
                [tag, Array.from(turns)]
            ),
            bookmarks: Array.from(this.bookmarks)
        };
    }

    /**
     * Import session memory from persisted state
     * @param {Object} state - Previously exported state
     * @returns {boolean} Success status
     */
    import(state) {
        try {
            if (!state || !state.version) {
                this.log('[SessionMemory] Invalid import state');
                return false;
            }

            // Clear current state
            this.clear();

            // Restore configuration
            if (state.maxTurns) this.maxTurns = state.maxTurns;
            if (state.maxContentSize) this.maxContentSize = state.maxContentSize;
            if (state.createdAt) this.createdAt = new Date(state.createdAt);

            // Restore turns
            if (state.turns && Array.isArray(state.turns)) {
                this.turns = state.turns.map(turn => ({
                    number: turn.number,
                    timestamp: new Date(turn.timestamp),
                    user: turn.user,
                    assistant: turn.assistant,
                    metadata: turn.metadata || {}
                }));
            }

            // Restore code blocks
            if (state.codeBlocks && Array.isArray(state.codeBlocks)) {
                this.codeBlocks = new Map(state.codeBlocks);
            }

            // Restore summaries
            if (state.summaries && Array.isArray(state.summaries)) {
                this.summaries = new Map(state.summaries);
            }

            // Restore tags
            if (state.tags && Array.isArray(state.tags)) {
                this.tags = new Map(state.tags.map(([tag, turns]) => 
                    [tag, new Set(turns)]
                ));
            }

            // Restore bookmarks
            if (state.bookmarks && Array.isArray(state.bookmarks)) {
                this.bookmarks = new Set(state.bookmarks);
            }

            this.log(`[SessionMemory] Imported ${this.turns.length} turns from ${state.exportedAt}`);
            return true;
        } catch (error) {
            this.log(`[SessionMemory] Import error: ${error.message}`);
            return false;
        }
    }

    /**
     * Check if there's any content worth persisting
     * @returns {boolean} True if there's meaningful content
     */
    hasContent() {
        return this.turns.length > 0;
    }
}

// ============================================================
// COMMAND PARSING
// ============================================================

/**
 * Parse session-related commands from user input
 * @param {string} message - User message
 * @returns {Object|null} Parsed command or null
 */
function parseSessionCommand(message) {
    const trimmed = message.trim();
    
    // /history [N] - show last N turns
    if (/^\/history(?:\s+(\d+))?$/.test(trimmed)) {
        const match = trimmed.match(/^\/history(?:\s+(\d+))?$/);
        return {
            type: 'history',
            count: match[1] ? parseInt(match[1]) : 10
        };
    }
    
    // /bookmark N - bookmark a turn
    if (/^\/bookmark\s+(\d+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/bookmark\s+(\d+)$/);
        return {
            type: 'bookmark',
            turnNumber: parseInt(match[1])
        };
    }
    
    // /bookmarks - list bookmarks
    if (trimmed === '/bookmarks') {
        return { type: 'list-bookmarks' };
    }
    
    // /search <query> - search history
    if (/^\/search\s+(.+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/search\s+(.+)$/);
        return {
            type: 'search',
            query: match[1]
        };
    }
    
    // /show N - show a specific turn
    if (/^\/show\s+(\d+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/show\s+(\d+)$/);
        return {
            type: 'show',
            turnNumber: parseInt(match[1])
        };
    }
    
    // /code N - show code from turn N
    if (/^\/code\s+(\d+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/code\s+(\d+)$/);
        return {
            type: 'code',
            turnNumber: parseInt(match[1])
        };
    }
    
    // /compare N M - compare two turns
    if (/^\/compare\s+(\d+)\s+(\d+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/compare\s+(\d+)\s+(\d+)$/);
        return {
            type: 'compare',
            turn1: parseInt(match[1]),
            turn2: parseInt(match[2])
        };
    }
    
    // /stats - show session stats
    if (trimmed === '/stats' || trimmed === '/session') {
        return { type: 'stats' };
    }
    
    // /clear-history - clear session
    if (trimmed === '/clear-history') {
        return { type: 'clear' };
    }
    
    // /tag N <tag> - tag a turn
    if (/^\/tag\s+(\d+)\s+(\w+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/tag\s+(\d+)\s+(\w+)$/);
        return {
            type: 'tag',
            turnNumber: parseInt(match[1]),
            tag: match[2]
        };
    }
    
    // /tagged <tag> - show turns with tag
    if (/^\/tagged\s+(\w+)$/.test(trimmed)) {
        const match = trimmed.match(/^\/tagged\s+(\w+)$/);
        return {
            type: 'tagged',
            tag: match[1]
        };
    }
    
    // /export-session - export for backup
    if (trimmed === '/export-session') {
        return { type: 'export' };
    }
    
    return null;
}

/**
 * Execute a session command
 * @param {SessionMemory} memory - Session memory instance
 * @param {Object} command - Parsed command
 * @returns {string} Response message
 */
function executeSessionCommand(memory, command) {
    switch (command.type) {
        case 'history': {
            const count = command.count || 10;
            if (memory.turns.length === 0) {
                return '📭 No conversation history yet.';
            }
            const list = memory.formatTurnList({ maxTurns: count, showTimestamp: true });
            return `📜 **Recent Conversation History** (last ${Math.min(count, memory.turns.length)} turns)\n\n${list}\n\n*Use @N to reference a turn, e.g., "explain @3 in more detail"*`;
        }
        
        case 'bookmark': {
            memory.bookmark(command.turnNumber);
            return `⭐ Bookmarked turn @${command.turnNumber}`;
        }
        
        case 'list-bookmarks': {
            const bookmarks = memory.getBookmarks();
            if (bookmarks.length === 0) {
                return '📭 No bookmarks yet. Use `/bookmark N` to bookmark a turn.';
            }
            const lines = bookmarks.map(n => {
                const summary = memory.summaries.get(n) || '...';
                return `⭐ @${n}: ${summary}`;
            });
            return `📑 **Bookmarked Turns**\n\n${lines.join('\n')}`;
        }
        
        case 'search': {
            const results = memory.search(command.query);
            if (results.length === 0) {
                return `🔍 No results found for "${command.query}"`;
            }
            const lines = results.slice(0, 10).map(r => 
                `@${r.turnNumber}: ${r.summary} (matched: ${r.matches.join(', ')})`
            );
            return `🔍 **Search Results for "${command.query}"**\n\n${lines.join('\n')}`;
        }
        
        case 'show': {
            const turn = memory.getTurn(command.turnNumber);
            if (!turn) {
                return `❌ Turn @${command.turnNumber} not found`;
            }
            return `📄 **Turn @${turn.number}** (${turn.timestamp.toLocaleString()})\n\n**You:** ${turn.user}\n\n**Assistant:**\n${turn.assistant}`;
        }
        
        case 'code': {
            const blocks = memory.getCodeBlocks(command.turnNumber);
            if (!blocks || blocks.length === 0) {
                return `❌ No code blocks in turn @${command.turnNumber}`;
            }
            const formatted = blocks.map((b, i) => 
                `**Block ${i + 1}** (${b.language}):\n\`\`\`${b.language}\n${b.code}\n\`\`\``
            ).join('\n\n');
            return `💻 **Code from Turn @${command.turnNumber}**\n\n${formatted}`;
        }
        
        case 'compare': {
            const turn1 = memory.getTurn(command.turn1);
            const turn2 = memory.getTurn(command.turn2);
            if (!turn1 || !turn2) {
                return `❌ One or both turns not found`;
            }
            return `⚖️ **Comparing Turn @${command.turn1} vs @${command.turn2}**\n\n` +
                `**Turn @${command.turn1}:**\nQuery: ${turn1.user.substring(0, 100)}...\nLength: ${turn1.assistant.length} chars\n\n` +
                `**Turn @${command.turn2}:**\nQuery: ${turn2.user.substring(0, 100)}...\nLength: ${turn2.assistant.length} chars\n\n` +
                `*To see full content, use /show N*`;
        }
        
        case 'stats': {
            const stats = memory.getStats();
            return `📊 **Session Statistics**\n\n` +
                `- Total turns: ${stats.totalTurns}\n` +
                `- Total characters: ${stats.totalCharacters.toLocaleString()}\n` +
                `- Code blocks: ${stats.totalCodeBlocks}\n` +
                `- Bookmarks: ${stats.bookmarks}\n` +
                `- Tags: ${stats.tags}\n` +
                `- Session started: ${stats.createdAt.toLocaleString()}`;
        }
        
        case 'clear': {
            memory.clear();
            return '🗑️ Session history cleared.';
        }
        
        case 'tag': {
            memory.tagTurn(command.turnNumber, command.tag);
            return `🏷️ Tagged turn @${command.turnNumber} as "${command.tag}"`;
        }
        
        case 'tagged': {
            const turns = memory.getTurnsByTag(command.tag);
            if (turns.length === 0) {
                return `🏷️ No turns tagged with "${command.tag}"`;
            }
            const lines = turns.map(n => {
                const summary = memory.summaries.get(n) || '...';
                return `@${n}: ${summary}`;
            });
            return `🏷️ **Turns tagged "${command.tag}"**\n\n${lines.join('\n')}`;
        }
        
        case 'export': {
            const state = memory.export();
            return `📤 **Session Export**\n\n\`\`\`json\n${JSON.stringify(state, null, 2).substring(0, 2000)}\n\`\`\`\n\n*Full export available via AstraCode: Export State command*`;
        }
        
        default:
            return `❌ Unknown command`;
    }
}

// ============================================================
// HELP TEXT
// ============================================================

const SESSION_MEMORY_HELP = `
## 📚 Session Memory Commands

### Reference Previous Responses
- \`@N\` - Reference response N (e.g., "explain @3 in more detail")
- \`@N.code\` - Get code blocks from response N
- \`@N.code[M]\` - Get specific code block M from response N
- \`@N.user\` - Get the user message from turn N
- \`@last\` - Reference the last response

### History Commands
- \`/history [N]\` - Show last N turns (default: 10)
- \`/show N\` - Show full content of turn N
- \`/code N\` - Show code blocks from turn N
- \`/search <query>\` - Search through history
- \`/compare N M\` - Compare two turns

### Bookmarks & Tags
- \`/bookmark N\` - Bookmark turn N
- \`/bookmarks\` - List all bookmarks
- \`/tag N <n>\` - Tag turn N with a name
- \`/tagged <n>\` - Show turns with a tag

### Session Management
- \`/stats\` - Show session statistics
- \`/clear-history\` - Clear session history
- \`/export-session\` - Export session data

### Examples
- "Can you improve the code from @2?"
- "Combine @3.code with @5.code"
- "What was different between @1 and @4?"
`;

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    SessionMemory,
    parseSessionCommand,
    executeSessionCommand,
    SESSION_MEMORY_HELP
};
