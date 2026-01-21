const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const PARTICIPANT_ID = 'astracode.chat';

function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AstraCode');
    outputChannel.appendLine('AstraCode Copilot participant activated');

    // Register the chat participant
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token) => {
        const query = request.prompt;
        outputChannel.appendLine(`\n=== New Query: ${query} ===`);

        try {
            // Step 1: Extract keywords from query
            response.progress('Extracting search keywords...');
            const keywords = extractKeywords(query);
            outputChannel.appendLine(`Keywords: ${keywords.join(', ')}`);

            // Step 2: Get workspace root
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                response.markdown('❌ No workspace folder open. Please open a folder first.');
                return;
            }

            // Step 3: Grep for relevant content
            response.progress(`Searching codebase for: ${keywords.join(', ')}...`);
            const searchResults = await grepCodebase(workspaceRoot, keywords, outputChannel);
            
            outputChannel.appendLine(`Found ${searchResults.totalMatches} matches in ${searchResults.results.length} locations`);

            if (searchResults.results.length === 0) {
                response.markdown(`No matches found for keywords: ${keywords.join(', ')}\n\nTry rephrasing your question or being more specific.`);
                return;
            }

            // Step 4: Format context for LLM
            response.progress('Analyzing relevant code...');
            const formattedContext = formatContextForLLM(searchResults);
            
            // Step 5: Build the prompt
            const systemPrompt = buildSystemPrompt();
            const userPrompt = buildUserPrompt(query, formattedContext);

            outputChannel.appendLine(`Context size: ${formattedContext.length} chars`);

            // Step 6: Use Copilot's LLM API
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt)
            ];

            // Get available models and prefer Claude
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });

            let model = models.find(m => m.name.toLowerCase().includes('claude') && m.name.toLowerCase().includes('sonnet'));
            if (!model) {
                model = models.find(m => m.name.toLowerCase().includes('claude'));
            }
            if (!model && models.length > 0) {
                model = models[0];
            }

            if (!model) {
                response.markdown('❌ No language model available. Make sure GitHub Copilot is installed and authenticated.');
                return;
            }

            outputChannel.appendLine(`Using model: ${model.name}`);

            // Stream the response
            const chatResponse = await model.sendRequest(messages, {}, token);
            
            for await (const chunk of chatResponse.text) {
                response.markdown(chunk);
            }

            // Add references to files
            response.markdown('\n\n---\n**📁 Files searched:**\n');
            const uniqueFiles = [...new Set(searchResults.results.map(r => r.file))].slice(0, 10);
            for (const file of uniqueFiles) {
                const relativePath = path.relative(workspaceRoot, file);
                response.markdown(`- \`${relativePath}\`\n`);
            }

        } catch (error) {
            outputChannel.appendLine(`Error: ${error}`);
            response.markdown(`❌ Error: ${error}`);
        }
    });

    participant.iconPath = new vscode.ThemeIcon('search');
    context.subscriptions.push(participant, outputChannel);
}

function extractKeywords(query) {
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
        'below', 'between', 'under', 'again', 'further', 'then', 'once',
        'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
        'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
        'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but',
        'if', 'or', 'because', 'until', 'while', 'although', 'though',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
        'am', 'it', 'its', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours',
        'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
        'they', 'them', 'their', 'explain', 'show', 'find', 'tell', 'describe',
        'work', 'works', 'working', 'code', 'function', 'functions', 'please',
        'help', 'understand', 'want', 'like', 'know', 'get', 'make'
    ]);

    const words = query
        .toLowerCase()
        .replace(/[^\w\s_-]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));

    const codeTerms = query.match(/[a-zA-Z_][a-zA-Z0-9_]*(?:_[a-zA-Z0-9_]+)+|[a-z]+(?:[A-Z][a-z]+)+/g) || [];
    
    const allKeywords = [...new Set([...words, ...codeTerms.map(t => t.toLowerCase())])];
    return allKeywords.slice(0, 8);
}

