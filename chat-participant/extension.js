const vscode = require('vscode');
const path = require('path');
const { GrepIndex } = require('./grep-search');
const {
    DESCRIBE_SYSTEM_PROMPT,
    getDescribeUserPrompt,
    TRANSLATE_SYSTEM_PROMPT,
    getTranslateUserPrompt,
    REQUIREMENTS_SYSTEM_PROMPT,
    getRequirementsUserPrompt,
    DEEPWIKI_SYSTEM_PROMPT,
    getDeepWikiUserPrompt,
    GENERAL_SYSTEM_PROMPT,
    getGeneralUserPrompt,
    getDomainPrompt,
    hasDomainPrompt,
    listDomainPrompts,
    HELP_TEXT
} = require('./prompts');

const PARTICIPANT_ID = 'astracode.chat';

// Global grep index - persists across queries
let grepIndex = null;
let indexedWorkspace = null;
let lastSearchResults = null;  // Store last search results for chaining
let lastSearchTerm = null;     // Store last search term

// History tracking - last 25 Q&A pairs
const MAX_HISTORY = 25;
let queryHistory = [];  // { id, timestamp, command, query, summary, files }

function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AstraCode');
    outputChannel.appendLine('AstraCode Copilot participant activated');

    // Register the chat participant
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token) => {
        const query = request.prompt;
        outputChannel.appendLine(`\n=== New Query: ${query} ===`);
        outputChannel.appendLine(`Command: ${request.command || 'none'}`);
        
        // Handle /help command
        if (request.command === 'help') {
            return showHelp(response);
        }
        
        // Handle /history command
        if (request.command === 'history') {
            return showHistory(response, query);
        }
        
        // Handle /use command - reuse results from history
        if (request.command === 'use') {
            return handleUseCommand(query, response, outputChannel);
        }
        
        // Handle /clear command
        if (request.command === 'clear') {
            grepIndex = null;
            indexedWorkspace = null;
            outputChannel.appendLine('Index cleared');
            response.markdown('🗑️ **Index cleared.** Next query will rebuild fresh from workspace files.');
            return;
        }
        
        // Handle /rebuild command
        if (request.command === 'rebuild') {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                response.markdown('❌ No workspace folder open. Please open a folder first.');
                return;
            }
            
            grepIndex = null;
            indexedWorkspace = null;
            outputChannel.appendLine('Forcing index rebuild...');
            response.progress('Rebuilding index from scratch...');
            
            await buildIndex(workspaceRoot, outputChannel);
            indexedWorkspace = workspaceRoot;
            
            const stats = grepIndex.getStats();
            response.markdown(`✅ **Index rebuilt successfully!**\n\n`);
            response.markdown(`- **Files indexed:** ${stats.files}\n`);
            response.markdown(`- **Total lines:** ${stats.totalLines.toLocaleString()}\n`);
            response.markdown(`- **Unique functions:** ${stats.uniqueFunctions.toLocaleString()}\n`);
            response.markdown(`- **Call sites tracked:** ${stats.indexedCalls.toLocaleString()}\n`);
            response.markdown(`- **Build time:** ${stats.buildTime}ms\n`);
            return;
        }
        
        // Handle /stats command
        if (request.command === 'stats') {
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
            return;
        }
        
        // Handle /generated command - list generated files
        if (request.command === 'generated') {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                response.markdown('❌ No workspace folder open.');
                return;
            }
            
            const files = await getGeneratedFiles(workspaceRoot);
            if (files.length === 0) {
                response.markdown('📂 **No generated files found.**\n\nRun `/describe`, `/translate`, `/deepwiki` etc. to generate documentation.');
                return;
            }
            
            response.markdown(`# 📂 Generated Files (${files.length})\n\n`);
            response.markdown(`| File | Actions |\n`);
            response.markdown(`|------|--------|\n`);
            for (const file of files.sort((a, b) => b.name.localeCompare(a.name))) {
                response.markdown(`| \`${file.name}\` | [Open](${file.uri}) |\n`);
            }
            response.markdown(`\n**Commands:**\n`);
            response.markdown(`- \`/clean\` — Delete all generated files\n`);
            response.markdown(`- \`/clean FEDIN\` — Delete files containing "FEDIN"\n`);
            return;
        }
        
        // Handle /clean command - delete generated files
        if (request.command === 'clean') {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                response.markdown('❌ No workspace folder open.');
                return;
            }
            
            const pattern = query.trim() || '*';
            const files = await getGeneratedFiles(workspaceRoot);
            
            if (files.length === 0) {
                response.markdown('📂 **No generated files to clean.**');
                return;
            }
            
            // Show what will be deleted and ask for confirmation
            const toDelete = pattern === '*' 
                ? files 
                : files.filter(f => f.name.toLowerCase().includes(pattern.toLowerCase()));
            
            if (toDelete.length === 0) {
                response.markdown(`❌ No files matching "${pattern}" found.`);
                return;
            }
            
            const deleted = await deleteGeneratedFiles(workspaceRoot, pattern);
            response.markdown(`🗑️ **Deleted ${deleted} generated file(s)**\n\n`);
            if (pattern !== '*') {
                response.markdown(`Pattern: \`${pattern}\`\n`);
            }
            response.markdown(`\n💡 *Use \`/generated\` to see remaining files*`);
            return;
        }

        // All other commands need a workspace
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            response.markdown('❌ No workspace folder open. Please open a folder first.');
            return;
        }

        // Build index if needed
        if (!grepIndex || indexedWorkspace !== workspaceRoot) {
            response.progress('Building code index...');
            await buildIndex(workspaceRoot, outputChannel);
            indexedWorkspace = workspaceRoot;
        }

        try {
            // Check for command chaining (e.g., "/find FEDIN then /translate then /fediso")
            const chainMatch = query.match(/^(.+?)\s+then\s+\/(\w+)(.*)$/i);
            if (chainMatch) {
                return await handleChainedCommands(request.command, query, response, outputChannel, workspaceRoot, token);
            }
            
            // Route to command handlers
            switch (request.command) {
                case 'find':
                    return await handleFindCommand(query, response, outputChannel, workspaceRoot, token);
                
                case 'describe':
                    return await handleDescribeCommand(query, response, outputChannel, workspaceRoot, token);
                
                case 'translate':
                    return await handleTranslateCommand(query, response, outputChannel, workspaceRoot, token);
                
                case 'deepwiki':
                    return await handleDeepWikiCommand(query, response, outputChannel, workspaceRoot, token);
                
                case 'fediso':
                    return await handleDomainCommand('fediso', query, response, outputChannel, workspaceRoot, token);
                
                case 'domain':
                    return await handleDomainCommand(query, '', response, outputChannel, workspaceRoot, token);
                
                case 'domains':
                    return showDomains(response);
                
                case 'requirements':
                case 'extract':
                    return await handleRequirementsCommand(query, response, outputChannel, workspaceRoot, token);
                
                default:
                    // Default: general query
                    return await handleGeneralQuery(query, response, outputChannel, workspaceRoot, token);
            }
        } catch (error) {
            outputChannel.appendLine(`Error: ${error.stack || error}`);
            response.markdown(`❌ Error: ${error.message}`);
        }
    });

    participant.iconPath = new vscode.ThemeIcon('search');
    context.subscriptions.push(participant, outputChannel);
}

