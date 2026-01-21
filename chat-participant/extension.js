const vscode = require('vscode');
const path = require('path');
const { GrepIndex } = require('./grep-search');

const PARTICIPANT_ID = 'astracode.chat';

// Global grep index - persists across queries
let grepIndex = null;
let indexedWorkspace = null;
let lastSearchResults = null;  // Store last search results for chaining
let lastSearchTerm = null;     // Store last search term

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
            grepIndex = null;
            indexedWorkspace = null;
            outputChannel.appendLine('Forcing index rebuild...');
            response.progress('Rebuilding index from scratch...');
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
                
                case 'fediso':
                    return await handleFedIsoCommand(query, response, outputChannel, workspaceRoot, token);
                
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
    response.markdown(`# 🔍 AstraCode Help

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/find\` | Search for code by keyword | \`@astra /find FEDIN\` |
| \`/describe\` | Describe functionality of code | \`@astra /describe FEDIN-PARSE\` |
| \`/translate\` | Translate TAL to Java | \`@astra /translate PROC-VALIDATE\` |
| \`/fediso\` | Uplift to Fed ISO 20022 | \`@astra /fediso FEDIN message\` |
| \`/requirements\` | Extract business requirements | \`@astra /requirements wire transfer\` |
| \`/extract\` | Alias for /requirements | \`@astra /extract validation rules\` |
| \`/stats\` | Show index statistics | \`@astra /stats\` |
| \`/clear\` | Clear index (fresh start) | \`@astra /clear\` |
| \`/rebuild\` | Force rebuild index | \`@astra /rebuild\` |
| \`/help\` | Show this help | \`@astra /help\` |

## Specifying Files

You can specify files directly with any command:

\`\`\`
@astra /translate files: FEDIN.tal, FEDOUT.tal
@astra /describe files: payment-validator.c
@astra /fediso files: wire-msg.tal, fed-parse.tal
\`\`\`

## Command Chaining

Run multiple operations in sequence:

\`\`\`
@astra /find account validation then /translate then /fediso
@astra /find FEDIN then /describe then /requirements
\`\`\`

## Using Previous Results

Commands without arguments use the last \`/find\` results:

\`\`\`
@astra /find FEDIN              # Find code first
@astra /translate               # Translate what was found
@astra /fediso                  # Apply ISO uplift to same code
\`\`\`

## General Queries

Without a command, AstraCode answers code questions:

- \`@astra who calls heap_insert\`
- \`@astra explain partition pruning\`
- \`@astra find usages of validateTransaction\`

## Workflow Example

\`\`\`
@astra /find account validation      # Step 1: Find relevant code
@astra /describe                     # Step 2: Understand it
@astra /requirements                 # Step 3: Extract requirements
@astra /translate                    # Step 4: Convert to Java
@astra /fediso                       # Step 5: Apply ISO 20022 mapping
\`\`\`
`);
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
    
    if (results.length === 0) {
        response.markdown(`No matches found for: \`${searchTerm}\`\n\nTry:\n- Different spelling\n- Partial term\n- \`@astra /rebuild\` to refresh index`);
        return;
    }
    
    // Format results
    response.markdown(`## 🔍 Found ${results.length} matches for \`${searchTerm}\`\n\n`);
    response.markdown(`💡 *Tip: Use \`@astra /translate\` or \`@astra /describe\` to work with these results*\n\n`);
    
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
 * /describe - Describe functionality of code
 */
