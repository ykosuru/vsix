/**
 * /deepwiki command - generate wiki-style documentation
 * 
 * Usage:
 * - @astra /deepwiki <topic>     - Document specific topic
 * - @astra /deepwiki .           - Document entire repo (overview)
 * - @astra /deepwiki * or all    - Document all major components
 * - @astra /deepwiki spec        - Generate full specification document
 * 
 * Customize output by editing prompts/deepwiki.md
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

/**
 * Load prompt from external file
 */
function loadPrompt() {
    try {
        const promptPath = path.join(__dirname, '..', 'prompts', 'deepwiki.md');
        return fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
        // Fallback if file not found
        return null;
    }
}

const defaultSystemPrompt = `You are a technical documentation expert. Generate comprehensive wiki-style documentation.

Include:
- Overview section with purpose
- Architecture diagram using Mermaid syntax
- Key components with descriptions
- Data flow explanation
- Function documentation with signatures
- Error handling
- Related topics

IMPORTANT: For Mermaid diagrams, use this exact format (no extra spaces before backticks):

\`\`\`mermaid
flowchart TD
    A[Component A] --> B[Component B]
    B --> C[Component C]
\`\`\`

Use flowchart TD (top-down) for best rendering. Keep diagrams simple - avoid special characters in labels.

Use markdown with headers, code blocks, and bullet points.
Reference specific source files with file:line format.`;

const repoOverviewPrompt = `You are a technical documentation expert. Generate a comprehensive README/overview for an entire codebase.

Create documentation with:
1. **Project Overview** - What this project does, its purpose
2. **Architecture** - High-level Mermaid diagram of the system
3. **Directory Structure** - Explain the folder organization
4. **Key Components** - Major modules/packages and their roles
5. **Getting Started** - How to build/run (infer from config files)
6. **Configuration** - Key config files and settings
7. **Dependencies** - Major dependencies and why they're used
8. **Contributing** - Code organization patterns to follow

IMPORTANT: For Mermaid diagrams, use this exact format (no extra spaces before backticks):

\`\`\`mermaid
flowchart TD
    A[Component A] --> B[Component B]
    B --> C[Component C]
\`\`\`

Use flowchart TD (top-down) for best rendering. Keep diagrams simple - avoid special characters in labels.

Be comprehensive but organized. Use the file listing and sample code to understand the project.`;

/**
 * Scan workspace for file listing
 */
async function getRepoStructure(workspaceRoot, outputChannel) {
    const structure = {
        directories: [],
        files: [],
        configFiles: [],
        sourceFiles: [],
        totalFiles: 0
    };
    
    const configPatterns = ['package.json', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile', 
                           'docker-compose.yml', '.env.example', 'tsconfig.json', 'webpack.config.js',
                           'application.yml', 'application.properties', 'settings.gradle'];
    
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', 
                        '.idea', '.vscode', 'coverage', '.next', 'out'];
    
    const sourceExts = ['.js', '.ts', '.java', '.py', '.go', '.rs', '.c', '.cpp', '.h',
                        '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.tal', '.cob', '.cbl'];

    function scan(dir, depth = 0) {
        if (depth > 4) return; // Limit depth
        
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(workspaceRoot, fullPath);
                
                if (entry.isDirectory()) {
                    if (!ignoreDirs.includes(entry.name) && !entry.name.startsWith('.')) {
                        structure.directories.push(relPath);
                        scan(fullPath, depth + 1);
                    }
                } else {
                    structure.totalFiles++;
                    const ext = path.extname(entry.name).toLowerCase();
                    
                    if (configPatterns.includes(entry.name)) {
                        structure.configFiles.push(relPath);
                    }
                    if (sourceExts.includes(ext)) {
                        structure.sourceFiles.push(relPath);
                    }
                    structure.files.push(relPath);
                }
            }
        } catch (e) {
            outputChannel?.appendLine(`[AstraCode] Scan error: ${e.message}`);
        }
    }
    
    scan(workspaceRoot);
    return structure;
}

/**
 * Read key config files
 */
async function readConfigFiles(workspaceRoot, configFiles) {
    let content = '';
    
    for (const file of configFiles.slice(0, 5)) { // Limit to 5 config files
        try {
            const fullPath = path.join(workspaceRoot, file);
            const data = fs.readFileSync(fullPath, 'utf8');
            const truncated = data.length > 3000 ? data.slice(0, 3000) + '\n... [truncated]' : data;
            content += `\n### ${file}\n\`\`\`\n${truncated}\n\`\`\`\n`;
        } catch (e) {
            // Skip unreadable files
        }
    }
    
    return content;
}

