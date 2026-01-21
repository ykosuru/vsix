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
| \`/translate\` | Translate TAL to Java | \`@astra /translate PROC-VALIDATE\` |
| \`/domain\` | Run domain-specific analysis | \`@astra /domain fediso\` |
| \`/domains\` | List available domain prompts | \`@astra /domains\` |
| \`/requirements\` | Extract business requirements | \`@astra /requirements wire transfer\` |
| \`/extract\` | Alias for /requirements | \`@astra /extract validation rules\` |
| \`/history\` | View last 25 queries | \`@astra /history\` |
| \`/use\` | Reuse results from history | \`@astra /use #5\` |
| \`/stats\` | Show index statistics | \`@astra /stats\` |
| \`/clear\` | Clear index (fresh start) | \`@astra /clear\` |
| \`/rebuild\` | Force rebuild index | \`@astra /rebuild\` |
| \`/help\` | Show this help | \`@astra /help\` |

## Domain-Specific Commands

Run specialized analysis with domain prompts:

\`\`\`
@astra /domain fediso                # Fed ISO 20022 uplift
@astra /domain swift                 # SWIFT MT to MX migration
@astra /domain ach                   # ACH processing analysis
@astra /domain ofac                  # OFAC/sanctions screening
@astra /domains                      # List all available domains
\`\`\`

**Legacy shortcuts still work:**
\`\`\`
@astra /fediso                       # Same as /domain fediso
\`\`\`

## History & Reuse

View your recent queries and reuse their results:

\`\`\`
@astra /history                  # View last 25 queries
@astra /history #5               # View details of query #5
@astra /use #5                   # Load results from query #5
@astra /translate                # Now works on loaded results
\`\`\`

## Specifying Files

You can specify files directly with any command:

\`\`\`
@astra /translate files: FEDIN.tal, FEDOUT.tal
@astra /describe files: payment-validator.c
@astra /domain fediso files: wire-msg.tal
\`\`\`

## Command Chaining

Run multiple operations in sequence:

\`\`\`
@astra /find account validation then /translate then /domain fediso
@astra /find FEDIN then /describe then /requirements
\`\`\`

## Using Previous Results

Commands without arguments use the last \`/find\` results:

\`\`\`
@astra /find FEDIN              # Find code first
@astra /translate               # Translate what was found
@astra /domain fediso           # Apply Fed ISO uplift to same code
\`\`\`

## General Queries

Without a command, AstraCode answers code questions:

- \`@astra who calls heap_insert\`
- \`@astra explain partition pruning\`
- \`@astra find usages of validateTransaction\`

## Custom Domain Prompts

You can register your own domain prompts programmatically:

\`\`\`javascript
registerDomainPrompt({
    key: 'mybank',
    name: 'MyBank Processing',
    description: 'Analyze MyBank proprietary formats',
    searchTerms: ['MYBANK', 'proprietary'],
    systemPrompt: 'You are an expert in MyBank...',
    getUserPrompt: (context) => \`Analyze: \${context}\`
});
\`\`\`

## Workflow Example

\`\`\`
@astra /find account validation      # Step 1: Find relevant code
@astra /describe                     # Step 2: Understand it
@astra /requirements                 # Step 3: Extract requirements
@astra /translate                    # Step 4: Convert to Java
@astra /domain fediso                # Step 5: Apply Fed ISO mapping
@astra /history                      # View all your queries
@astra /use #1                       # Go back to step 1 results
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
