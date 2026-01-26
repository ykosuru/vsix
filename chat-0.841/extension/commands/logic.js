/**
 * /logic command - Extract business logic from code
 * 
 * Usage:
 * @astra /logic MT103                     - Search workspace (default)
 * @astra /logic /source w,a payment       - Workspace + attachments
 * @astra /logic /source a                 - Attachments only
 * @astra /find MT103 /logic               - Piped
 * 
 * Customize output: Edit prompts/logic.md
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');
const { parseModifiers, readAttachments, extractHistoryContent, SOURCE_HELP } = require('../utils/source-parser');

/**
 * Load prompt from file
 */
function loadPrompt() {
    try {
        const promptPath = path.join(__dirname, '..', 'prompts', 'logic.md');
        return fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
        return `Extract all business logic including:
- Validations and preconditions
- If/then/else conditions
- Switch/case statements
- Calculations and transformations
- Exception handling
- External system interactions
- Response code handling`;
    }
}

async function handle(ctx) {
    const { query, response, outputChannel, token, request, chatContext, pipedContent: ctxPipedContent, previousOutput } = ctx;
    
    // Parse /source modifier (default: workspace + attachments)
    const { sources, cleanQuery } = parseModifiers(query, { llm: false, h: false, w: true, a: true });
    
    // Check for piped content
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    if (!cleanQuery.trim() && !hasPipedContent && !sources.a) {
        response.markdown(`# /logic - Extract Business Logic

**Usage:** \`@astra /logic [/source <s>] <functionality>\`

Extracts all business logic from code with file:line references.

## What It Extracts

| Category | Examples |
|----------|----------|
| **Validations** | Input checks, preconditions |
| **Conditionals** | If/then/else, switch/case |
| **Calculations** | Formulas, transformations |
| **Data Operations** | Loops, aggregations |
| **External Calls** | API calls, DB queries |
| **Response Handling** | Status codes, error responses |
| **Exceptions** | Try/catch, error recovery |

## Source Options (default: \`w,a\`)

| Source | When to Use |
|--------|-------------|
| \`w\` | Search workspace code |
| \`a\` | Analyze attached files |
| \`w,a\` | Both **(default)** |
| \`h,w\` | Continue previous + workspace |

## Examples

**Search workspace:**
\`\`\`
@astra /logic MT103 processing
@astra /logic payment validation
@astra /logic OFAC screening
\`\`\`

**Attachments only:**
\`\`\`
[Attach: PaymentService.java]
@astra /logic /source a
\`\`\`

**Continue analysis:**
\`\`\`
@astra /logic /source h,w add edge cases
\`\`\`

## Pipelines

\`\`\`
@astra /find MT103 /logic            <- Search then extract
@astra /logic payment /gencode       <- Extract then generate
@astra /logic OFAC /jira             <- Create ticket from logic
\`\`\`

## Customize

Edit \`prompts/logic.md\` to change extraction format.
`);
        return;
    }
    
    // Gather sources
    const sourcesUsed = [];
    let workspaceContent = '';
    let workspaceFiles = [];
    let attachmentContent = '';
    let attachmentNames = [];
    let historyContent = '';
    
    // Piped content takes priority
    if (hasPipedContent) {
        sourcesUsed.push(`🔗 Piped${previousOutput ? ` from /${previousOutput.command}` : ''}`);
    }
    
    // History
    if (sources.h) {
        historyContent = extractHistoryContent(chatContext, 1);
        if (historyContent.length > 50) {
            sourcesUsed.push('📜 History');
        }
    }
    
    // Workspace search
    if (sources.w && cleanQuery.trim()) {
        response.progress('Searching workspace...');
        const result = await getWorkspaceContext(cleanQuery, {
            maxFiles: 25,
            maxLinesPerFile: 500
        });
        workspaceContent = result.context || '';
        workspaceFiles = result.files || [];
        if (workspaceFiles.length > 0) {
            sourcesUsed.push(`🔍 Workspace (${workspaceFiles.length} files)`);
        }
    }
    
    // Attachments
    if (sources.a) {
        const { content, names } = await readAttachments(request?.references, outputChannel);
        attachmentContent = content;
        attachmentNames = names;
        if (names.length > 0) {
            sourcesUsed.push(`📎 Attachments (${names.length})`);
        }
    }
    
    // Check we have something
    const hasContent = hasPipedContent || historyContent || workspaceContent || attachmentContent;
    if (!hasContent) {
        response.markdown(`⚠️ **No content found.**

Provide a query to search workspace, attach files, or pipe from another command.
`);
        return;
    }
    
    // Show sources
    response.markdown(`## 🔍 Extracting Business Logic

**Query:** ${cleanQuery || '(from piped content)'}
**Sources:** ${sourcesUsed.join(', ')}

`);
    
    // Show file details
    if (workspaceFiles.length > 0) {
        let details = `<details><summary>📂 Workspace files (${workspaceFiles.length})</summary>\n\n`;
        for (const f of workspaceFiles.slice(0, 20)) {
            details += `- \`${f.path}\`\n`;
        }
        details += `\n</details>\n\n`;
        response.markdown(details);
    }
    
    // Load customizable prompt
    const basePrompt = loadPrompt();
    
    const systemPrompt = `You are an expert code analyst extracting business logic from source code.

${basePrompt}

CRITICAL:
- Extract EVERY piece of logic - be exhaustive
- Include file:line references where possible
- Organize by category (validations, conditions, calculations, etc.)
- Note any external dependencies or integrations`;

    // Build user prompt
    let userPrompt = `Extract ALL business logic for: ${cleanQuery || 'the provided code'}

`;

    if (hasPipedContent) {
        userPrompt += `## Source Content (piped)
${pipedContent.slice(0, 50000)}

`;
    }
    
    if (historyContent) {
        userPrompt += `## Previous Context
${historyContent.slice(0, 30000)}

`;
    }

    if (workspaceContent) {
        userPrompt += `## Source Code from Workspace
${workspaceContent}

`;
    }

    if (attachmentContent) {
        userPrompt += `## Attached Code Files
${attachmentContent}

`;
    }

    userPrompt += `Extract ALL business logic following the format in the system prompt. Be comprehensive.`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    if (!ctx.isPiped) {
        response.markdown(`\n\n---
**Next steps:**
- \`@astra /gencode\` → Generate equivalent code
- \`@astra /jira\` → Create Jira ticket
- \`@astra /fediso\` → Map to ISO 20022`);
    }
}

module.exports = { handle };
