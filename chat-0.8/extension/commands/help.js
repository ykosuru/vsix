/**
 * /help command
 */

function handle(ctx) {
    const { response } = ctx;
    
    response.markdown(`# 🔍 AstraCode Help

## Command Chaining (Pipes)

Chain commands together with \`/command\`:

\`\`\`
@astra /requirements OFAC screening /fediso
\`\`\`

This runs:
1. \`/requirements OFAC screening\` → Extracts business requirements
2. \`/fediso\` → Maps those requirements to ISO 20022

## Modernization Workflow

\`\`\`
@astra /requirements <area> /fediso    ← One command, full workflow!
\`\`\`

Or step by step:
\`\`\`
1. @astra /requirements <area>    → Extract WHAT (business requirements)
2. @astra /fediso <area>          → Map to ISO 20022
3. @astra /deepwiki <area>        → Document legacy implementation
\`\`\`

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/requirements\` | Extract business requirements | \`@astra /requirements OFAC\` |
| \`/fediso\` | Map to ISO 20022 | \`@astra /fediso wire transfer\` |
| \`/deepwiki\` | Generate documentation | \`@astra /deepwiki partition pruning\` |
| \`/describe\` | Explain how code works | \`@astra /describe ExecFindPartition\` |
| \`/find\` | Search for code | \`@astra /find partprune\` |
| \`/translate\` | Translate legacy code | \`@astra /translate PROC_NAME\` |
| \`/stats\` | Workspace statistics | \`@astra /stats\` |

## Attaching Files

Attach vendor docs or specs for richer analysis:

\`\`\`
[Attach: vendor-api-spec.pdf]
@astra /requirements payment processing /fediso
\`\`\`

Output sections:
- **From Code:** Requirements from source
- **From Docs:** Requirements from attachments  
- **Merged:** Combined comprehensive view
`);
}

module.exports = { handle };