// ============================================================
// HELP
// ============================================================

function showHelp(response) {
    response.markdown(HELP_TEXT);
}

/**
 * Show query history
 */
function showHistory(response, query) {
    const arg = query.trim();
    
    // Check if user wants to reference a specific history item
    const numMatch = arg.match(/^#?(\d+)$/);
    if (numMatch) {
        const id = parseInt(numMatch[1]);
        const item = queryHistory.find(h => h.id === id);
        if (item) {
            response.markdown(`## 📜 History #${item.id}\n\n`);
            response.markdown(`**Time:** ${item.timestamp.toLocaleString()}\n\n`);
            response.markdown(`**Command:** \`/${item.command || 'query'}\`\n\n`);
            response.markdown(`**Query:** ${item.query}\n\n`);
            response.markdown(`**Summary:**\n${item.summary}\n\n`);
            if (item.files && item.files.length > 0) {
                response.markdown(`**Files:**\n`);
                for (const file of item.files) {
                    response.markdown(`- \`${file}\`\n`);
                }
            }
            response.markdown(`\n💡 *Use \`@astra /use #${item.id}\` to reuse these results*`);
        } else {
            response.markdown(`❌ History item #${id} not found. Use \`@astra /history\` to see available items.`);
        }
        return;
    }
    
    // Show full history
    if (queryHistory.length === 0) {
        response.markdown('📜 **No history yet.** Run some queries first!');
        return;
    }
    
    response.markdown(`# 📜 Query History (Last ${queryHistory.length})\n\n`);
    response.markdown(`| # | Time | Command | Query | Files |\n`);
    response.markdown(`|---|------|---------|-------|-------|\n`);
    
    // Show newest first
    const reversed = [...queryHistory].reverse();
    for (const item of reversed) {
        const time = item.timestamp.toLocaleTimeString();
        const cmd = item.command ? `/${item.command}` : 'query';
        const queryPreview = item.query.length > 30 ? item.query.slice(0, 30) + '...' : item.query;
        const fileCount = item.files ? item.files.length : 0;
        response.markdown(`| #${item.id} | ${time} | \`${cmd}\` | ${queryPreview} | ${fileCount} |\n`);
    }
    
    response.markdown(`\n**Usage:**\n`);
    response.markdown(`- \`@astra /history #5\` - View details of history item #5\n`);
    response.markdown(`- \`@astra /use #5\` - Reuse results from history item #5\n`);
}

/**
 * Add entry to history with cached results for later reuse
 */
function addToHistory(command, query, summary, files, cachedResults = null) {
    const id = queryHistory.length > 0 ? queryHistory[queryHistory.length - 1].id + 1 : 1;
    
    queryHistory.push({
        id,
        timestamp: new Date(),
        command: command || null,
        query: query || '',
        summary: summary || '',
        files: files || [],
        cachedResults: cachedResults || lastSearchResults || []  // Store results for #N reference
    });
    
    // Keep only last MAX_HISTORY items
    if (queryHistory.length > MAX_HISTORY) {
        queryHistory.shift();
    }
    
    return id;
}

/**
 * Handle /use command - reuse results from history
 */
function handleUseCommand(query, response, outputChannel) {
    const numMatch = query.trim().match(/^#?(\d+)$/);
    if (!numMatch) {
        response.markdown('**Usage:** `@astra /use #5`\n\nReuse results from a history item for further commands.\n\n**Example:**\n```\n@astra /use #5\n@astra /translate\n```');
        return;
    }
    
    const id = parseInt(numMatch[1]);
    const item = queryHistory.find(h => h.id === id);
    
    if (!item) {
        response.markdown(`❌ History item #${id} not found. Use \`@astra /history\` to see available items.`);
        return;
    }
    
    if (!item.cachedResults || item.cachedResults.length === 0) {
        response.markdown(`⚠️ History item #${id} has no saved results to reuse.`);
        return;
    }
    
    // Set the last results to the history item's results
    lastSearchResults = item.cachedResults;
    lastSearchTerm = item.query;
    
    outputChannel.appendLine(`/use: Loaded ${item.results.length} results from history #${id}`);
    
    response.markdown(`✅ **Loaded history #${id}**\n\n`);
    response.markdown(`- **Query:** ${item.query}\n`);
    response.markdown(`- **Results:** ${item.results.length} code matches\n`);
    response.markdown(`- **Files:** ${item.files?.length || 0}\n\n`);
    response.markdown(`Now you can run:\n`);
    response.markdown(`- \`@astra /describe\` - Describe this code\n`);
    response.markdown(`- \`@astra /translate\` - Translate to Java\n`);
    response.markdown(`- \`@astra /requirements\` - Extract requirements\n`);
    response.markdown(`- \`@astra /fediso\` - Apply Fed ISO 20022 uplift\n`);
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

/**
 * /find - Search for code by keyword
 */
async function handleFindCommand(query, response, outputChannel, workspaceRoot, token) {
    const searchTerm = query.trim();
    if (!searchTerm) {
        response.markdown('**Usage:** `@astra /find <term>`\n\n**Examples:**\n- `@astra /find FEDIN`\n- `@astra /find wire transfer`\n- `@astra /find validate_payment`');
        return;
    }
    
    response.progress(`Searching for: ${searchTerm}...`);
    outputChannel.appendLine(`/find: ${searchTerm}`);
    
    // Search using multiple strategies
    const keywords = searchTerm.split(/\s+/).filter(w => w.length > 2);
    let results = [];
    
    for (const keyword of keywords) {
        const literalResults = grepIndex.searchLiteral(keyword, { 
            caseSensitive: false, 
            maxResults: 30 
        });
        results.push(...literalResults.results);
    }
    
    // Dedupe
    const seen = new Set();
    results = results.filter(r => {
        const key = `${r.file}:${r.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 50);
    
    // Save for chaining
    lastSearchResults = results;
    lastSearchTerm = searchTerm;
    
    // Get unique files for history
    const uniqueFiles = [...new Set(results.map(r => r.file))];
    
    // Add to history with cached results
    const historyId = addToHistory('find', searchTerm, `Found ${results.length} matches`, uniqueFiles, results);
    
    if (results.length === 0) {
        response.markdown(`No matches found for: \`${searchTerm}\`\n\nTry:\n- Different spelling\n- Partial term\n- \`@astra /rebuild\` to refresh index`);
        return;
    }
    
    // Format results
    response.markdown(`## 🔍 Found ${results.length} matches for \`${searchTerm}\` *(History #${historyId})*\n\n`);
    response.markdown(`💡 *Tip: Use \`/describe #${historyId}\`, \`/translate #${historyId}\`, or \`/requirements #${historyId}\`*\n\n`);
    
    const byFile = groupByFile(results);
    for (const [file, fileResults] of byFile) {
        const relativePath = path.relative(workspaceRoot, file);
        const ext = path.extname(file).slice(1) || 'txt';
        response.markdown(`### 📄 ${relativePath}\n\n`);
        
        for (const result of fileResults.slice(0, 3)) {
            const snippet = formatSnippet(result);
            response.markdown(`**Line ${result.line}:**\n\`\`\`${ext}\n${snippet}\n\`\`\`\n\n`);
        }
    }
}

/**
 * Unified input parsing for all commands
 * Syntax:
 *   <topic>           → Fresh search
 *   #N                → Use history item N
 *   #file a.tal, b.cbl → Use specific files
 * 
 * Returns: { type: 'search' | 'history' | 'files' | 'empty', value: string | number | string[] }
 */
function parseCommandInput(query) {
    const trimmed = query.trim();
    
    if (!trimmed) {
        return { type: 'empty', value: null };
    }
    
    // #N - history reference (e.g., #5, #12)
    const historyMatch = trimmed.match(/^#(\d+)$/);
    if (historyMatch) {
        return { type: 'history', value: parseInt(historyMatch[1]) };
    }
    
    // #file or #files - specific files
    const filesMatch = trimmed.match(/^#files?\s+(.+)$/i);
    if (filesMatch) {
        const fileNames = filesMatch[1].split(/[,\s]+/).filter(f => f.length > 0);
        return { type: 'files', value: fileNames };
    }
    
    // Legacy support: files: syntax
    const legacyFilesMatch = trimmed.match(/^files?:\s*(.+)$/i);
    if (legacyFilesMatch) {
        const fileNames = legacyFilesMatch[1].split(/[,\s]+/).filter(f => f.length > 0);
        return { type: 'files', value: fileNames };
    }
    
    // Default: fresh search
    return { type: 'search', value: trimmed };
}

/**
 * Get results from history item
 * Returns { results, searchTerm, error } 
 */
function getHistoryResults(historyId) {
    const historyItem = queryHistory.find(h => h.id === historyId);
    
    if (!historyItem) {
        return { results: null, searchTerm: null, error: `History item #${historyId} not found. Use \`/history\` to see available items.` };
    }
    
    if (!historyItem.cachedResults || historyItem.cachedResults.length === 0) {
        return { results: null, searchTerm: null, error: `History item #${historyId} has no cached results. Try a fresh search.` };
    }
    
    return { results: historyItem.cachedResults, searchTerm: historyItem.query, error: null };
}

/**
 * /describe - Describe functionality of code
 * Syntax: /describe <topic> | /describe #N | /describe #file a.tal, b.cbl
 */
async function handleDescribeCommand(query, response, outputChannel, workspaceRoot, token) {
    const input = parseCommandInput(query);
    let results;
    let searchTerm;
    
    switch (input.type) {
        case 'files':
            // #file a.tal, b.cbl
            results = await loadSpecificFiles(input.value, workspaceRoot, outputChannel);
            searchTerm = input.value.join(', ');
            break;
            
        case 'history':
            // #N - use history item
            const historyData = getHistoryResults(input.value);
            if (historyData.error) {
                response.markdown(`❌ ${historyData.error}`);
                return;
            }
            results = historyData.results;
            searchTerm = historyData.searchTerm;
            response.markdown(`*Using history #${input.value}: \`${searchTerm}\`*\n\n`);
            break;
            
        case 'search':
            // Fresh search within current context
            searchTerm = input.value;
            response.progress(`Analyzing: ${searchTerm}...`);
            results = searchCode(searchTerm, 40);
            break;
            
        case 'empty':
        default:
            // Show usage
            response.markdown('**Usage:** `@astra /describe <topic>`\n\n');
            response.markdown('**Syntax:**\n');
            response.markdown('- `/describe FEDIN-PARSE` — Search current context\n');
            response.markdown('- `/describe #5` — Use results from history item #5\n');
            response.markdown('- `/describe #file payment.tal, validate.cbl` — Specific files\n');
            if (queryHistory.length > 0) {
                const last = queryHistory[queryHistory.length - 1];
                response.markdown(`\n💡 *Recent: #${last.id} \`${last.query}\` — use \`/describe #${last.id}\`*`);
            }
            return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    // Save to history with cached results
    const uniqueFiles = [...new Set(results.map(r => r.file))];
    addToHistory('describe', searchTerm, `Described ${uniqueFiles.length} files`, uniqueFiles, results);
    
    const systemPrompt = DESCRIBE_SYSTEM_PROMPT;
    const userPrompt = getDescribeUserPrompt(searchTerm, context);

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * /translate - Translate TAL to Java
 * Syntax: /translate <topic> | /translate #N | /translate #file a.tal, b.cbl
 */
async function handleTranslateCommand(query, response, outputChannel, workspaceRoot, token) {
    const input = parseCommandInput(query);
    let results;
    let searchTerm;
    
    switch (input.type) {
        case 'files':
            // #file a.tal, b.cbl
            results = await loadSpecificFiles(input.value, workspaceRoot, outputChannel);
            searchTerm = input.value.join(', ');
            break;
            
        case 'history':
            // #N - use history item (filter to legacy source)
            const historyData = getHistoryResults(input.value);
            if (historyData.error) {
                response.markdown(`❌ ${historyData.error}`);
                return;
            }
            results = historyData.results;
            searchTerm = historyData.searchTerm;
            response.markdown(`*Using history #${input.value}: \`${searchTerm}\`*\n\n`);
            break;
            
        case 'search':
            // Fresh search within current context
            searchTerm = input.value;
            response.progress(`Finding code: ${searchTerm}...`);
            results = searchCode(searchTerm, 30);
            break;
            
        case 'empty':
        default:
            // Show usage
            response.markdown('**Usage:** `@astra /translate <topic>`\n\n');
            response.markdown('**Syntax:**\n');
            response.markdown('- `/translate PROC-VALIDATE` — Fresh search\n');
            response.markdown('- `/translate #5` — Use results from history item #5\n');
            response.markdown('- `/translate #file FEDIN.tal, FEDOUT.tal` — Specific files\n');
            if (queryHistory.length > 0) {
                const last = queryHistory[queryHistory.length - 1];
                response.markdown(`\n💡 *Recent: #${last.id} \`${last.query}\` — use \`/translate #${last.id}\`*`);
            }
            return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    // Save to history with cached results
    const uniqueFiles = [...new Set(results.map(r => r.file))];
    addToHistory('translate', searchTerm, `Translated ${uniqueFiles.length} files to Java`, uniqueFiles, results);
    
    const systemPrompt = TRANSLATE_SYSTEM_PROMPT;
    const userPrompt = getTranslateUserPrompt(context);

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * /deepwiki - Generate comprehensive DeepWiki-style documentation
 * Syntax: /deepwiki <topic> | /deepwiki #N | /deepwiki #file a.tal, b.cbl
 */
async function handleDeepWikiCommand(query, response, outputChannel, workspaceRoot, token) {
    const input = parseCommandInput(query);
    let results;
    let searchTerm;
    
    switch (input.type) {
        case 'files':
            // #file a.tal, b.cbl
            results = await loadSpecificFiles(input.value, workspaceRoot, outputChannel);
            searchTerm = input.value.join(', ');
            break;
            
        case 'history':
            // #N - use history item
            const historyData = getHistoryResults(input.value);
            if (historyData.error) {
                response.markdown(`❌ ${historyData.error}`);
                return;
            }
            results = historyData.results;
            searchTerm = historyData.searchTerm;
            response.markdown(`*Using history #${input.value}: \`${searchTerm}\`*\n\n`);
            break;
            
        case 'search':
            // Fresh search within current context
            searchTerm = input.value;
            response.progress(`Generating DeepWiki documentation: ${searchTerm}...`);
            results = searchCode(searchTerm, 60);  // More results for comprehensive docs
            break;
            
        case 'empty':
        default:
            // Show usage
            response.markdown('**Usage:** `@astra /deepwiki <topic>`\n\n');
            response.markdown('**Syntax:**\n');
            response.markdown('- `/deepwiki FEDIN` — Generate comprehensive documentation\n');
            response.markdown('- `/deepwiki #5` — Use results from history item #5\n');
            response.markdown('- `/deepwiki #file payment.tal` — Specific files\n');
            response.markdown('\n**Output:** DeepWiki-style technical documentation with:\n');
            response.markdown('- Architecture diagrams (Mermaid)\n');
            response.markdown('- Sequence diagrams\n');
            response.markdown('- Data flow analysis\n');
            response.markdown('- API/function reference\n');
            response.markdown('- Business rules catalog\n');
            if (queryHistory.length > 0) {
                const last = queryHistory[queryHistory.length - 1];
                response.markdown(`\n💡 *Recent: #${last.id} \`${last.query}\` — use \`/deepwiki #${last.id}\`*`);
            }
            return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    // Save to history with cached results
    const uniqueFiles = [...new Set(results.map(r => r.file))];
    addToHistory('deepwiki', searchTerm, `DeepWiki docs for ${uniqueFiles.length} files`, uniqueFiles, results);
    
    const systemPrompt = DEEPWIKI_SYSTEM_PROMPT;
    const userPrompt = getDeepWikiUserPrompt(searchTerm, context);

    // Stream response and save to generated/ directory
    const savedPath = await streamLLMResponseAndSave(
        systemPrompt, 
        userPrompt, 
        response, 
        outputChannel, 
        token, 
        workspaceRoot, 
        searchTerm, 
        'deepwiki'
    );
    
    appendFileReferences(results, workspaceRoot, response);
    
    if (savedPath) {
        const relativePath = path.relative(workspaceRoot, savedPath);
        response.markdown(`\n\n---\n📄 **Saved to:** \`${relativePath}\``);
    }
}

/**
 * Show available domain prompts
 */
function showDomains(response) {
    const domains = listDomainPrompts();
    
    if (domains.length === 0) {
        response.markdown('❌ No domain prompts registered.');
        return;
    }
    
    response.markdown(`# 🏢 Available Domain Prompts\n\n`);
    response.markdown(`| Domain | Name | Description |\n`);
    response.markdown(`|--------|------|-------------|\n`);
    
    for (const domain of domains) {
        response.markdown(`| \`${domain.key}\` | ${domain.name} | ${domain.description} |\n`);
    }
    
    response.markdown(`\n**Syntax:**\n`);
    response.markdown(`\`\`\`\n`);
    response.markdown(`@astra /fediso FEDIN message     # Fresh search\n`);
    response.markdown(`@astra /fediso #5                # Use history item #5\n`);
    response.markdown(`@astra /fediso #file payment.tal # Use specific files\n`);
    response.markdown(`\`\`\`\n`);
    response.markdown(`\n💡 *Custom domains can be registered programmatically*`);
}

/**
 * /domain - Run domain-specific analysis
 * Syntax: /domain <domainKey> <topic> | /domain <domainKey> #N | /domain <domainKey> #file a.tal
 * @param {string} domainKeyOrQuery - Domain key or "domainKey query"
 * @param {string} additionalQuery - Additional query if domain key is separate
 */
async function handleDomainCommand(domainKeyOrQuery, additionalQuery, response, outputChannel, workspaceRoot, token) {
    // Parse domain key and query
    let domainKey;
    let query;
    
    if (additionalQuery !== undefined && additionalQuery !== '') {
        // Called as /fediso or similar shortcut
        domainKey = domainKeyOrQuery;
        query = additionalQuery;
    } else {
        // Called as /domain fediso <query>
        const parts = domainKeyOrQuery.trim().split(/\s+/);
        domainKey = parts[0];
        query = parts.slice(1).join(' ');
    }
    
    if (!domainKey) {
        response.markdown('**Usage:** `@astra /domain <domain> [query]`\n\n');
        response.markdown('**Available domains:**\n');
        const domains = listDomainPrompts();
        for (const domain of domains) {
            response.markdown(`- \`${domain.key}\` - ${domain.name}\n`);
        }
        response.markdown(`\nRun \`@astra /domains\` for full details.`);
        return;
    }
    
    // Look up domain prompt
    const domainPrompt = getDomainPrompt(domainKey);
    
    if (!domainPrompt) {
        response.markdown(`❌ **Domain prompt not found:** \`${domainKey}\`\n\n`);
        response.markdown(`**Available domains:**\n`);
        const domains = listDomainPrompts();
        for (const domain of domains) {
            response.markdown(`- \`${domain.key}\` - ${domain.name}\n`);
        }
        response.markdown(`\nRun \`@astra /domains\` for full details.`);
        return;
    }
    
    outputChannel.appendLine(`Domain: ${domainKey}, Name: ${domainPrompt.name}`);
    
    const input = parseCommandInput(query);
    let results;
    let searchTerm;
    
    switch (input.type) {
        case 'files':
            // #file a.tal, b.cbl
            results = await loadSpecificFiles(input.value, workspaceRoot, outputChannel);
            searchTerm = input.value.join(', ');
            break;
            
        case 'history':
            // #N - use history item (filter to legacy source)
            const historyData = getHistoryResults(input.value);
            if (historyData.error) {
                response.markdown(`❌ ${historyData.error}`);
                return;
            }
            results = historyData.results;
            searchTerm = historyData.searchTerm;
            response.markdown(`*Applying ${domainPrompt.name} to history #${input.value}: \`${searchTerm}\`*\n\n`);
            break;
            
        case 'search':
            // Fresh search with domain terms within current context
            searchTerm = input.value;
            response.progress(`Finding code for ${domainPrompt.name}: ${searchTerm}...`);
            
            const searchTerms = [...(domainPrompt.searchTerms || []), ...searchTerm.split(/\s+/)];
            results = [];
            
            for (const term of searchTerms) {
                if (term.length < 3) continue;
                const termResults = grepIndex.searchLiteral(term, { 
                    caseSensitive: false, 
                    maxResults: 15 
                });
                results.push(...termResults.results);
            }
            
            // Dedupe
            const seen = new Set();
            results = results.filter(r => {
                const key = `${r.file}:${r.line}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, 40);
            break;
            
        case 'empty':
        default:
            // Show usage
            response.markdown(`**Usage:** \`@astra /${domainKey} <topic>\`\n\n`);
            response.markdown('**Syntax:**\n');
            response.markdown(`- \`/${domainKey} FEDIN message\` — Fresh search\n`);
            response.markdown(`- \`/${domainKey} #5\` — Use results from history item #5\n`);
            response.markdown(`- \`/${domainKey} #file payment.tal\` — Specific files\n`);
            if (queryHistory.length > 0) {
                const last = queryHistory[queryHistory.length - 1];
                response.markdown(`\n💡 *Recent: #${last.id} \`${last.query}\` — use \`/${domainKey} #${last.id}\`*`);
            }
            return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for ${domainPrompt.name}.\n\nTry:\n`);
        response.markdown(`- \`@astra /find ${(domainPrompt.searchTerms || [])[0] || domainKey}\` then \`@astra /${domainKey} #N\`\n`);
        response.markdown(`- \`@astra /${domainKey} #file myfile.tal\`\n`);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    // Save to history with cached results
    const uniqueFiles = [...new Set(results.map(r => r.file))];
    addToHistory(domainKey, searchTerm, `${domainPrompt.name} for ${uniqueFiles.length} files`, uniqueFiles, results);
    
    // Use domain-specific prompts
    const systemPrompt = domainPrompt.systemPrompt;
    const userPrompt = domainPrompt.getUserPrompt(context);

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * /requirements or /extract - Extract business requirements in Gherkin format
 * Syntax: /requirements <topic> | /requirements #N | /requirements #file a.tal
 */
async function handleRequirementsCommand(query, response, outputChannel, workspaceRoot, token) {
    const input = parseCommandInput(query);
    let results;
    let searchTerm;
    
    switch (input.type) {
        case 'files':
            // #file a.tal, b.cbl
            results = await loadSpecificFiles(input.value, workspaceRoot, outputChannel);
            searchTerm = input.value.join(', ');
            break;
            
        case 'history':
            // #N - use history item (filter to legacy source)
            const historyData = getHistoryResults(input.value);
            if (historyData.error) {
                response.markdown(`❌ ${historyData.error}`);
                return;
            }
            results = historyData.results;
            searchTerm = historyData.searchTerm;
            response.markdown(`*Extracting requirements from history #${input.value}: \`${searchTerm}\`*\n\n`);
            break;
            
        case 'search':
            // Fresh search within current context
            searchTerm = input.value;
            response.progress(`Extracting requirements for: ${searchTerm}...`);
            results = searchCode(searchTerm, 50);
            break;
            
        case 'empty':
        default:
            // Show usage
            response.markdown('**Usage:** `@astra /requirements <topic>`\n\n');
            response.markdown('**Syntax:**\n');
            response.markdown('- `/requirements wire transfer validation` — Fresh search\n');
            response.markdown('- `/requirements #5` — Use results from history item #5\n');
            response.markdown('- `/requirements #file payment.tal` — Specific files\n');
            if (queryHistory.length > 0) {
                const last = queryHistory[queryHistory.length - 1];
                response.markdown(`\n💡 *Recent: #${last.id} \`${last.query}\` — use \`/requirements #${last.id}\`*`);
            }
            return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    // Save to history with cached results
    const uniqueFiles = [...new Set(results.map(r => r.file))];
    addToHistory('requirements', searchTerm, `Extracted requirements from ${uniqueFiles.length} files`, uniqueFiles, results);
    
    const systemPrompt = REQUIREMENTS_SYSTEM_PROMPT;
    const userPrompt = getRequirementsUserPrompt(searchTerm, context);

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * Default general query handler
 */
async function handleGeneralQuery(query, response, outputChannel, workspaceRoot, token) {
    response.progress('Analyzing query...');
    const searchStrategy = analyzeQuery(query);
    outputChannel.appendLine(`Search strategy: ${JSON.stringify(searchStrategy)}`);

    response.progress('Searching codebase...');
    const searchResults = executeSearch(grepIndex, searchStrategy, outputChannel);

    if (searchResults.length === 0) {
        response.markdown(`No matches found. Try:\n- Different keywords\n- \`@astra /find <term>\`\n- \`@astra /help\` for commands`);
        return;
    }
    
    // Save results for chaining
    lastSearchResults = searchResults;
    lastSearchTerm = query;
    
    // Save to history with cached results
    const uniqueFiles = [...new Set(searchResults.map(r => r.file))];
    addToHistory(null, query, `Query answered from ${uniqueFiles.length} files`, uniqueFiles, searchResults);

    response.progress('Analyzing code...');
    const formattedContext = formatResultsForLLM(searchResults, workspaceRoot);

    const systemPrompt = GENERAL_SYSTEM_PROMPT;
    const userPrompt = getGeneralUserPrompt(query, formattedContext, searchStrategy.functionName);

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(searchResults, workspaceRoot, response);
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Load specific files by name
 */
async function loadSpecificFiles(fileNames, workspaceRoot, outputChannel) {
    const results = [];
    
    for (const fileName of fileNames) {
        // Search for files matching the name
        const searchName = fileName.replace(/^\/+/, '').trim();
        outputChannel.appendLine(`Looking for file: ${searchName}`);
        
        // Check index for matching files
        for (const [filePath, content] of grepIndex.files) {
            if (filePath.toLowerCase().includes(searchName.toLowerCase()) ||
                path.basename(filePath).toLowerCase() === searchName.toLowerCase()) {
                
                // Add file contents as results
                const lines = content.split('\n');
                const previewLines = Math.min(lines.length, 100);
                
                results.push({
                    file: filePath,
                    line: 1,
                    matchLine: lines.slice(0, previewLines).join('\n'),
                    context: {
                        before: [],
                        after: lines.slice(previewLines, previewLines + 20)
                    }
                });
                
                outputChannel.appendLine(`Found: ${filePath}`);
                break;
            }
        }
    }
    
    return results;
}

/**
 * Handle chained commands (e.g., "/find FEDIN then /translate then /fediso")
 */
async function handleChainedCommands(initialCommand, query, response, outputChannel, workspaceRoot, token) {
    // Parse the chain
    const parts = query.split(/\s+then\s+/i);
    const commands = [];
    
    // First part is the initial search term (for /find) or the full query
    let firstPart = parts[0].trim();
    if (initialCommand === 'find') {
        commands.push({ cmd: 'find', arg: firstPart });
    } else {
        commands.push({ cmd: initialCommand || 'find', arg: firstPart });
    }
    
    // Remaining parts are chained commands
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        const cmdMatch = part.match(/^\/?(\w+)\s*(.*)?$/);
        if (cmdMatch) {
            commands.push({ cmd: cmdMatch[1].toLowerCase(), arg: cmdMatch[2]?.trim() || '' });
        }
    }
    
    outputChannel.appendLine(`Chained commands: ${JSON.stringify(commands)}`);
    response.markdown(`## 🔗 Running chained commands\n\n`);
    
    // Execute each command in sequence
    for (let i = 0; i < commands.length; i++) {
        const { cmd, arg } = commands[i];
        response.markdown(`### Step ${i + 1}: /${cmd} ${arg}\n\n`);
        
        switch (cmd) {
            case 'find':
                await handleFindCommand(arg, response, outputChannel, workspaceRoot, token);
                break;
            case 'describe':
                await handleDescribeCommand(arg, response, outputChannel, workspaceRoot, token);
                break;
            case 'translate':
                await handleTranslateCommand(arg, response, outputChannel, workspaceRoot, token);
                break;
            case 'fediso':
                await handleFedIsoCommand(arg, response, outputChannel, workspaceRoot, token);
                break;
            case 'requirements':
            case 'extract':
                await handleRequirementsCommand(arg, response, outputChannel, workspaceRoot, token);
                break;
            default:
                response.markdown(`Unknown command: /${cmd}\n\n`);
        }
        
        // Add separator between commands
        if (i < commands.length - 1) {
            response.markdown(`\n---\n\n`);
        }
    }
}

/**
 * Search code using grep index
 */
function searchCode(searchTerm, maxResults = 30) {
    const keywords = searchTerm.split(/\s+/).filter(w => w.length > 2);
    let results = [];
    
    for (const keyword of keywords.slice(0, 5)) {
        const literalResults = grepIndex.searchLiteral(keyword, { 
            caseSensitive: false, 
            maxResults: Math.floor(maxResults / keywords.length) + 10
        });
        results.push(...literalResults.results);
    }
    
    // Dedupe
    const seen = new Set();
    return results.filter(r => {
        const key = `${r.file}:${r.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, maxResults);
}

/**
 * Stream LLM response
 */
async function streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token) {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    let model = models.find(m => m.name.toLowerCase().includes('claude') && m.name.toLowerCase().includes('sonnet'));
    if (!model) model = models.find(m => m.name.toLowerCase().includes('claude'));
    if (!model && models.length > 0) model = models[0];

    if (!model) {
        response.markdown('❌ No language model available. Make sure GitHub Copilot is authenticated.');
        return;
    }

    outputChannel.appendLine(`Using model: ${model.name}`);
    
    const messages = [vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt)];
    const chatResponse = await model.sendRequest(messages, {}, token);
    
    for await (const chunk of chatResponse.text) {
        response.markdown(chunk);
    }
}

/**
 * Stream LLM response and save to generated/ directory
 * Returns the generated file path
 */
async function streamLLMResponseAndSave(systemPrompt, userPrompt, response, outputChannel, token, workspaceRoot, term, command) {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    let model = models.find(m => m.name.toLowerCase().includes('claude') && m.name.toLowerCase().includes('sonnet'));
    if (!model) model = models.find(m => m.name.toLowerCase().includes('claude'));
    if (!model && models.length > 0) model = models[0];

    if (!model) {
        response.markdown('❌ No language model available. Make sure GitHub Copilot is authenticated.');
        return null;
    }

    outputChannel.appendLine(`Using model: ${model.name}`);
    
    const messages = [vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt)];
    const chatResponse = await model.sendRequest(messages, {}, token);
    
    // Collect full response while streaming
    let fullResponse = '';
    for await (const chunk of chatResponse.text) {
        response.markdown(chunk);
        fullResponse += chunk;
    }
    
    // Save to generated/ directory
    const generatedDir = path.join(workspaceRoot, 'generated');
    
    // Ensure generated directory exists
    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(generatedDir));
    } catch (e) {
        // Directory might already exist
    }
    
    // Create filename: <term>_<command>_<timestamp>.md
    const sanitizedTerm = term.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `${sanitizedTerm}_${command}_${timestamp}.md`;
    const filePath = path.join(generatedDir, filename);
    
    // Add header with metadata
    const header = `<!-- Generated by AstraCode -->
<!-- Command: /${command} ${term} -->
<!-- Timestamp: ${new Date().toISOString()} -->
<!-- Source files: See bottom of document -->

`;
    
    // Write file
    const content = Buffer.from(header + fullResponse, 'utf8');
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), content);
    
    outputChannel.appendLine(`Saved output to: ${filePath}`);
    
    return filePath;
}

/**
 * Get list of generated files
 */
async function getGeneratedFiles(workspaceRoot) {
    const generatedDir = path.join(workspaceRoot, 'generated');
    const pattern = new vscode.RelativePattern(generatedDir, '*.md');
    
    try {
        const files = await vscode.workspace.findFiles(pattern, null, 100);
        return files.map(f => ({
            path: f.fsPath,
            name: path.basename(f.fsPath),
            uri: f
        }));
    } catch (e) {
        return [];
    }
}

/**
 * Delete generated files
 */
async function deleteGeneratedFiles(workspaceRoot, pattern = '*') {
    const files = await getGeneratedFiles(workspaceRoot);
    let deleted = 0;
    
    for (const file of files) {
        if (pattern === '*' || file.name.includes(pattern)) {
            try {
                await vscode.workspace.fs.delete(file.uri);
                deleted++;
            } catch (e) {
                // Skip files that can't be deleted
            }
        }
    }
    
    return deleted;
}

/**
 * Group results by file
 */
function groupByFile(results) {
    const byFile = new Map();
    for (const result of results) {
        const existing = byFile.get(result.file) || [];
        existing.push(result);
        byFile.set(result.file, existing);
    }
    return byFile;
}

/**
 * Format a single snippet
 */
function formatSnippet(result) {
    let snippet = '';
    if (result.context?.before) {
        snippet += result.context.before.join('\n') + '\n';
    }
    snippet += result.matchLine || result.content || '';
    if (result.context?.after) {
        snippet += '\n' + result.context.after.join('\n');
    }
    return snippet.trim();
}

/**
 * Append file references to response
 */
function appendFileReferences(results, workspaceRoot, response) {
    const uniqueFiles = [...new Set(results.map(r => r.file))].slice(0, 10);
    response.markdown('\n\n---\n**📁 Source files:**\n');
    for (const file of uniqueFiles) {
        const relativePath = path.relative(workspaceRoot, file);
        response.markdown(`- \`${relativePath}\`\n`);
    }
}

/**
 * Build the grep index from workspace files
 */
async function buildIndex(workspaceRoot, outputChannel) {
    const contextFiles = new Map();
    
    // Source code extensions only - exclude .md to avoid indexing generated docs
    const extensions = [
        'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
        'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sql',
        'tal', 'cbl', 'cob', 'cobol', 'pli', 'pco', 'cpy', 'json', 'yaml', 'yml'
    ];
    
    const pattern = `**/*.{${extensions.join(',')}}`;
    // Exclude node_modules and generated directory
    const excludePattern = '{**/node_modules/**,**/generated/**}';
    
    const files = await vscode.workspace.findFiles(pattern, excludePattern, 5000);
    
    outputChannel.appendLine(`Found ${files.length} files to index (excluding generated/)`);
    
    for (const fileUri of files) {
        try {
            const content = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(content).toString('utf8');
            const ext = path.extname(fileUri.fsPath).slice(1);
            
            contextFiles.set(fileUri.fsPath, {
                content: text,
                language: ext
            });
        } catch (e) {
            // Skip files that can't be read
        }
    }
    
    grepIndex = new GrepIndex({
        contextLines: 3,
        maxResults: 100,
        buildCallIndex: true
    });
    
    grepIndex.build(contextFiles, {
        log: (msg) => outputChannel.appendLine(msg)
    });
}

/**
 * Analyze query to determine search strategy
 */
function analyzeQuery(query) {
    const strategy = {
        type: 'general',
        keywords: [],
        functionName: null,
        isCallSearch: false,
        isUsageSearch: false
    };
    
    const lowerQuery = query.toLowerCase();
    
    const callPatterns = [
        /who\s+calls?\s+['"`]?(\w+)['"`]?/i,
        /callers?\s+of\s+['"`]?(\w+)['"`]?/i,
        /where\s+is\s+['"`]?(\w+)['"`]?\s+called/i,
        /find\s+calls?\s+to\s+['"`]?(\w+)['"`]?/i,
        /usages?\s+of\s+['"`]?(\w+)['"`]?/i,
        /references?\s+to\s+['"`]?(\w+)['"`]?/i
    ];
    
    for (const pattern of callPatterns) {
        const match = query.match(pattern);
        if (match) {
            strategy.functionName = match[1];
            strategy.isCallSearch = lowerQuery.includes('call');
            strategy.isUsageSearch = lowerQuery.includes('usage') || lowerQuery.includes('reference');
            strategy.type = 'function_search';
            return strategy;
        }
    }
    
    const codeTerms = query.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}(?:_[a-zA-Z0-9_]+)*|[a-z]+(?:[A-Z][a-z]+)+/g) || [];
    
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
        'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
        'through', 'during', 'before', 'after', 'above', 'below', 'between',
        'and', 'but', 'if', 'or', 'because', 'while', 'although', 'this', 'that',
        'what', 'which', 'who', 'how', 'why', 'when', 'where', 'explain', 'show',
        'find', 'tell', 'describe', 'work', 'works', 'working', 'code', 'function',
        'please', 'help', 'understand', 'want', 'like', 'know', 'get', 'make'
    ]);
    
    const words = query
        .toLowerCase()
        .replace(/[^\w\s_-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    
    strategy.keywords = [...new Set([...codeTerms, ...words])].slice(0, 10);
    
    if (codeTerms.length === 1 && codeTerms[0].length > 3) {
        strategy.functionName = codeTerms[0];
        strategy.type = 'function_search';
    }
    
    return strategy;
}

/**
 * Execute search based on strategy
 */
function executeSearch(index, strategy, outputChannel) {
    let results = [];
    
    if (strategy.type === 'function_search' && strategy.functionName) {
        outputChannel.appendLine(`Searching for function: ${strategy.functionName}`);
        
        if (strategy.isUsageSearch) {
            const usageResults = index.searchSymbolUsages(strategy.functionName, { maxResults: 50 });
            results = usageResults.results;
        } else if (strategy.isCallSearch) {
            const callResults = index.searchFunctionCalls(strategy.functionName, { maxResults: 50 });
            results = callResults.results;
        } else {
            const callResults = index.searchFunctionCalls(strategy.functionName, { maxResults: 30 });
            if (callResults.results.length > 0) {
                results = callResults.results;
            } else {
                const literalResults = index.searchLiteral(strategy.functionName, { wholeWord: true, maxResults: 50 });
                results = literalResults.results;
            }
        }
        outputChannel.appendLine(`Found ${results.length} results`);
    }
    
    if (results.length === 0 && strategy.keywords.length > 0) {
        outputChannel.appendLine(`Keyword search: ${strategy.keywords.join(', ')}`);
        
        for (const keyword of strategy.keywords.slice(0, 5)) {
            const literalResults = index.searchLiteral(keyword, { 
                caseSensitive: false, 
                maxResults: 20 
            });
            results.push(...literalResults.results);
            
            if (results.length >= 50) break;
        }
        
        const seen = new Set();
        results = results.filter(r => {
            const key = `${r.file}:${r.line}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        
        outputChannel.appendLine(`Found ${results.length} results after dedup`);
    }
    
    return results.slice(0, 50);
}

/**
 * Format search results for LLM
 */
function formatResultsForLLM(results, workspaceRoot) {
    const byFile = groupByFile(results);
    const sections = [];
    
    for (const [file, fileResults] of byFile) {
        const relativePath = path.relative(workspaceRoot, file);
        const ext = path.extname(file).slice(1) || 'txt';
        
        let section = `### ${relativePath}\n\n`;
        
        for (const result of fileResults.slice(0, 5)) {
            const snippet = formatSnippet(result);
            let locationInfo = `Line ${result.line}`;
            if (result.enclosingFunction) {
                locationInfo += ` in \`${result.enclosingFunction.name}()\``;
            }
            section += `**${locationInfo}:**\n\`\`\`${ext}\n${snippet}\n\`\`\`\n\n`;
        }
        
        sections.push(section);
    }
    
    let combined = sections.join('\n');
    if (combined.length > 10000) {
        combined = combined.slice(0, 10000) + '\n\n... (truncated)';
    }
    
    return combined;
}

function deactivate() {
    grepIndex = null;
    indexedWorkspace = null;
    lastSearchResults = null;
    lastSearchTerm = null;
    queryHistory = [];
}

module.exports = { activate, deactivate };
