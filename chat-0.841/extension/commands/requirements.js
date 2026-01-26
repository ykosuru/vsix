/**
 * /requirements command - Extract BUSINESS requirements for modernization
 * 
 * Usage:
 * @astra /requirements OFAC screening                  - Search workspace (default)
 * @astra /requirements /source w,a payment validation  - Workspace + attachments
 * @astra /requirements /source a                       - Attachments only
 * @astra /conf.r Design /requirements                  - Piped from Confluence
 * 
 * Focuses on WHAT the system does, not HOW it's implemented.
 */

const vscode = require('vscode');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');
const { parseModifiers, readAttachments, extractHistoryContent, SOURCE_HELP } = require('../utils/source-parser');

const systemPrompt = `You are a business analyst extracting requirements from legacy systems for modernization to a NEW system.

CRITICAL RULES:
1. Extract BUSINESS REQUIREMENTS only - WHAT the system does
2. DO NOT include implementation details (file names, procedures, queues, databases, field names)
3. Use BUSINESS LANGUAGE that non-technical stakeholders understand
4. Requirements must be technology-agnostic (implementable in any stack)

FORMAT:

## Business Requirements

Feature: <Business Capability>
  # <Business context - why this exists>
  
  Scenario: <Business Outcome>
    Given <business precondition>
    When <business trigger/action>
    Then <business result>
    # Business Rule: <rule in plain language>

## Data Requirements
- Input data needed
- Output data produced
- Data transformations

## Integration Points
- External systems interactions (in business terms)
- Message/event flows

## Business Rules Summary
- BR-001: <rule>
- BR-002: <rule>

TERMINOLOGY TRANSLATION:
- Queue/MQ → "message channel" or "integration point"  
- Database/Table → "data store" or "record"
- Procedure/Module → omit entirely
- File names → omit entirely
- Technical params → translate to business meaning`;

async function handle(ctx) {
    const { query, response, outputChannel, token, request, chatContext, pipedContent: ctxPipedContent, previousOutput } = ctx;
    
    // Parse /source modifier (default: workspace search)
    const { sources, cleanQuery } = parseModifiers(query, { llm: false, h: false, w: true, a: true });
    
    // Check for piped content
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    if (!cleanQuery.trim() && !hasPipedContent && !sources.a) {
        response.markdown(`# /requirements - Extract Business Requirements

**Usage:** \`@astra /requirements [/source <s>] <business area>\`

Extracts BUSINESS requirements from legacy code. Focuses on WHAT the system does, not HOW.

## Source Options (default: \`w,a\`)

| Source | When to Use |
|--------|-------------|
| \`w\` | Search workspace for legacy code |
| \`a\` | Analyze attached documents |
| \`w,a\` | Both workspace + attachments **(default)** |
| \`h,w\` | Continue previous + workspace |

## Examples

**Search workspace:**
\`\`\`
@astra /requirements OFAC screening
@astra /requirements payment validation
\`\`\`

**Attachments only:**
\`\`\`
[Attach: design-spec.pdf, api-doc.md]
@astra /requirements /source a payment processing
\`\`\`

**From Confluence:**
\`\`\`
@astra /conf.r Design Spec /requirements
\`\`\`

**Continue analysis:**
\`\`\`
@astra /requirements /source h,w continue with edge cases
\`\`\`

## Output Format

- Gherkin scenarios (Given/When/Then)
- Numbered business rules (BR-001, BR-002...)
- Data requirements
- Integration points

## Pipelines

\`\`\`
@astra /requirements OFAC /fediso /gencode
@astra /requirements payment /jira epic
\`\`\`
`);
        
        response.button({
            command: 'astracode.configureSources',
            title: '⚙️ Configure Input Sources'
        });
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
            maxFiles: 20,
            maxLinesPerFile: 350
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
    response.markdown(`**📥 Sources:** ${sourcesUsed.join(', ') || 'None'}\n\n`);
    
    // Show file details
    if (workspaceFiles.length > 0) {
        let details = `<details><summary>📂 Workspace files (${workspaceFiles.length})</summary>\n\n`;
        for (const f of workspaceFiles.slice(0, 20)) {
            details += `- \`${f.path}\`\n`;
        }
        details += `\n</details>\n\n`;
        response.markdown(details);
    }
    
    if (attachmentNames.length > 0) {
        let details = `<details><summary>📎 Attachments (${attachmentNames.length})</summary>\n\n`;
        for (const name of attachmentNames) {
            details += `- \`${name}\`\n`;
        }
        details += `\n</details>\n\n`;
        response.markdown(details);
    }
    
    // Build prompt
    let userPrompt = `Extract BUSINESS REQUIREMENTS for: ${cleanQuery || 'the provided content'}

This analysis is for building a NEW system. Focus on WHAT business rules exist, not how they're currently implemented.

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
        userPrompt += `## Legacy Source Code
(Analyze for business rules - DO NOT reference file names or implementation details in output)

${workspaceContent}

`;
    }

    if (attachmentContent) {
        userPrompt += `## Attached Documentation
${attachmentContent}

`;
    }

    userPrompt += `Generate comprehensive business requirements:
- Use Gherkin scenarios for testable requirements
- Number business rules (BR-001, BR-002...)
- Include data and integration requirements
- NO file names, procedure names, or technical details
- Use business language only

REMEMBER: Output must be understandable by business stakeholders.`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    if (!ctx.isPiped) {
        response.markdown(`\n\n---
**Next steps:**
- \`@astra /fediso\` → Map to ISO 20022
- \`@astra /logic ${cleanQuery || ''}\` → Extract business logic
- \`@astra /gencode\` → Generate code`);
    }
}

module.exports = { handle };
