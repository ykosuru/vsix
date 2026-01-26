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

// Important pattern files for Java projects
const PATTERN_FILES = [
    'Service.java', 'ServiceImpl.java', 'Handler.java', 'Controller.java',
    'Processor.java', 'Validator.java', 'Mapper.java', 'Repository.java',
    'Entity.java', 'Model.java', 'Exception.java'
];

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
    
    // Get directory structure first (important for understanding project)
    const structure = getProjectStructure(workspaceRoot);
    
    // Find matching files
    const matches = await searchFiles(workspaceRoot, terms, maxFiles * 3);
    
    // Also find pattern files (services, models, etc.)
    const patternFiles = await findPatternFiles(workspaceRoot, terms);
    
    // Merge and dedupe
    const allMatches = [...matches];
    for (const pf of patternFiles) {
        if (!allMatches.find(m => m.path === pf.path)) {
            allMatches.push(pf);
        }
    }
    
    console.log(`[AstraCode] Found ${allMatches.length} matching files (${patternFiles.length} pattern files)`);
    
    // Score and sort files
    const scoredFiles = scoreFiles(allMatches, terms);
    const topFiles = scoredFiles.slice(0, maxFiles);
    
    // Build context string with structure first
    let context = '';
    let totalLines = 0;
    const includedFiles = [];
    
    // Add project structure overview
    if (structure.length > 0) {
        context += `## Project Structure\n\`\`\`\n${structure.join('\n')}\n\`\`\`\n\n`;
    }
    
    context += `## Relevant Source Files\n\n`;
    
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
 * Get project directory structure (key folders)
 */
function getProjectStructure(rootPath, depth = 2) {
    const result = [];
    
    function scan(dirPath, currentDepth, prefix = '') {
        if (currentDepth > depth) return;
        
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
                .sort((a, b) => {
                    // Directories first
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.name.localeCompare(b.name);
                });
        } catch (e) {
            return;
        }
        
        for (const entry of entries.slice(0, 20)) {
            const isLast = entries.indexOf(entry) === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const nextPrefix = prefix + (isLast ? '    ' : '│   ');
            
            if (entry.isDirectory()) {
                result.push(`${prefix}${connector}${entry.name}/`);
                scan(path.join(dirPath, entry.name), currentDepth + 1, nextPrefix);
            } else {
                result.push(`${prefix}${connector}${entry.name}`);
            }
        }
    }
    
    scan(rootPath, 0);
    return result.slice(0, 50); // Limit structure output
}

/**
 * Find pattern files (services, models, controllers)
 */
async function findPatternFiles(rootPath, terms) {
    const results = [];
    const seenPaths = new Set();
    
    function scanForPatterns(dirPath, depth = 0) {
        if (depth > 6 || results.length >= 20) return;
        
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
                    // Prioritize certain directories
                    const dirName = entry.name.toLowerCase();
                    if (['service', 'model', 'domain', 'handler', 'processor', 'api', 'controller'].includes(dirName)) {
                        scanForPatterns(fullPath, depth); // Don't increment depth
                    } else {
                        scanForPatterns(fullPath, depth + 1);
                    }
                }
            } else if (entry.isFile() && !seenPaths.has(fullPath)) {
                const name = entry.name;
                
                // Check if it's a pattern file
                for (const pattern of PATTERN_FILES) {
                    if (name.endsWith(pattern)) {
                        seenPaths.add(fullPath);
                        results.push({ 
                            path: fullPath, 
                            matchedTerm: pattern.replace('.java', ''),
                            isPattern: true
                        });
                        break;
                    }
                }
            }
        }
    }
    
    scanForPatterns(rootPath);
    return results;
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
        
        // Boost pattern files (services, models, etc.)
        if (file.isPattern) score += 25;
        
        // Boost key directories
        if (pathLower.includes('/service/')) score += 20;
        if (pathLower.includes('/model/')) score += 20;
        if (pathLower.includes('/domain/')) score += 20;
        if (pathLower.includes('/handler/')) score += 15;
        if (pathLower.includes('/api/')) score += 15;
        
        // Boost implementations and interfaces
        if (name.endsWith('impl.java')) score += 15;
        if (name.endsWith('service.java')) score += 15;
        
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
