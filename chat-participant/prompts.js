/**
 * AstraCode Prompts - Main Entry Point
 * 
 * This module serves as the main entry point for all prompts:
 * - System prompts (from systemprompts.js)
 * - Domain prompts (from domainprompts.js)
 * - Help text
 * 
 * EXTENSIBILITY:
 * Users can register custom domain prompts by calling:
 *   registerDomainPrompt({ key, name, description, searchTerms, systemPrompt, getUserPrompt })
 */

const {
    DESCRIBE_SYSTEM_PROMPT,
    getDescribeUserPrompt,
    TRANSLATE_SYSTEM_PROMPT,
    getTranslateUserPrompt,
    REQUIREMENTS_SYSTEM_PROMPT,
    getRequirementsUserPrompt,
    DEEPWIKI_SYSTEM_PROMPT,
    getDeepWikiUserPrompt,
    GENERAL_SYSTEM_PROMPT,
    getGeneralUserPrompt
} = require('./systemprompts');

const {
    registerDomainPrompt,
    getDomainPrompt,
    hasDomainPrompt,
    listDomainPrompts,
    unregisterDomainPrompt
} = require('./domainprompts');

// ============================================================
// HELP TEXT
// ============================================================

const HELP_TEXT = `# 🔍 AstraCode Help

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/find\` | Search for code by keyword | \`@astra /find FEDIN\` |
| \`/describe\` | Describe functionality of code | \`@astra /describe FEDIN-PARSE\` |
| \`/deepwiki\` | Generate comprehensive DeepWiki-style docs | \`@astra /deepwiki FEDIN\` |
| \`/translate\` | Translate code to Java | \`@astra /translate PROC-VALIDATE\` |
| \`/requirements\` | Extract business requirements | \`@astra /requirements wire transfer\` |
| \`/domain\` | Run domain-specific analysis | \`@astra /domain fediso\` |
| \`/domains\` | List available domain prompts | \`@astra /domains\` |
| \`/history\` | View last 25 queries | \`@astra /history\` |
| \`/generated\` | List generated documentation files | \`@astra /generated\` |
| \`/clean\` | Delete generated files | \`@astra /clean\` |
| \`/docs\` | Show document indexing status | \`@astra /docs\` |
| \`/stats\` | Show index statistics | \`@astra /stats\` |
| \`/clear\` | Clear index (fresh start) | \`@astra /clear\` |
| \`/rebuild\` | Force rebuild index | \`@astra /rebuild\` |
| \`/help\` | Show this help | \`@astra /help\` |

## Unified Syntax

All commands support three input modes:

| Syntax | Meaning | Example |
|--------|---------|---------|
| \`/cmd <topic>\` | Search current workspace | \`/describe FEDIN\` |
| \`/cmd #N\` | Use history item N | \`/describe #5\` |
| \`/cmd #file x, y\` | Use specific files | \`/describe #file payment.tal\` |

## Multi-Folder Workspace

Add multiple folders to your workspace:
- \`File > Add Folder to Workspace...\`
- Source code, docs, and requirements in separate folders
- Save as \`.code-workspace\` file

## Document Indexing

AstraCode can index PDF, Excel, and Word documents:

\`\`\`
@astra /docs                   # Check parser status
@astra /rebuild                # Re-index with documents
@astra /find requirements      # Search across code AND docs
\`\`\`

**Install document parsers:**
\`\`\`bash
npm install pdf-parse xlsx mammoth
\`\`\`

## DeepWiki Documentation

Generate comprehensive technical documentation:

\`\`\`
@astra /deepwiki FEDIN
@astra /deepwiki #file payment.tal
\`\`\`

**Output includes:**
- Architecture diagrams (Mermaid)
- Sequence diagrams  
- Data flow analysis
- API/function reference
- Business rules catalog
- Error handling guide

**Generated files saved to:** \`generated/<topic>_deepwiki_<timestamp>.md\`

## Generated Files Management

\`\`\`
@astra /generated              # List all generated files
@astra /clean                  # Delete ALL generated files
@astra /clean FEDIN            # Delete files matching "FEDIN"
\`\`\`

## Workflow Example

\`\`\`
@astra /find FEDIN                   # Step 1: Find relevant code → #1
@astra /describe #1                  # Step 2: Quick description
@astra /deepwiki #1                  # Step 3: Full documentation
@astra /requirements #1              # Step 4: Extract requirements
@astra /translate #1                 # Step 5: Convert to Java
@astra /generated                    # View generated docs
\`\`\`
`;

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // System prompts
    DESCRIBE_SYSTEM_PROMPT,
    getDescribeUserPrompt,
    TRANSLATE_SYSTEM_PROMPT,
    getTranslateUserPrompt,
    REQUIREMENTS_SYSTEM_PROMPT,
    getRequirementsUserPrompt,
    DEEPWIKI_SYSTEM_PROMPT,
    getDeepWikiUserPrompt,
    GENERAL_SYSTEM_PROMPT,
    getGeneralUserPrompt,
    
    // Domain prompts registry
    registerDomainPrompt,
    getDomainPrompt,
    hasDomainPrompt,
    listDomainPrompts,
    unregisterDomainPrompt,
    
    // Help
    HELP_TEXT
};
