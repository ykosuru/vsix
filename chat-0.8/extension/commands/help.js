/**
 * /help command
 */

function handle(ctx) {
    const { response } = ctx;
    
    response.markdown(`# 🔍 AstraCode Help

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/find\` | Search for code | \`@astra /find partprune\` |
| \`/describe\` | Describe functionality | \`@astra /describe partition pruning\` |
| \`/deepwiki\` | Generate wiki docs | \`@astra /deepwiki query optimizer\` |
| \`/translate\` | Translate legacy code | \`@astra /translate PROC_NAME\` |
| \`/requirements\` | Extract requirements | \`@astra /requirements validation\` |
| \`/help\` | Show this help | \`@astra /help\` |

## General Queries

Without a command, just ask questions:
- \`@astra how does partition pruning work?\`
- \`@astra explain the query optimizer\`
- \`@astra who calls ExecFindPartition?\`

## Tips

- Use specific function or file names for better results
- Copilot searches your workspace automatically
- Combine with @workspace for more context
`);
}

module.exports = { handle };
