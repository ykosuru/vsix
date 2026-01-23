/**
 * Workspace search - finds relevant files and loads content for prompts
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const CODE_EXTENSIONS = new Set([
    '.c', '.h', '.cpp', '.hpp', '.java', '.py', '.js', '.ts', '.go', '.rs',
    '.rb', '.php', '.swift', '.kt', '.scala', '.sql', '.sh', '.tal', '.cbl'
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'target', 'out', '.idea', 
    '.vscode', '__pycache__', '.next', 'vendor', 'coverage', 'bin', 'obj'
]);

/**
 * Search workspace and return context string for prompt
 */
async function getWorkspaceContext(query, options = {}) {
    const maxFiles = options.maxFiles || 15;
    const maxLinesPerFile = options.maxLinesPerFile || 400;
    const maxTotalLines = options.maxTotalLines || 3000;
    
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return { context: '', files: [] };
    }
    
    // Extract search terms
    const terms = extractSearchTerms(query);
    
    console.log(`[AstraCode] Searching for: ${terms.join(', ')}`);
    
    // Find matching files
    const matches = await searchFiles(workspaceRoot, terms, maxFiles * 3);
    
    console.log(`[AstraCode] Found ${matches.length} matching files`);
    
    // Score and sort files
    const scoredFiles = scoreFiles(matches, terms);
    const topFiles = scoredFiles.slice(0, maxFiles);
    
    // Build context string
    let context = '';
    let totalLines = 0;
    const includedFiles = [];
    
    for (const file of topFiles) {
        if (totalLines >= maxTotalLines) break;
        
        try {
            const content = fs.readFileSync(file.path, 'utf8');
            const lines = content.split('\n');
            const linesToInclude = Math.min(lines.length, maxLinesPerFile);
            
            const relativePath = path.relative(workspaceRoot, file.path);
            const ext = path.extname(file.path).slice(1) || 'txt';
            
            // Number lines for reference
            const numberedLines = lines.slice(0, linesToInclude)
                .map((line, i) => `${i + 1}: ${line}`)
                .join('\n');
            
            context += `\n### File: ${relativePath}\n\`\`\`${ext}\n${numberedLines}\n\`\`\`\n`;
            
            totalLines += linesToInclude;
            includedFiles.push({
                path: relativePath,
                lines: linesToInclude,
                score: file.score
            });
            
        } catch (e) {
            // Skip unreadable files
        }
    }
    
    console.log(`[AstraCode] Loaded ${includedFiles.length} files, ${totalLines} lines`);
    
    return {
        context,
        files: includedFiles,
        totalLines,
        searchTerms: terms
    };
}

/**
 * Extract search terms from query
 */
function extractSearchTerms(query) {
    const words = query.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length >= 3)
        .map(w => w.replace(/[^a-z0-9_]/g, ''));
    
    // Create compound terms for C-style naming
    const compounds = [];
    for (let i = 0; i < words.length - 1; i++) {
        // "partition pruning" → "partprune", "partition_pruning"
        compounds.push(words[i].slice(0, 4) + words[i + 1].slice(0, 5));
        compounds.push(words[i] + '_' + words[i + 1]);
    }
    
    // Add root forms (remove common suffixes)
    const roots = words.map(w => 
        w.replace(/(ing|tion|tions|ness|ment|s)$/, '').replace(/e$/, '')
    ).filter(w => w.length >= 3);
    
    return [...new Set([...compounds, ...words, ...roots])];
}

/**
 * Search files in workspace
 */
async function searchFiles(rootPath, terms, maxResults) {
    const results = [];
    const seenPaths = new Set();
    
    function scanDir(dirPath, depth = 0) {
        if (depth > 8 || results.length >= maxResults) return;
        
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (e) {
            return;
        }
        
        for (const entry of entries) {
            if (results.length >= maxResults) return;
            if (entry.name.startsWith('.')) continue;
            
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    scanDir(fullPath, depth + 1);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) continue;
                
                // Check if filename matches any term
                const nameLower = entry.name.toLowerCase();
                const pathLower = fullPath.toLowerCase();
                
                for (const term of terms) {
                    if (nameLower.includes(term) || pathLower.includes(term)) {
                        if (!seenPaths.has(fullPath)) {
                            seenPaths.add(fullPath);
                            results.push({ path: fullPath, matchedTerm: term });
                        }
                        break;
                    }
                }
                
                // Also check file content for first few terms
                if (!seenPaths.has(fullPath) && terms.length > 0) {
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.size > 500000) continue; // Skip large files
                        
                        const content = fs.readFileSync(fullPath, 'utf8');
                        for (const term of terms.slice(0, 3)) {
                            if (content.toLowerCase().includes(term)) {
                                seenPaths.add(fullPath);
                                results.push({ path: fullPath, matchedTerm: term });
                                break;
                            }
                        }
                    } catch (e) {
                        // Skip unreadable
                    }
                }
            }
        }
    }
    
    scanDir(rootPath);
    return results;
}

/**
 * Score files by relevance
 */
function scoreFiles(files, terms) {
    return files.map(file => {
        let score = 10;
        const pathLower = file.path.toLowerCase();
        const name = path.basename(file.path).toLowerCase();
        
        // Boost for filename match
        for (const term of terms) {
            if (name.includes(term)) score += 30;
            if (pathLower.includes(term)) score += 10;
        }
        
        // Boost source files
        if (pathLower.includes('/src/')) score += 15;
        if (!pathLower.includes('test')) score += 10;
        
        // Penalize docs
        if (pathLower.includes('readme') || pathLower.includes('/docs/')) {
            score -= 20;
        }
        
        return { ...file, score };
    }).sort((a, b) => b.score - a.score);
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

module.exports = {
    getWorkspaceContext,
    extractSearchTerms,
    getWorkspaceRoot
};