async function handleDescribeCommand(query, response, outputChannel, workspaceRoot, token) {
    // Check for "files:" syntax
    const filesMatch = query.match(/files?:\s*(.+)/i);
    let results;
    let searchTerm;
    
    if (filesMatch) {
        // Load specific files
        const fileNames = filesMatch[1].split(/[,\s]+/).filter(f => f.length > 0);
        results = await loadSpecificFiles(fileNames, workspaceRoot, outputChannel);
        searchTerm = fileNames.join(', ');
    } else if (query.trim()) {
        // Search by term
        searchTerm = query.trim();
        response.progress(`Analyzing: ${searchTerm}...`);
        results = searchCode(searchTerm, 40);
    } else if (lastSearchResults && lastSearchResults.length > 0) {
        // Use last results
        results = lastSearchResults;
        searchTerm = lastSearchTerm || 'previous search';
        response.markdown(`*Using results from previous search: \`${searchTerm}\`*\n\n`);
    } else {
        response.markdown('**Usage:** `@astra /describe <function or module>`\n\n**Examples:**\n- `@astra /describe FEDIN-PARSE`\n- `@astra /describe files: payment.tal, validate.tal`\n- First run `/find`, then `/describe` to use those results');
        return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    const systemPrompt = `You are an expert code analyst. Describe the functionality of the code clearly and concisely.

Your description should include:
1. **Purpose**: What does this code do? (1-2 sentences)
2. **Key Functions**: List main functions/procedures and their roles
3. **Data Flow**: How does data move through the code?
4. **Business Logic**: What business rules are implemented?
5. **Dependencies**: What does it call or depend on?

Be specific and reference actual function names and line numbers.`;

    const userPrompt = `## Code to Describe: ${searchTerm}

${context}

## Instructions
Provide a clear description of this code's functionality.`;

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * /translate - Translate TAL to Java
 */
async function handleTranslateCommand(query, response, outputChannel, workspaceRoot, token) {
    // Check for "files:" syntax
    const filesMatch = query.match(/files?:\s*(.+)/i);
    let results;
    let searchTerm;
    
    if (filesMatch) {
        // Load specific files
        const fileNames = filesMatch[1].split(/[,\s]+/).filter(f => f.length > 0);
        results = await loadSpecificFiles(fileNames, workspaceRoot, outputChannel);
        searchTerm = fileNames.join(', ');
    } else if (query.trim()) {
        // Search by term
        searchTerm = query.trim();
        response.progress(`Finding TAL code: ${searchTerm}...`);
        results = searchCode(searchTerm, 30);
    } else if (lastSearchResults && lastSearchResults.length > 0) {
        // Use last results
        results = lastSearchResults;
        searchTerm = lastSearchTerm || 'previous search';
        response.markdown(`*Translating results from previous search: \`${searchTerm}\`*\n\n`);
    } else {
        response.markdown('**Usage:** `@astra /translate <term or files>`\n\n**Examples:**\n- `@astra /translate PROC-VALIDATE`\n- `@astra /translate files: FEDIN.tal, FEDOUT.tal`\n- First run `/find FEDIN`, then `/translate` to translate those results');
        return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    const systemPrompt = `You are an expert TAL (Transaction Application Language) to Java translator.

Translate the TAL code to modern Java while:
1. **Preserving all business logic exactly**
2. Using Java best practices (proper types, null safety, streams)
3. Adding comments explaining original TAL constructs
4. Using appropriate types (BigDecimal for money, Optional for nullable)

**TAL to Java mapping:**
| TAL | Java |
|-----|------|
| PROC | method |
| STRUCT | class or record |
| STRING[0:n] | String |
| INT | int/long |
| FIXED(n) | BigDecimal |
| LITERAL | static final |
| CALL | method call |
| DEFINE | constant |

**Output format:**
1. Brief summary of what the TAL code does
2. Complete Java translation with comments
3. Any assumptions made`;

    const userPrompt = `## TAL Code to Translate

${context}

## Instructions
Translate this TAL code to Java. Preserve all business logic.`;

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * /fediso - Uplift to Fed ISO 20022
 */
async function handleFedIsoCommand(query, response, outputChannel, workspaceRoot, token) {
    // Check for "files:" syntax
    const filesMatch = query.match(/files?:\s*(.+)/i);
    let results;
    let searchTerm;
    
    if (filesMatch) {
        // Load specific files
        const fileNames = filesMatch[1].split(/[,\s]+/).filter(f => f.length > 0);
        results = await loadSpecificFiles(fileNames, workspaceRoot, outputChannel);
        searchTerm = fileNames.join(', ');
    } else if (query.trim()) {
        // Search by term
        searchTerm = query.trim();
        response.progress(`Finding Fed wire code: ${searchTerm}...`);
        
        // Search for Fed-related terms plus user's term
        const fedTerms = ['FEDIN', 'FEDOUT', 'FED', 'wire', 'transfer', ...searchTerm.split(/\s+/)];
        results = [];
        
        for (const term of fedTerms) {
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
    } else if (lastSearchResults && lastSearchResults.length > 0) {
        // Use last results
        results = lastSearchResults;
        searchTerm = lastSearchTerm || 'previous search';
        response.markdown(`*Applying Fed ISO 20022 uplift to results from: \`${searchTerm}\`*\n\n`);
    } else {
        // Default: search for common Fed terms
        response.progress(`Finding Fed wire code...`);
        searchTerm = 'FEDIN FEDOUT wire';
        
        const fedTerms = ['FEDIN', 'FEDOUT', 'FED', 'wire', 'transfer'];
        results = [];
        
        for (const term of fedTerms) {
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
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No Fed wire code found.\n\nTry:\n- \`@astra /find FEDIN\` then \`@astra /fediso\`\n- \`@astra /fediso files: wire-msg.tal\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    const systemPrompt = `You are an expert in Fed wire transfers and ISO 20022 migration.

Your task is to analyze legacy Fed wire code and provide ISO 20022 (pacs.008) uplift guidance.

**FEDIN/FEDOUT to ISO 20022 Mapping:**

| Legacy Field | ISO 20022 pacs.008 | XPath |
|--------------|-------------------|-------|
| SENDER-ABA | Instructing Agent | /InstgAgt/FinInstnId/ClrSysMmbId/MmbId |
| RECEIVER-ABA | Instructed Agent | /InstdAgt/FinInstnId/ClrSysMmbId/MmbId |
| AMOUNT | Interbank Settlement Amount | /IntrBkSttlmAmt |
| SENDER-REF | End to End ID | /PmtId/EndToEndId |
| IMAD | UETR | /PmtId/UETR |
| ORIG-NAME | Debtor Name | /Dbtr/Nm |
| ORIG-ADDR | Debtor Address | /Dbtr/PstlAdr |
| ORIG-ACCT | Debtor Account | /DbtrAcct/Id/Othr/Id |
| BENEF-NAME | Creditor Name | /Cdtr/Nm |
| BENEF-ACCT | Creditor Account | /CdtrAcct/Id/Othr/Id |
| OBI | Remittance Info | /RmtInf/Ustrd |
| VALUE-DATE | Settlement Date | /IntrBkSttlmDt |
| TYPE-CODE | Service Level | /PmtTpInf/SvcLvl/Cd |

**Output format:**
1. **Current State**: What Fed wire fields/logic exist in the code
2. **Field Mapping**: Map each legacy field to ISO 20022
3. **Java Implementation**: Converter class using pacs.008
4. **Validation Rules**: Any business rules to preserve
5. **Migration Notes**: Considerations for the uplift`;

    const userPrompt = `## Legacy Fed Wire Code

${context}

## Instructions
Analyze this code and provide ISO 20022 (pacs.008) uplift guidance with Java implementation.`;

    await streamLLMResponse(systemPrompt, userPrompt, response, outputChannel, token);
    appendFileReferences(results, workspaceRoot, response);
}

/**
 * /requirements or /extract - Extract business requirements
 */
async function handleRequirementsCommand(query, response, outputChannel, workspaceRoot, token) {
    // Check for "files:" syntax
    const filesMatch = query.match(/files?:\s*(.+)/i);
    let results;
    let searchTerm;
    
    if (filesMatch) {
        // Load specific files
        const fileNames = filesMatch[1].split(/[,\s]+/).filter(f => f.length > 0);
        results = await loadSpecificFiles(fileNames, workspaceRoot, outputChannel);
        searchTerm = fileNames.join(', ');
    } else if (query.trim()) {
        // Search by term
        searchTerm = query.trim();
        response.progress(`Extracting requirements for: ${searchTerm}...`);
        results = searchCode(searchTerm, 50);
    } else if (lastSearchResults && lastSearchResults.length > 0) {
        // Use last results
        results = lastSearchResults;
        searchTerm = lastSearchTerm || 'previous search';
        response.markdown(`*Extracting requirements from previous search: \`${searchTerm}\`*\n\n`);
    } else {
        response.markdown('**Usage:** `@astra /requirements <topic>`\n\n**Examples:**\n- `@astra /requirements wire transfer validation`\n- `@astra /requirements files: payment.tal`\n- First run `/find`, then `/requirements` to extract from those results');
        return;
    }
    
    if (!results || results.length === 0) {
        response.markdown(`No code found for: \`${searchTerm}\``);
        return;
    }
    
    const context = formatResultsForLLM(results, workspaceRoot);
    
    const systemPrompt = `You are a business analyst expert at extracting requirements from code.

Analyze the code and extract:

1. **Functional Requirements**
   - What the system must do
   - Input/output specifications
   - Processing rules

2. **Business Rules**
   - Validation rules (with specific conditions)
   - Calculations and formulas
   - Decision logic (if X then Y)

3. **Data Requirements**
   - Required fields and their formats
   - Data relationships
   - Constraints (min/max, allowed values)

4. **Non-Functional Requirements**
   - Error handling behavior
   - Performance considerations (if apparent)
   - Security/audit requirements

Format each requirement as:
- **REQ-XXX**: [Requirement description]
  - Source: [file:line]
  - Priority: [Must/Should/Could]`;

    const userPrompt = `## Code to Analyze: ${searchTerm}

${context}

## Instructions
Extract business requirements from this code. Be specific and reference source locations.`;

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

    response.progress('Analyzing code...');
    const formattedContext = formatResultsForLLM(searchResults, workspaceRoot);

    const systemPrompt = `You are AstraCode, an expert code analyst. Answer questions about codebases clearly and concisely.

Guidelines:
- Answer the user's specific question
- Reference specific files and line numbers
- Explain code flow and relationships
- For "who calls X?" - list callers with context
- Be concise but thorough`;

    const userPrompt = `## Question
${query}

${searchStrategy.functionName ? `## Search Target\nFunction/Symbol: \`${searchStrategy.functionName}\`\n\n` : ''}## Code Search Results
${formattedContext}

## Instructions
Answer the question based on the code above.`;

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
}

module.exports = { activate, deactivate };
