/**
 * /help command handler
 */

/**
 * Show help and usage information
 * @param {Object} response - Chat response stream
 */
function handle(response) {
    response.markdown(`# 🔍 AstraCode Help

## Commands

All commands follow the pattern: \`@astra /command <topic>\`

| Command | Description | Example |
|---------|-------------|---------|
| \`/find\` | Search for code by keyword | \`@astra /find FEDIN\` |
| \`/describe\` | Describe functionality of code | \`@astra /describe payment validation\` |
| \`/deepwiki\` | Generate wiki-style documentation | \`@astra /deepwiki authentication\` |
| \`/translate\` | Translate TAL to Java | \`@astra /translate PROC-VALIDATE\` |
| \`/fediso\` | Uplift to Fed ISO 20022 | \`@astra /fediso wire transfer\` |
| \`/requirements\` | Extract business requirements | \`@astra /requirements wire transfer\` |
| \`/extract\` | Alias for /requirements | \`@astra /extract validation rules\` |
| \`/stats\` | Show index statistics | \`@astra /stats\` |
| \`/clear\` | Clear index (fresh start) | \`@astra /clear\` |
| \`/rebuild\` | Force rebuild index | \`@astra /rebuild\` |
| \`/help\` | Show this help | \`@astra /help\` |

## DeepWiki Documentation

The \`/deepwiki\` command generates comprehensive wiki-style documentation:

- 📋 Overview with source file references
- 📊 Architecture diagrams (Mermaid class/flowchart)
- 🔧 Component documentation with methods & fields
- 📜 Business logic and validation rules
- ⚠️ Error conditions and handling
- 🔗 Related topics to explore

**Example:** \`@astra /deepwiki Config class\`

## General Queries

Without a command, AstraCode answers code questions:

- \`@astra who calls heap_insert\`
- \`@astra explain partition pruning\`
- \`@astra find usages of validateTransaction\`

## Tips

- All commands search the **entire workspace** recursively
- Use \`/find\` first to locate code, then \`/describe\` or \`/deepwiki\`
- Use \`/deepwiki\` for comprehensive documentation with diagrams
- For Fed wire uplift: \`/find FEDIN\` → \`/deepwiki\` → \`/fediso\`
`);
}

module.exports = { handle };
