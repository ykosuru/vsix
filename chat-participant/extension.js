const vscode = require('vscode');
const path = require('path');
const { GrepIndex } = require('./grep-search');

const PARTICIPANT_ID = 'astracode.chat';

// Global grep index - persists across queries
let grepIndex = null;
let indexedWorkspace = null;

function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AstraCode');
    outputChannel.appendLine('AstraCode Copilot participant activated');

    // Register the chat participant
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token) => {
        const query = request.prompt;
        outputChannel.appendLine(`\n=== New Query: ${query} ===`);

        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                response.markdown('❌ No workspace folder open. Please open a folder first.');
                return;
            }

            // Build or rebuild index if needed
            if (!grepIndex || indexedWorkspace !== workspaceRoot) {
                response.progress('Building code index...');
                await buildIndex(workspaceRoot, outputChannel);
                indexedWorkspace = workspaceRoot;
            }

            // Analyze query to determine search strategy
            response.progress('Analyzing query...');
            const searchStrategy = analyzeQuery(query);
            outputChannel.appendLine(`Search strategy: ${JSON.stringify(searchStrategy)}`);

            // Execute searches based on strategy
            response.progress('Searching codebase...');
            const searchResults = executeSearch(grepIndex, searchStrategy, outputChannel);

            if (searchResults.length === 0) {
                response.markdown(`No matches found. Try:\n- Different keywords\n- Check spelling of function/symbol names\n- Use \`@astra rebuild\` to refresh the index`);
                return;
            }

            // Format context for LLM
            response.progress('Analyzing code...');
            const formattedContext = formatResultsForLLM(searchResults, workspaceRoot);
            outputChannel.appendLine(`Context size: ${formattedContext.length} chars`);

            // Build prompts
            const systemPrompt = buildSystemPrompt();
            const userPrompt = buildUserPrompt(query, formattedContext, searchStrategy);

            // Get LLM model
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            let model = models.find(m => m.name.toLowerCase().includes('claude') && m.name.toLowerCase().includes('sonnet'));
            if (!model) model = models.find(m => m.name.toLowerCase().includes('claude'));
            if (!model && models.length > 0) model = models[0];

            if (!model) {
                response.markdown('❌ No language model available. Make sure GitHub Copilot is authenticated.');
                return;
            }

            outputChannel.appendLine(`Using model: ${model.name}`);

            // Stream response
            const messages = [vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt)];
            const chatResponse = await model.sendRequest(messages, {}, token);
            
            for await (const chunk of chatResponse.text) {
                response.markdown(chunk);
            }

            // Add file references
            const uniqueFiles = [...new Set(searchResults.map(r => r.file))].slice(0, 10);
            response.markdown('\n\n---\n**📁 Files found:**\n');
            for (const file of uniqueFiles) {
                const relativePath = path.relative(workspaceRoot, file);
                response.markdown(`- \`${relativePath}\`\n`);
            }

        } catch (error) {
            outputChannel.appendLine(`Error: ${error.stack || error}`);
            response.markdown(`❌ Error: ${error.message}`);
        }
    });

    participant.iconPath = new vscode.ThemeIcon('search');
    context.subscriptions.push(participant, outputChannel);
}

/**
 * Build the grep index from workspace files
 */
async function buildIndex(workspaceRoot, outputChannel) {
    const contextFiles = new Map();
    
    // File extensions to index
    const extensions = [
        'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
        'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sql',
        'tal', 'cbl', 'cob', 'cobol', 'pli', 'md', 'json', 'yaml', 'yml'
    ];
    
    const pattern = `**/*.{${extensions.join(',')}}`;
    const excludePattern = '**/node_modules/**';
    
    const files = await vscode.workspace.findFiles(pattern, excludePattern, 5000);
    
    outputChannel.appendLine(`Found ${files.length} files to index`);
    
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
    
    // Detect "who calls X" / "callers of X" patterns
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
    
    // Extract code-like terms (snake_case, camelCase, etc.)
    const codeTerms = query.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}(?:_[a-zA-Z0-9_]+)*|[a-z]+(?:[A-Z][a-z]+)+/g) || [];
    
    // Extract keywords
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
    
    // If we have a single code term that looks like a function, treat as function search
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
            // Full symbol usage search
            const usageResults = index.searchSymbolUsages(strategy.functionName, { maxResults: 50 });
            results = usageResults.results;
            outputChannel.appendLine(`Found ${results.length} usages`);
        } else if (strategy.isCallSearch) {
            // Just call sites
            const callResults = index.searchFunctionCalls(strategy.functionName, { maxResults: 50 });
            results = callResults.results;
            outputChannel.appendLine(`Found ${results.length} call sites`);
        } else {
            // Try calls first, fall back to literal
            const callResults = index.searchFunctionCalls(strategy.functionName, { maxResults: 30 });
            if (callResults.results.length > 0) {
                results = callResults.results;
            } else {
                const literalResults = index.searchLiteral(strategy.functionName, { wholeWord: true, maxResults: 50 });
                results = literalResults.results;
            }
            outputChannel.appendLine(`Found ${results.length} results`);
        }
    }
    
    // If no results yet, do keyword search
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
        
        // Dedupe by file:line
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
    const byFile = new Map();
    
    for (const result of results) {
        const existing = byFile.get(result.file) || [];
        existing.push(result);
        byFile.set(result.file, existing);
    }
    
    const sections = [];
    
    for (const [file, fileResults] of byFile) {
        const relativePath = path.relative(workspaceRoot, file);
        const ext = path.extname(file).slice(1) || 'txt';
        
        let section = `### ${relativePath}\n\n`;
        
        for (const result of fileResults.slice(0, 5)) {
            // Build snippet with context
            let snippet = '';
            
            if (result.context?.before) {
                snippet += result.context.before.join('\n') + '\n';
            }
            
            snippet += `>>> ${result.matchLine || result.context || result.content || ''}\n`;
            
            if (result.context?.after) {
                snippet += result.context.after.join('\n');
            }
            
            // Add enclosing function info if available
            let locationInfo = `Line ${result.line}`;
            if (result.enclosingFunction) {
                locationInfo += ` in \`${result.enclosingFunction.name}()\``;
            }
            if (result.usageType) {
                locationInfo += ` [${result.usageType}]`;
            }
            
            section += `**${locationInfo}:**\n\`\`\`${ext}\n${snippet.trim()}\n\`\`\`\n\n`;
        }
        
        sections.push(section);
    }
    
    let combined = sections.join('\n');
    if (combined.length > 10000) {
        combined = combined.slice(0, 10000) + '\n\n... (truncated)';
    }
    
    return combined;
}

/**
 * Build system prompt
 */
function buildSystemPrompt() {
    return `You are AstraCode, an expert code analyst. You help developers understand codebases by analyzing search results and providing clear explanations.

Guidelines:
- Answer the user's specific question based on the code shown
- Reference specific files and line numbers
- Explain code flow and relationships between components  
- For "who calls X?" queries, list the callers with context
- Be concise but thorough
- If the results don't fully answer the question, say so`;
}

/**
 * Build user prompt
 */
function buildUserPrompt(query, context, strategy) {
    let prompt = `## Question\n${query}\n\n`;
    
    if (strategy.functionName) {
        prompt += `## Search Target\nFunction/Symbol: \`${strategy.functionName}\`\n\n`;
    }
    
    prompt += `## Code Search Results\n${context}\n\n`;
    prompt += `## Instructions\nBased on the code above, answer the question. Reference specific files and lines.`;
    
    return prompt;
}

function deactivate() {
    grepIndex = null;
    indexedWorkspace = null;
}

module.exports = { activate, deactivate };
