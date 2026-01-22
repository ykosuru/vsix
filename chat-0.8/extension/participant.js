/**
 * AstraCode Chat Participant
 * 
 * Supports command chaining with pipe syntax:
 *   @astra /requirements OFAC screening /fediso
 *   @astra /describe payment flow /deepwiki
 */

const vscode = require('vscode');
const { getHandler, PIPELINE_COMMANDS, hasCommand } = require('./commands');
const { streamResponse } = require('./llm/copilot');

let outputChannel = null;

/**
 * Parse command chain from query
 * "@astra /requirements OFAC screening /fediso" 
 * → [{ command: 'requirements', query: 'OFAC screening' }, { command: 'fediso', query: '' }]
 */
function parseCommandChain(command, prompt) {
    const chain = [];
    
    // First command from request.command
    let currentCmd = command || '';
    let remaining = prompt || '';
    
    // Check if prompt contains additional /commands
    const pipeMatch = remaining.match(/^(.+?)\s+(\/\w+)(.*)$/);
    
    if (pipeMatch) {
        // Found a pipe: "/requirements OFAC screening /fediso"
        const query = pipeMatch[1].trim();
        const nextCmd = pipeMatch[2].slice(1); // remove leading /
        const rest = pipeMatch[3].trim();
        
        chain.push({ command: currentCmd, query });
        
        // Parse remaining chain
        if (hasCommand(nextCmd)) {
            chain.push({ command: nextCmd, query: rest });
        }
    } else {
        // Single command
        chain.push({ command: currentCmd, query: remaining });
    }
    
    return chain;
}

/**
 * Main request handler
 */
async function handleRequest(request, chatContext, response, token, channel, getWorkspaceRoot) {
    if (channel) {
        outputChannel = channel;
    }
    
    const command = request.command || '';
    const prompt = request.prompt || '';
    
    // Parse for command chaining
    const chain = parseCommandChain(command, prompt);
    
    log(`Request: ${chain.map(c => `/${c.command || 'general'} ${c.query.slice(0, 20)}`).join(' → ')}`);
    
    const workspaceRoot = getWorkspaceRoot ? getWorkspaceRoot() : getDefaultWorkspaceRoot();
    
    // Handle utility commands (no chaining)
    if (chain.length === 1 && chain[0].command === 'help') {
        const handler = getHandler('help');
        return handler({ query: chain[0].query, response, outputChannel });
    }
    
    if (chain.length === 1 && chain[0].command === 'stats') {
        response.progress('Scanning workspace...');
        return showWorkspaceStats(response, workspaceRoot);
    }
    
    // Execute command chain
    let previousOutput = null;
    
    for (let i = 0; i < chain.length; i++) {
        const { command: cmd, query } = chain[i];
        const isLast = i === chain.length - 1;
        const isPiped = i > 0;
        
        if (isPiped) {
            response.markdown(`\n\n---\n## 🔗 Piping to /${cmd}\n\n`);
        }
        
        const ctx = {
            query: query || chain[0].query, // Use first query if piped command has none
            response,
            outputChannel,
            workspaceRoot,
            token,
            request,
            previousOutput,  // Output from previous command in chain
            isPiped,
            context: null,
            contextStats: null
        };
        
        const handler = getHandler(cmd);
        
        // Capture output for piping
        if (!isLast) {
            // For intermediate commands, we need to capture the output
            // For now, just run them and the next command will use workspace search
            await handler(ctx);
            // Mark that we piped (next command will know)
            previousOutput = { command: cmd, query: ctx.query };
        } else {
            await handler(ctx);
        }
    }
}

/**
 * Show workspace statistics
 */
async function showWorkspaceStats(response, workspaceRoot) {
    const fs = require('fs');
    const path = require('path');
    
    const stats = {
        totalFiles: 0,
        totalLines: 0,
        totalBytes: 0,
        languages: {}
    };
    
    const EXT_TO_LANG = {
        '.c': 'C', '.h': 'C Header', '.cpp': 'C++', '.hpp': 'C++ Header',
        '.java': 'Java', '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript',
        '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP',
        '.swift': 'Swift', '.kt': 'Kotlin', '.scala': 'Scala', '.sql': 'SQL',
        '.sh': 'Shell', '.tal': 'TAL', '.cbl': 'COBOL', '.cob': 'COBOL',
        '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML'
    };
    
    const SKIP_DIRS = new Set([
        'node_modules', '.git', 'dist', 'build', 'target', 'out',
        '.idea', '.vscode', '__pycache__', '.next', 'vendor'
    ]);
    
    function scanDir(dirPath, depth = 0) {
        if (depth > 10) return;
        
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (e) { return; }
        
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    scanDir(fullPath, depth + 1);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const lang = EXT_TO_LANG[ext];
                
                if (lang) {
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.size > 1000000) continue;
                        
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split('\n').length;
                        
                        stats.totalFiles++;
                        stats.totalLines += lines;
                        stats.totalBytes += stat.size;
                        
                        if (!stats.languages[lang]) {
                            stats.languages[lang] = { files: 0, lines: 0 };
                        }
                        stats.languages[lang].files++;
                        stats.languages[lang].lines += lines;
                    } catch (e) {}
                }
            }
        }
    }
    
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0 && workspaceRoot) {
        scanDir(workspaceRoot);
    } else {
        for (const folder of folders) {
            scanDir(folder.uri.fsPath);
        }
    }
    
    const sortedLangs = Object.entries(stats.languages)
        .sort((a, b) => b[1].lines - a[1].lines);
    
    const sizeKB = (stats.totalBytes / 1024).toFixed(1);
    const sizeMB = (stats.totalBytes / (1024 * 1024)).toFixed(2);
    const sizeStr = stats.totalBytes > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
    
    let md = `## 📊 Workspace Statistics

**Root:** \`${workspaceRoot || 'No workspace'}\`

| Metric | Value |
|--------|-------|
| **Total Files** | ${stats.totalFiles.toLocaleString()} |
| **Total Lines** | ${stats.totalLines.toLocaleString()} |
| **Total Size** | ${sizeStr} |

### Languages

| Language | Files | Lines |
|----------|------:|------:|
`;
    
    for (const [lang, data] of sortedLangs.slice(0, 15)) {
        md += `| ${lang} | ${data.files.toLocaleString()} | ${data.lines.toLocaleString()} |\n`;
    }
    
    response.markdown(md);
}

function getDefaultWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function log(msg) {
    if (outputChannel) {
        outputChannel.appendLine(`[AstraCode] ${msg}`);
    }
    console.log(`[AstraCode] ${msg}`);
}

function clearIndex() {}

module.exports = { handleRequest, clearIndex };
