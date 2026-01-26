/**
 * /stats command - Show workspace and attachment statistics
 * 
 * Usage:
 * @astra /stats                - Show workspace stats
 * [Attach files] @astra /stats - Show workspace + attachment stats
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const CODE_EXTENSIONS = new Set([
    '.c', '.h', '.cpp', '.hpp', '.java', '.py', '.js', '.ts', '.go', '.rs',
    '.rb', '.php', '.swift', '.kt', '.scala', '.sql', '.sh', '.tal', '.cbl',
    '.cobol', '.pli', '.jcl', '.asm', '.xml', '.json', '.yaml', '.yml'
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'target', 'out', '.idea',
    '.vscode', '__pycache__', '.next', 'vendor', 'coverage', 'bin', 'obj'
]);

/**
 * Scan workspace and collect stats
 */
function scanWorkspace(rootPath) {
    const stats = {
        totalFiles: 0,
        totalLines: 0,
        totalSize: 0,
        byExtension: {},
        byDirectory: {},
        largestFiles: []
    };
    
    function scanDir(dirPath, depth = 0) {
        if (depth > 10) return;
        
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (e) {
            return;
        }
        
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    scanDir(fullPath, depth + 1);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase() || '(no ext)';
                
                try {
                    const stat = fs.statSync(fullPath);
                    const size = stat.size;
                    
                    // Skip very large files
                    if (size > 10 * 1024 * 1024) continue;
                    
                    stats.totalFiles++;
                    stats.totalSize += size;
                    
                    // By extension
                    if (!stats.byExtension[ext]) {
                        stats.byExtension[ext] = { count: 0, lines: 0, size: 0 };
                    }
                    stats.byExtension[ext].count++;
                    stats.byExtension[ext].size += size;
                    
                    // By directory (top-level)
                    const relPath = path.relative(rootPath, dirPath);
                    const topDir = relPath.split(path.sep)[0] || '(root)';
                    if (!stats.byDirectory[topDir]) {
                        stats.byDirectory[topDir] = { count: 0, size: 0 };
                    }
                    stats.byDirectory[topDir].count++;
                    stats.byDirectory[topDir].size += size;
                    
                    // Count lines for code files
                    if (CODE_EXTENSIONS.has(ext) && size < 1024 * 1024) {
                        try {
                            const content = fs.readFileSync(fullPath, 'utf8');
                            const lines = content.split('\n').length;
                            stats.totalLines += lines;
                            stats.byExtension[ext].lines += lines;
                            
                            // Track largest files
                            stats.largestFiles.push({
                                path: path.relative(rootPath, fullPath),
                                lines,
                                size
                            });
                        } catch (e) {
                            // Skip unreadable
                        }
                    }
                } catch (e) {
                    // Skip inaccessible
                }
            }
        }
    }
    
    scanDir(rootPath);
    
    // Sort largest files
    stats.largestFiles.sort((a, b) => b.lines - a.lines);
    stats.largestFiles = stats.largestFiles.slice(0, 10);
    
    return stats;
}

/**
 * Analyze attachments
 */
async function analyzeAttachments(references, outputChannel) {
    const stats = {
        count: 0,
        totalSize: 0,
        totalLines: 0,
        files: []
    };
    
    if (!references?.length) return stats;
    
    for (const ref of references) {
        try {
            if (ref.id && typeof ref.id === 'string') {
                const uri = vscode.Uri.parse(ref.id);
                const data = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(data).toString('utf8');
                const fileName = uri.path.split('/').pop();
                const ext = path.extname(fileName).toLowerCase();
                const lines = content.split('\n').length;
                const size = data.length;
                
                stats.count++;
                stats.totalSize += size;
                stats.totalLines += lines;
                stats.files.push({ name: fileName, ext, lines, size });
            }
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
        }
    }
    
    return stats;
}

/**
 * Format bytes to human readable
 */
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format number with commas
 */
function formatNumber(num) {
    return num.toLocaleString();
}

async function handle(ctx) {
    const { response, outputChannel, request } = ctx;
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const hasWorkspace = workspaceFolders && workspaceFolders.length > 0;
    const hasAttachments = request?.references?.length > 0;
    
    if (!hasWorkspace && !hasAttachments) {
        response.markdown(`⚠️ **No workspace or attachments to analyze.**

Open a folder in VS Code or attach files to see statistics.
`);
        return;
    }
    
    response.markdown(`## 📊 Statistics\n\n`);
    
    // Workspace stats
    if (hasWorkspace) {
        response.progress('Scanning workspace...');
        const rootPath = workspaceFolders[0].uri.fsPath;
        const workspaceName = workspaceFolders[0].name;
        const stats = scanWorkspace(rootPath);
        
        response.markdown(`### 📁 Workspace: ${workspaceName}

| Metric | Value |
|--------|-------|
| **Total Files** | ${formatNumber(stats.totalFiles)} |
| **Lines of Code** | ${formatNumber(stats.totalLines)} |
| **Total Size** | ${formatSize(stats.totalSize)} |

`);
        
        // By extension (top 10)
        const extSorted = Object.entries(stats.byExtension)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);
        
        if (extSorted.length > 0) {
            let extTable = `**By File Type:**\n\n| Extension | Files | Lines | Size |\n|-----------|-------|-------|------|\n`;
            for (const [ext, data] of extSorted) {
                extTable += `| \`${ext}\` | ${formatNumber(data.count)} | ${formatNumber(data.lines)} | ${formatSize(data.size)} |\n`;
            }
            response.markdown(extTable + '\n');
        }
        
        // By directory (top 8)
        const dirSorted = Object.entries(stats.byDirectory)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8);
        
        if (dirSorted.length > 0) {
            let dirTable = `**By Directory:**\n\n| Directory | Files | Size |\n|-----------|-------|------|\n`;
            for (const [dir, data] of dirSorted) {
                dirTable += `| \`${dir}\` | ${formatNumber(data.count)} | ${formatSize(data.size)} |\n`;
            }
            response.markdown(dirTable + '\n');
        }
        
        // Largest files
        if (stats.largestFiles.length > 0) {
            let largeTable = `**Largest Files (by lines):**\n\n| File | Lines |\n|------|-------|\n`;
            for (const file of stats.largestFiles.slice(0, 5)) {
                largeTable += `| \`${file.path}\` | ${formatNumber(file.lines)} |\n`;
            }
            response.markdown(largeTable + '\n');
        }
    }
    
    // Attachment stats
    if (hasAttachments) {
        const attachStats = await analyzeAttachments(request.references, outputChannel);
        
        response.markdown(`### 📎 Attachments

| Metric | Value |
|--------|-------|
| **Files** | ${attachStats.count} |
| **Total Lines** | ${formatNumber(attachStats.totalLines)} |
| **Total Size** | ${formatSize(attachStats.totalSize)} |

`);
        
        if (attachStats.files.length > 0) {
            let fileTable = `**Attached Files:**\n\n| File | Lines | Size |\n|------|-------|------|\n`;
            for (const file of attachStats.files) {
                fileTable += `| \`${file.name}\` | ${formatNumber(file.lines)} | ${formatSize(file.size)} |\n`;
            }
            response.markdown(fileTable + '\n');
        }
    }
    
    response.markdown(`---
*Use \`@astra /find <term>\` to search for specific code.*
`);
}

module.exports = { handle };
