/**
 * AstraCode File Utilities
 * File operations, language detection, and binary file handling
 */

const vscode = require('vscode');
const { log } = require('./logging');
const pathUtils = require('./pathUtils');

// ============================================================
// Language Detection
// ============================================================

/**
 * Detect language from file path
 */
function detectLanguage(filePath) {
    // Get just the filename (works on both Windows and Unix)
    const fileName = pathUtils.getFileName(filePath);
    
    // Check for known names without extensions
    const knownNames = {
        'readme': 'text',
        'makefile': 'makefile',
        'dockerfile': 'dockerfile',
        'license': 'text',
        'authors': 'text',
        'changelog': 'text',
        'contributing': 'text',
        'gitignore': 'config',
        'gitattributes': 'config',
        'editorconfig': 'config'
    };
    
    const lowerName = fileName.toLowerCase();
    if (knownNames[lowerName]) {
        return knownNames[lowerName];
    }
    
    // Check for extension
    const parts = fileName.split('.');
    if (parts.length < 2) {
        return 'text'; // No extension, default to text
    }
    
    const ext = parts.pop().toLowerCase();
    const langMap = {
        // Legacy - COBOL
        'cbl': 'cobol', 'cob': 'cobol', 'cobol': 'cobol', 'cpy': 'cobol', 'pco': 'cobol',
        // Legacy - TAL/TACL
        'tal': 'tal', 'tacl': 'tacl', 'tac': 'tacl',
        // C family
        'c': 'c', 'h': 'c',
        'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
        // Java/JVM
        'java': 'java', 'scala': 'scala', 'kt': 'kotlin', 'groovy': 'groovy',
        // C#/.NET
        'cs': 'csharp', 'csx': 'csharp',
        // Python
        'py': 'python', 'pyw': 'python', 'pyx': 'python',
        // JavaScript/TypeScript
        'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
        'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
        // SQL variants
        'sql': 'sql', 'ddl': 'sql', 'dml': 'sql', 'prc': 'sql', 'fnc': 'sql',
        'pks': 'sql', 'pkb': 'sql', 'trg': 'sql', 'vw': 'sql',
        // Web
        'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'scss', 'sass': 'sass',
        // Data
        'json': 'json', 'xml': 'xml', 'yaml': 'yaml', 'yml': 'yaml',
        'csv': 'csv', 'tsv': 'tsv',
        // Shell/Scripts
        'sh': 'bash', 'bash': 'bash', 'zsh': 'zsh', 'fish': 'fish',
        'ps1': 'powershell', 'bat': 'batch', 'cmd': 'batch',
        // Other languages
        'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php',
        'swift': 'swift', 'fs': 'fsharp', 'vb': 'vb',
        'pl': 'perl', 'r': 'r', 'lua': 'lua',
        // Parser generators
        'y': 'yacc', 'l': 'lex',
        // Config
        'md': 'markdown', 'txt': 'text', 'log': 'log',
        'ini': 'ini', 'cfg': 'ini', 'conf': 'ini', 'properties': 'properties',
        'toml': 'toml', 'env': 'env',
        // Documents
        'pdf': 'pdf', 'doc': 'document', 'docx': 'document', 'rtf': 'document'
    };
    return langMap[ext] || ext || 'text';
}

/**
 * Get file extension for a target language
 */
function getFileExtension(language) {
    const extensions = {
        // Common languages
        'java': 'java',
        'javascript': 'js',
        'typescript': 'ts',
        'python': 'py',
        'c': 'c',
        'cpp': 'cpp',
        'c++': 'cpp',
        'csharp': 'cs',
        'c#': 'cs',
        'go': 'go',
        'golang': 'go',
        'rust': 'rs',
        'ruby': 'rb',
        'php': 'php',
        'swift': 'swift',
        'kotlin': 'kt',
        'scala': 'scala',
        
        // Legacy languages
        'cobol': 'cbl',
        'fortran': 'f90',
        'pascal': 'pas',
        'ada': 'adb',
        'tal': 'tal',
        
        // Scripting
        'perl': 'pl',
        'lua': 'lua',
        'r': 'R',
        'julia': 'jl',
        'shell': 'sh',
        'bash': 'sh',
        'powershell': 'ps1',
        
        // Web
        'html': 'html',
        'css': 'css',
        'jsx': 'jsx',
        'tsx': 'tsx',
        'vue': 'vue',
        
        // Data
        'sql': 'sql',
        'json': 'json',
        'yaml': 'yaml',
        'xml': 'xml'
    };
    
    return extensions[language.toLowerCase()] || language.toLowerCase();
}

// ============================================================
// Binary File Detection
// ============================================================

/**
 * Check if a path is a binary file (skip these)
 */
function isBinaryFile(filename) {
    const binaryExts = [
        'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib',
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z', 'jar', 'war',
        'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
        'ttf', 'otf', 'woff', 'woff2', 'eot',
        'class', 'pyc', 'pyo'
    ];
    const ext = filename.split('.').pop().toLowerCase();
    return binaryExts.includes(ext);
}

