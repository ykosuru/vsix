/**
 * /sources command - Configure input sources via Quick Pick
 * 
 * Usage:
 * @astra /sources /requirements OFAC     - Pick sources, then run /requirements
 * @astra /sources /deepwiki              - Pick sources, then run /deepwiki
 * @astra /sources                        - Just configure (shows current settings)
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Store selected sources (persists during session)
let selectedSources = {
    workspace: true,
    attachments: true,
    history: false,
    historyCount: 5,
    confluence: false,
    confluencePages: '',
    files: false,
    selectedFiles: []  // Array of file paths
};

/**
 * Show file picker dialog
 */
async function showFilePicker() {
    const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: 'Select Files',
        title: 'Select files for analysis',
        filters: {
            'Documents': ['pdf', 'docx', 'doc', 'txt', 'md', 'csv'],
            'Code': ['js', 'ts', 'java', 'py', 'c', 'cpp', 'h', 'go', 'rs', 'tal', 'cob', 'cbl'],
            'Config': ['json', 'xml', 'yml', 'yaml', 'properties'],
            'All Files': ['*']
        }
    });
    
    return files ? files.map(f => f.fsPath) : [];
}

/**
 * Read file contents
 */
async function readFileContents(filePaths, outputChannel) {
    let content = '';
    const maxChars = 30000; // Per file limit
    
    for (const filePath of filePaths) {
        try {
            const fileName = path.basename(filePath);
            const data = fs.readFileSync(filePath, 'utf8');
            const truncated = data.length > maxChars 
                ? data.slice(0, maxChars) + '\n... [truncated]' 
                : data;
            
            content += `\n### File: ${fileName}\n\`\`\`\n${truncated}\n\`\`\`\n`;
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] Error reading ${filePath}: ${e.message}`);
            content += `\n### File: ${path.basename(filePath)}\n*Error: Could not read file*\n`;
        }
    }
    
    return content;
}

/**
 * Show Quick Pick for source selection
 */
async function showSourcePicker() {
    const filesSummary = selectedSources.selectedFiles.length > 0 
        ? `${selectedSources.selectedFiles.length} file(s) selected`
        : 'Browse file system';
    
    const items = [
        { 
            label: '🔍 Workspace', 
            description: 'Search code files in open folder',
            id: 'workspace',
            picked: selectedSources.workspace 
        },
        { 
            label: '📎 Attachments', 
            description: 'Use files attached to chat',
            id: 'attachments',
            picked: selectedSources.attachments 
        },
        { 
            label: '📜 History', 
            description: `Use last ${selectedSources.historyCount} responses`,
            id: 'history',
            picked: selectedSources.history 
        },
        { 
            label: '🔗 Confluence', 
            description: selectedSources.confluencePages || 'Read from Confluence pages',
            id: 'confluence',
            picked: selectedSources.confluence 
        },
        { 
            label: '📂 Files', 
            description: filesSummary,
            id: 'files',
            picked: selectedSources.files 
        }
    ];
    
    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select input sources (Space to toggle, Enter to confirm)',
        title: 'AstraCode - Input Sources'
    });
    
    if (!selected) {
        return null; // Cancelled
    }
    
    // Update selections
    const selectedIds = selected.map(s => s.id);
    selectedSources.workspace = selectedIds.includes('workspace');
    selectedSources.attachments = selectedIds.includes('attachments');
    selectedSources.history = selectedIds.includes('history');
    selectedSources.confluence = selectedIds.includes('confluence');
    selectedSources.files = selectedIds.includes('files');
    
    // If history selected, ask for count
    if (selectedSources.history) {
        const countInput = await vscode.window.showInputBox({
            prompt: 'How many previous responses to include?',
            value: String(selectedSources.historyCount),
            validateInput: (v) => {
                const n = parseInt(v, 10);
                if (isNaN(n) || n < 1 || n > 10) {
                    return 'Enter a number between 1 and 10';
                }
                return null;
            }
        });
        if (countInput) {
            selectedSources.historyCount = parseInt(countInput, 10);
        }
    }
    
    // If Confluence selected, ask for pages
    if (selectedSources.confluence) {
        const pagesInput = await vscode.window.showInputBox({
            prompt: 'Enter Confluence page title(s) or URL (comma-separated)',
            value: selectedSources.confluencePages,
            placeHolder: 'e.g., API Spec, Design Doc'
        });
        if (pagesInput !== undefined) {
            selectedSources.confluencePages = pagesInput;
        }
    }
    
    // If Files selected, open file picker
    if (selectedSources.files) {
        const files = await showFilePicker();
        if (files.length > 0) {
            selectedSources.selectedFiles = files;
        } else if (selectedSources.selectedFiles.length === 0) {
            // No files selected and none previously - disable
            selectedSources.files = false;
        }
    }
    
    return selectedSources;
}

/**
 * Get current source configuration summary
 */