/**
 * Sample source files for context
 */
async function sampleSourceFiles(workspaceRoot, sourceFiles, maxFiles = 10, maxLines = 100) {
    let content = '';
    const sampled = sourceFiles.slice(0, maxFiles);
    
    for (const file of sampled) {
        try {
            const fullPath = path.join(workspaceRoot, file);
            const data = fs.readFileSync(fullPath, 'utf8');
            const lines = data.split('\n').slice(0, maxLines);
            content += `\n### ${file}\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`;
        } catch (e) {
            // Skip unreadable files
        }
    }
    
    return content;
}

async function handle(ctx) {
    const { query, response, outputChannel, token, workspaceRoot } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /deepwiki <topic or scope>\`

**Topic Documentation:**
\`\`\`
@astra /deepwiki partition pruning
@astra /deepwiki query optimizer
@astra /deepwiki OFAC screening
\`\`\`

**Entire Repository:**
\`\`\`
@astra /deepwiki .           ← Overview of entire repo
@astra /deepwiki all         ← Document all major components
@astra /deepwiki readme      ← Generate README.md style
\`\`\`

**Full Specification Document:**
\`\`\`
@astra /deepwiki spec        ← Comprehensive spec (API, data models, etc.)
@astra /deepwiki full        ← Same as spec
@astra /deepwiki html        ← Generate HTML specification
\`\`\`

**Customize output:** Edit \`prompts/deepwiki.md\`

**Then publish:**
\`\`\`
@astra /conf.w Project Documentation
\`\`\``);
        return;
    }
    
    const isRepoWide = ['.', 'all', '*', 'repo', 'readme', 'overview'].includes(query.trim().toLowerCase());
    const isSpecMode = ['spec', 'specification', 'full', 'detailed', 'html'].includes(query.trim().toLowerCase());
    
    // Load external prompt (for spec mode or custom prompt override)
    const externalPrompt = loadPrompt();
    
    if (isSpecMode) {
        // === FULL SPECIFICATION DOCUMENT ===
        if (!workspaceRoot) {
            response.markdown(`⚠️ **No workspace open.** Open a folder first.`);
            return;
        }
        
        response.markdown(`## 📋 Generating Full Specification Document

*Using template from \`prompts/deepwiki.md\`*

`);
        
        response.progress('Scanning repository structure...');
        const structure = await getRepoStructure(workspaceRoot, outputChannel);
        
        response.markdown(`**Scanning:** ${path.basename(workspaceRoot)}
- 📁 ${structure.directories.length} directories
- 📄 ${structure.totalFiles} total files
- ⚙️ ${structure.configFiles.length} config files
- 💻 ${structure.sourceFiles.length} source files

`);
        
        response.progress('Reading configuration files...');
        const configContent = await readConfigFiles(workspaceRoot, structure.configFiles);
        
        response.progress('Sampling source files...');
        const sourceContent = await sampleSourceFiles(workspaceRoot, structure.sourceFiles, 15, 100);
        
        // Build directory tree
        let dirTree = '```\n' + path.basename(workspaceRoot) + '/\n';
        const topDirs = structure.directories.filter(d => !d.includes(path.sep)).slice(0, 20);
        for (const dir of topDirs) {
            dirTree += `├── ${dir}/\n`;
        }
        if (structure.directories.length > 20) {
            dirTree += `└── ... (${structure.directories.length - 20} more directories)\n`;
        }
        dirTree += '```\n';
        
        // Use external prompt if available, otherwise fallback
        const specSystemPrompt = externalPrompt || repoOverviewPrompt;
        
        const userPrompt = `Generate a comprehensive Function Specification Document for this codebase.

## Repository: ${path.basename(workspaceRoot)}

## Directory Structure
${dirTree}

## Configuration Files
${configContent || 'No configuration files found.'}

## Source Code Samples
${sourceContent || 'No source files found.'}

Follow the document structure and styling requirements in the system prompt.
Generate a complete, professional specification document.`;

        response.progress('Generating specification document...');
        await streamResponse(specSystemPrompt, userPrompt, response, outputChannel, token);
        
    } else if (isRepoWide) {
        // === REPO-WIDE DOCUMENTATION ===
        if (!workspaceRoot) {
            response.markdown(`⚠️ **No workspace open.** Open a folder first.`);
            return;
        }
        
        response.progress('Scanning repository structure...');
        const structure = await getRepoStructure(workspaceRoot, outputChannel);
        
        response.markdown(`## 📚 Generating Repository Documentation

**Scanning:** ${path.basename(workspaceRoot)}
- 📁 ${structure.directories.length} directories
- 📄 ${structure.totalFiles} total files
- ⚙️ ${structure.configFiles.length} config files
- 💻 ${structure.sourceFiles.length} source files

`);
        
        response.progress('Reading configuration files...');
        const configContent = await readConfigFiles(workspaceRoot, structure.configFiles);
        
        response.progress('Sampling source files...');
        const sourceContent = await sampleSourceFiles(workspaceRoot, structure.sourceFiles, 10, 80);
        
        // Build directory tree
        let dirTree = '```\n' + path.basename(workspaceRoot) + '/\n';
        const topDirs = structure.directories.filter(d => !d.includes(path.sep)).slice(0, 20);
        for (const dir of topDirs) {
            dirTree += `├── ${dir}/\n`;
        }
        if (structure.directories.length > 20) {
            dirTree += `└── ... (${structure.directories.length - 20} more directories)\n`;
        }
        dirTree += '```\n';
        
        const userPrompt = `Generate comprehensive documentation for this repository.

## Repository: ${path.basename(workspaceRoot)}

## Directory Structure
${dirTree}

## Configuration Files
${configContent || 'No config files found'}

## Sample Source Code
${sourceContent || 'No source files found'}

## File Statistics
- Total files: ${structure.totalFiles}
- Source files: ${structure.sourceFiles.length}
- Config files: ${structure.configFiles.length}

Create a comprehensive README-style document covering:
1. Project Overview - purpose and what it does
2. Architecture - Mermaid diagram of components
3. Directory Structure - explain the organization
4. Key Components - major modules and their roles
5. Getting Started - build/run instructions (infer from configs)
6. Configuration - important settings
7. Dependencies - key dependencies
8. API/Interfaces - main entry points`;

        await streamResponse(repoOverviewPrompt, userPrompt, response, outputChannel, token);
        
    } else {
        // === TOPIC-SPECIFIC DOCUMENTATION ===
        response.progress('Searching workspace...');
        const { context, files, totalLines } = await getWorkspaceContext(query, {
            maxFiles: 25,
            maxLinesPerFile: 400,
            maxTotalLines: 5000
        });
        
        if (!context || files.length === 0) {
            response.markdown(`⚠️ **No matching files found for:** "${query}"
            
Try \`@astra /deepwiki .\` to document the entire repository.`);
            return;
        }
        
        // Show files being used
        let filesUsed = `📄 **Generating documentation from ${files.length} files** (${totalLines.toLocaleString()} lines)\n\n`;
        filesUsed += `<details><summary>📂 Files analyzed</summary>\n\n`;
        for (const f of files.slice(0, 25)) {
            filesUsed += `- \`${f.path}\`\n`;
        }
        if (files.length > 25) {
            filesUsed += `- *...and ${files.length - 25} more*\n`;
        }
        filesUsed += `\n</details>\n\n`;
        response.markdown(filesUsed);
        
        const userPrompt = `Generate comprehensive wiki documentation for: ${query}

## Source Code
${context}

Create documentation with:
1. **Overview** - What it is and why it exists
2. **Architecture** - Mermaid diagram showing components
3. **Key Components** - Each major piece with its role
4. **Data Flow** - How data moves through the system
5. **API/Functions** - Key functions with signatures
6. **Error Handling** - How errors are managed
7. **Related Topics** - Links to related concepts

Reference specific source files and line numbers throughout.`;

        // Use the default system prompt for topic-specific docs
        await streamResponse(defaultSystemPrompt, userPrompt, response, outputChannel, token);
    }
    
    // Suggest publishing
    const title = isSpecMode ? 'Function Specification' : (isRepoWide ? 'Repository Overview' : query);
    response.markdown(`\n\n---\n📤 **Publish to Confluence:** \`@astra /conf.w ${title} Documentation\``);
}

module.exports = { handle };