// ============================================================
// File Context Operations
// ============================================================

/**
 * Add a file to context
 */
async function addFileToContext(uri, contextFiles, options = {}) {
    const { silent = false, onRefresh = null, onStatusUpdate = null } = options;
    
    try {
        const filePath = uri.fsPath;
        const fileName = pathUtils.getFileName(filePath);
        
        // Check file size
        const stat = await vscode.workspace.fs.stat(uri);
        const maxSize = 10 * 1024 * 1024; // 10MB limit
        
        if (stat.size > maxSize) {
            if (!silent) {
                vscode.window.showWarningMessage(`File ${fileName} is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 10MB`);
            }
            return;
        }
        
        // Check if binary
        if (isBinaryFile(fileName)) {
            if (!silent) {
                vscode.window.showWarningMessage(`Cannot add binary file: ${fileName}`);
            }
            return;
        }
        
        // Handle PDF files
        if (fileName.toLowerCase().endsWith('.pdf')) {
            const pdfResult = await extractPdfText(uri);
            if (pdfResult.text) {
                const language = detectLanguage(filePath);
                contextFiles.set(filePath, {
                    uri: uri,
                    content: pdfResult.text,
                    language: 'pdf'
                });
                
                onRefresh?.();
                onStatusUpdate?.();
                
                if (!silent) {
                    if (pdfResult.error) {
                        vscode.window.showWarningMessage(`PDF added with limited text extraction: ${fileName}`);
                    } else {
                        vscode.window.showInformationMessage(`PDF added to context: ${fileName}`);
                    }
                }
                return;
            } else {
                if (!silent) {
                    vscode.window.showErrorMessage(`Could not extract text from PDF: ${fileName}`);
                }
                return;
            }
        }
        
        // Read text file
        const content = await vscode.workspace.fs.readFile(uri);
        let text;
        
        try {
            text = new TextDecoder('utf-8').decode(content);
        } catch (e) {
            // Try other encodings
            try {
                text = new TextDecoder('latin1').decode(content);
            } catch (e2) {
                if (!silent) {
                    vscode.window.showWarningMessage(`Could not decode file: ${fileName}`);
                }
                return;
            }
        }
        
        // Detect language and add to context
        const language = detectLanguage(filePath);
        
        contextFiles.set(filePath, {
            uri: uri,
            content: text,
            language: language
        });
        
        onRefresh?.();
        onStatusUpdate?.();
        
        log('Added to context:', fileName, `(${language}, ${(text.length / 1024).toFixed(1)}KB)`);
        
        if (!silent) {
            vscode.window.showInformationMessage(`Added to AstraCode context: ${fileName}`);
        }
        
    } catch (error) {
        log('Error adding file:', error);
        if (!silent) {
            vscode.window.showErrorMessage(`Failed to add file: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Extract text from PDF (basic extraction)
 */
async function extractPdfText(uri) {
    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const buffer = Buffer.from(content);
        
        let text = '';
        const pdfString = buffer.toString('binary');
        
        // Look for text streams in PDF
        const textMatches = pdfString.match(/\(([^)]+)\)/g) || [];
        const extractedParts = [];
        
        for (const match of textMatches) {
            const inner = match.slice(1, -1);
            if (inner.length > 2 && /^[\x20-\x7E\s]+$/.test(inner)) {
                extractedParts.push(inner);
            }
        }
        
        // Also try to find BT...ET text blocks
        const btMatches = pdfString.match(/BT[\s\S]*?ET/g) || [];
        for (const block of btMatches) {
            const tjMatches = block.match(/\[([^\]]+)\]\s*TJ/g) || [];
            for (const tj of tjMatches) {
                const parts = tj.match(/\(([^)]+)\)/g) || [];
                for (const part of parts) {
                    const inner = part.slice(1, -1);
                    if (inner.length > 0 && /^[\x20-\x7E\s]+$/.test(inner)) {
                        extractedParts.push(inner);
                    }
                }
            }
        }
        
        text = extractedParts.join(' ').replace(/\s+/g, ' ').trim();
        
        if (text.length < 100) {
            return {
                text: `[PDF file - limited text extracted]\n\nExtracted content:\n${text}\n\n[Note: This PDF may contain images or complex formatting.]`,
                error: 'Limited extraction'
            };
        }
        
        return { text: `[Extracted from PDF]\n\n${text}`, error: null };
        
    } catch (error) {
        log('PDF extraction error:', error);
        return { 
            text: null, 
            error: error.message 
        };
    }
}

/**
 * Remove a file from context
 */
function removeFileFromContext(uri, contextFiles, options = {}) {
    const { onRefresh = null, onStatusUpdate = null } = options;
    
    const filePath = uri?.fsPath || uri;
    if (contextFiles.has(filePath)) {
        contextFiles.delete(filePath);
        onRefresh?.();
        onStatusUpdate?.();
        log('Removed from context:', filePath);
    }
}

/**
 * Clear all context
 */
function clearContext(contextFiles, codeIndex, options = {}) {
    const { onRefresh = null, onStatusUpdate = null } = options;
    
    contextFiles.clear();
    
    // Also clear the code index
    if (codeIndex) {
        codeIndex.files.clear();
        codeIndex.symbols.clear();
        codeIndex.variables.clear();
        codeIndex.callGraph.clear();
        codeIndex.reverseCallGraph.clear();
        codeIndex.dependencies.clear();
        codeIndex.summaries.clear();
        codeIndex.fileSummaries.clear();
        codeIndex.overallSummary = null;
        codeIndex.discoveredDomain = null;
        codeIndex.lastUpdated = null;
    }
    
    onRefresh?.();
    onStatusUpdate?.();
    log('Context and index cleared');
}

/**
 * Add directory contents to context recursively
 */
async function addDirectoryToContext(dirUri, contextFiles, options = {}) {
    const { 
        depth = 0, 
        maxDepth = 3, 
        onRefresh = null, 
        onStatusUpdate = null 
    } = options;
    
    if (depth > maxDepth) {
        log('Max depth reached, skipping:', dirUri.fsPath);
        return;
    }
    
    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        let addedCount = 0;
        
        // Skip patterns
        const skipDirs = ['node_modules', '__pycache__', 'target', 'build', 'dist', 'bin', 'obj', '.git', '.svn'];
        
        for (const [name, type] of entries) {
            // Skip hidden files and common non-code directories
            if (name.startsWith('.') || skipDirs.includes(name)) {
                continue;
            }
            
            const childUri = vscode.Uri.joinPath(dirUri, name);
            
            if (type === vscode.FileType.Directory) {
                await addDirectoryToContext(childUri, contextFiles, {
                    depth: depth + 1,
                    maxDepth,
                    onRefresh,
                    onStatusUpdate
                });
            } else if (type === vscode.FileType.File) {
                if (isBinaryFile(name)) {
                    continue;
                }
                
                try {
                    await addFileToContext(childUri, contextFiles, { 
                        silent: true, 
                        onRefresh, 
                        onStatusUpdate 
                    });
                    addedCount++;
                } catch (e) {
                    log('Skipping unreadable file:', name);
                }
            }
        }
        
        if (depth === 0) {
            vscode.window.showInformationMessage(`Added ${contextFiles.size} files from directory`);
        }
        
    } catch (error) {
        log('Error reading directory:', error);
    }
}

/**
 * Add file or directory to context
 */
async function addToContext(uri, contextFiles, options = {}) {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        
        if (stat.type === vscode.FileType.Directory) {
            await addDirectoryToContext(uri, contextFiles, options);
        } else if (stat.type === vscode.FileType.File) {
            await addFileToContext(uri, contextFiles, options);
        }
    } catch (error) {
        log('Error adding to context:', error);
        vscode.window.showErrorMessage(`Failed to add: ${error.message}`);
    }
}

/**
 * Save generated code to .astra folder
 */
async function saveGeneratedCode(code, fileName, language) {
    log('Saving generated code:', fileName);
    
    const extMap = {
        'java': '.java',
        'python': '.py',
        'javascript': '.js',
        'typescript': '.ts',
        'c': '.c',
        'cpp': '.cpp',
        'c++': '.cpp',
        'csharp': '.cs',
        'c#': '.cs',
        'go': '.go',
        'rust': '.rs',
        'ruby': '.rb',
        'php': '.php',
        'swift': '.swift',
        'kotlin': '.kt',
        'scala': '.scala',
        'cobol': '.cbl',
        'tal': '.tal'
    };
    
    const ext = extMap[language.toLowerCase()] || `.${language.toLowerCase()}`;
    
    // Ensure filename has correct extension
    let finalName = fileName;
    if (!fileName.includes('.')) {
        finalName = fileName + ext;
    }
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return { saved: false, error: 'No workspace folder open' };
    }
    
    try {
        // Create .astra/generated directory
        const astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'generated');
        await vscode.workspace.fs.createDirectory(astraDir);
        
        // Write file
        const fileUri = vscode.Uri.joinPath(astraDir, finalName);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf8'));
        
        log('Generated code saved to:', fileUri.fsPath);
        
        return {
            saved: true,
            filePath: fileUri.fsPath,
            fileUri: fileUri
        };
        
    } catch (error) {
        log('Error saving generated code:', error);
        return {
            saved: false,
            error: error.message
        };
    }
}

module.exports = {
    detectLanguage,
    getFileExtension,
    isBinaryFile,
    addFileToContext,
    extractPdfText,
    removeFileFromContext,
    clearContext,
    addDirectoryToContext,
    addToContext,
    saveGeneratedCode
};