function getSourcesSummary(sources) {
    const active = [];
    if (sources.workspace) active.push('🔍 Workspace');
    if (sources.attachments) active.push('📎 Attachments');
    if (sources.history) active.push(`📜 History (${sources.historyCount})`);
    if (sources.confluence) active.push(`🔗 Confluence`);
    if (sources.files && sources.selectedFiles.length > 0) {
        active.push(`📂 Files (${sources.selectedFiles.length})`);
    }
    return active.length > 0 ? active.join(', ') : 'None selected';
}

/**
 * Extract history content
 */
function extractHistoryContent(chatContext, count) {
    let content = '';
    let extracted = 0;
    
    if (!chatContext?.history?.length) return '';
    
    for (let i = chatContext.history.length - 1; i >= 0 && extracted < count; i--) {
        const turn = chatContext.history[i];
        const userPrompt = turn.prompt || '';
        let responseText = '';
        
        if (turn.response?.length > 0) {
            for (const part of turn.response) {
                if (part.value && typeof part.value === 'string') {
                    responseText += part.value;
                } else if (part.value?.value) {
                    responseText += part.value.value;
                }
            }
        }
        
        if (responseText.length > 50) {
            const turnContent = `### Turn ${extracted + 1}\n**User:** ${userPrompt}\n\n**Response:**\n${responseText}\n\n---\n\n`;
            content = turnContent + content;
            extracted++;
        }
    }
    
    return content;
}

async function handle(ctx) {
    const { query, response, outputChannel, chatContext, confluenceAuth } = ctx;
    
    // Show picker
    const sources = await showSourcePicker();
    
    if (!sources) {
        response.markdown(`❌ **Cancelled.** No changes made.`);
        return;
    }
    
    // Build file list for display
    let filesDisplay = '⬜ Disabled';
    if (sources.files && sources.selectedFiles.length > 0) {
        const fileNames = sources.selectedFiles.map(f => path.basename(f));
        if (fileNames.length <= 3) {
            filesDisplay = `✅ ${fileNames.join(', ')}`;
        } else {
            filesDisplay = `✅ ${fileNames.slice(0, 2).join(', ')} +${fileNames.length - 2} more`;
        }
    }
    
    // Show selected sources
    response.markdown(`## ⚙️ Input Sources Configured

**Active:** ${getSourcesSummary(sources)}

| Source | Status |
|--------|--------|
| 🔍 Workspace | ${sources.workspace ? '✅ Enabled' : '⬜ Disabled'} |
| 📎 Attachments | ${sources.attachments ? '✅ Enabled' : '⬜ Disabled'} |
| 📜 History | ${sources.history ? `✅ Last ${sources.historyCount}` : '⬜ Disabled'} |
| 🔗 Confluence | ${sources.confluence ? `✅ ${sources.confluencePages || '(no pages)'}` : '⬜ Disabled'} |
| 📂 Files | ${filesDisplay} |

`);

    // Build piped content based on selections
    let pipedContent = '';
    
    // Add history if selected
    if (sources.history) {
        const histContent = extractHistoryContent(chatContext, sources.historyCount);
        if (histContent) {
            pipedContent += `## From Chat History (Last ${sources.historyCount})\n\n${histContent}\n\n`;
            response.markdown(`📜 *Loaded ${sources.historyCount} responses from history*\n\n`);
        }
    }
    
    // Add selected files if any
    if (sources.files && sources.selectedFiles.length > 0) {
        response.progress('Reading selected files...');
        const filesContent = await readFileContents(sources.selectedFiles, outputChannel);
        if (filesContent) {
            pipedContent += `## From Selected Files (${sources.selectedFiles.length})\n\n${filesContent}\n\n`;
            response.markdown(`📂 *Loaded ${sources.selectedFiles.length} files*\n\n`);
            
            // Show file list
            response.markdown(`<details><summary>📂 Selected files</summary>\n\n`);
            for (const f of sources.selectedFiles) {
                response.markdown(`- \`${path.basename(f)}\`\n`);
            }
            response.markdown(`\n</details>\n\n`);
        }
    }
    
    // Add Confluence if selected
    if (sources.confluence && sources.confluencePages && confluenceAuth) {
        response.markdown(`🔗 *Confluence pages will be loaded by the next command*\n\n`);
        // Store for next command to use
        ctx.confluencePages = sources.confluencePages;
    }
    
    // Set piped content
    ctx.pipedContent = pipedContent;
    
    // Store source config for next command
    ctx.sourceConfig = sources;
    
    // Show next steps
    if (!query.trim()) {
        response.markdown(`---
**Now run a command:**
\`\`\`
@astra /requirements <topic>
@astra /deepwiki <topic>
@astra /fediso <topic>
\`\`\`

Or chain: \`@astra /sources /requirements OFAC /gencode\`
`);
    }
}

// Export selected sources for other commands to access
function getSelectedSources() {
    return { ...selectedSources };
}

function setSelectedSources(sources) {
    selectedSources = { ...selectedSources, ...sources };
}

module.exports = { 
    handle, 
    showSourcePicker, 
    getSelectedSources, 
    setSelectedSources,
    getSourcesSummary,
    extractHistoryContent,
    readFileContents
};