function grepCodebase(workspaceRoot, keywords, outputChannel) {
    return new Promise((resolve) => {
        const pattern = keywords.join('|');
        
        const extensions = [
            'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
            'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sql',
            'tal', 'cbl', 'cob', 'cobol', 'pli', 'jcl', 'md', 'txt', 'json', 'yaml', 'yml'
        ];
        
        const includePattern = extensions.map(ext => `--include=*.${ext}`).join(' ');
        
        const excludeDirs = [
            'node_modules', '.git', 'dist', 'build', 'out', '.next', 
            'coverage', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj'
        ];
        const excludePattern = excludeDirs.map(dir => `--exclude-dir=${dir}`).join(' ');
        
        const cmd = `grep -rniE "${pattern}" ${includePattern} ${excludePattern} -B 2 -A 5 "${workspaceRoot}" 2>/dev/null | head -500`;
        
        outputChannel.appendLine(`Executing: grep -rniE "${pattern}" ...`);
        
        cp.exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && !stdout) {
                resolve({ query: keywords.join(' '), keywords, results: [], totalMatches: 0 });
                return;
            }
            
            const lines = stdout.split('\n');
            const results = [];
            let currentResult = null;
            let totalMatches = 0;
            
            for (const line of lines) {
                if (line === '--') {
                    if (currentResult) {
                        results.push(currentResult);
                        currentResult = null;
                    }
                    continue;
                }
                
                const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
                const contextLine = line.match(/^(.+?)-(\d+)-(.*)$/);
                
                if (matchLine) {
                    const [, file, lineNum, content] = matchLine;
                    totalMatches++;
                    
                    if (!currentResult || currentResult.file !== file) {
                        if (currentResult) {
                            results.push(currentResult);
                        }
                        currentResult = {
                            file,
                            line: parseInt(lineNum),
                            content: content.trim(),
                            context: []
                        };
                    } else {
                        currentResult.context.push(content.trim());
                    }
                } else if (contextLine && currentResult) {
                    currentResult.context.push(contextLine[3].trim());
                }
            }
            
            if (currentResult) {
                results.push(currentResult);
            }
            
            const dedupedResults = dedupeResults(results);
            
            resolve({
                query: keywords.join(' '),
                keywords,
                results: dedupedResults.slice(0, 30),
                totalMatches
            });
        });
    });
}

function dedupeResults(results) {
    const seen = new Map();
    
    for (const result of results) {
        const key = `${result.file}:${Math.floor(result.line / 20)}`;
        
        if (!seen.has(key)) {
            seen.set(key, result);
        } else {
            const existing = seen.get(key);
            existing.context.push(...result.context);
        }
    }
    
    return Array.from(seen.values());
}

function formatContextForLLM(searchResults) {
    const sections = [];
    
    const byFile = new Map();
    for (const result of searchResults.results) {
        const existing = byFile.get(result.file) || [];
        existing.push(result);
        byFile.set(result.file, existing);
    }
    
    for (const [file, results] of byFile) {
        const fileName = path.basename(file);
        const ext = path.extname(file).slice(1) || 'txt';
        
        let fileSection = `\n### File: ${fileName}\n`;
        fileSection += `Path: ${file}\n\n`;
        
        for (const result of results.slice(0, 5)) {
            const allLines = [result.content, ...result.context].filter(Boolean);
            const snippet = allLines.slice(0, 10).join('\n');
            
            fileSection += `**Line ${result.line}:**\n\`\`\`${ext}\n${snippet}\n\`\`\`\n\n`;
        }
        
        sections.push(fileSection);
    }
    
    let combined = sections.join('\n');
    if (combined.length > 8000) {
        combined = combined.slice(0, 8000) + '\n\n... (truncated)';
    }
    
    return combined;
}

function buildSystemPrompt() {
    return `You are AstraCode, an expert code analyst. You help developers understand codebases by analyzing grep search results and providing clear, actionable explanations.

Guidelines:
- Focus on answering the user's specific question
- Reference specific files and line numbers when relevant
- Explain code flow and relationships between components
- Highlight important patterns, potential issues, or key logic
- Be concise but thorough
- If the search results don't contain enough information to fully answer, say so`;
}

function buildUserPrompt(query, context) {
    return `## User Question
${query}

## Relevant Code from Codebase
${context}

## Instructions
Based on the code snippets above, please answer the user's question. Reference specific files and line numbers where relevant.`;
}

function deactivate() {}

module.exports = { activate, deactivate };
