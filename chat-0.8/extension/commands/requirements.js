/**
 * /requirements command - Extract BUSINESS requirements for modernization
 * 
 * Focuses on WHAT the system does, not HOW it's implemented.
 * Supports attached documents (vendor specs, API docs) for comprehensive analysis.
 * 
 * Output sections:
 * - From Code: Requirements extracted from legacy code
 * - From Attached Docs: Requirements from any attached documentation
 * - Merged Requirements: Comprehensive combined view
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are a business analyst extracting requirements from legacy systems for modernization to a NEW system.

CRITICAL RULES:
1. Extract BUSINESS REQUIREMENTS only - WHAT the system does
2. DO NOT include implementation details (file names, procedures, queues, databases, field names)
3. Use BUSINESS LANGUAGE that non-technical stakeholders understand
4. Requirements must be technology-agnostic (implementable in any stack)

FORMAT:

## From Code Analysis

Feature: <Business Capability>
  # <Business context - why this exists>
  
  Scenario: <Business Outcome>
    Given <business precondition>
    When <business trigger/action>
    Then <business result>
    # Business Rule: <rule in plain language>

## From Documentation (if provided)
<Requirements found in attached specs/docs>

## Merged Requirements
<Comprehensive list combining both sources, removing duplicates>

TERMINOLOGY TRANSLATION:
- Queue/MQ → "message channel" or "integration point"  
- Database/Table → "data store" or "record"
- Procedure/Module → omit entirely
- File names → omit entirely
- Technical params → translate to business meaning

Example transformations:
- "OFAC-REQUEST-QUEUE" → "sanctions screening service"
- "MQOFAC process" → "compliance screening"
- "ISN field" → "transaction identifier"
- "XML payload" → "transaction details"`;

async function handle(ctx) {
    const { query, response, outputChannel, token, request, isPiped } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /requirements <business area>\`

Extracts BUSINESS requirements from legacy code for building a NEW system.

**Features:**
- Focuses on WHAT (business rules), not HOW (implementation)
- Attach vendor docs/specs for comprehensive analysis
- Chain with \`/fediso\` for ISO 20022 mapping

**Examples:**
- \`@astra /requirements OFAC screening\`
- \`@astra /requirements OFAC screening /fediso\` ← piped!
- Attach API docs + \`@astra /requirements payment processing\`

**Chained Workflow:**
\`\`\`
@astra /requirements <area> /fediso   ← Does both in one command!
\`\`\``);
        return;
    }
    
    // Check for attached documents
    let attachedDocs = '';
    let hasAttachments = false;
    let attachedDocNames = [];
    
    if (request && request.references && request.references.length > 0) {
        hasAttachments = true;
        response.progress('Reading attached documents...');
        
        for (const ref of request.references) {
            try {
                let content = '';
                let fileName = '';
                
                if (ref.id && typeof ref.id === 'string') {
                    // File reference
                    const uri = vscode.Uri.parse(ref.id);
                    const fileContent = await vscode.workspace.fs.readFile(uri);
                    content = Buffer.from(fileContent).toString('utf8');
                    fileName = path.basename(uri.fsPath);
                } else if (ref.value && typeof ref.value === 'string') {
                    // Direct content
                    content = ref.value;
                    fileName = 'attached-content';
                }
                
                if (content) {
                    attachedDocNames.push(fileName);
                    // Limit size
                    const maxChars = 50000;
                    if (content.length > maxChars) {
                        content = content.slice(0, maxChars) + '\n... [truncated]';
                    }
                    attachedDocs += `\n### Document: ${fileName}\n${content}\n`;
                }
            } catch (e) {
                outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
            }
        }
    }
    
    // Search workspace for code
    response.progress('Analyzing legacy code...');
    const { context, files, totalLines } = await getWorkspaceContext(query, {
        maxFiles: 20,
        maxLinesPerFile: 350
    });
    
    if (!context && !attachedDocs) {
        response.markdown(`⚠️ **No code or documents found for:** "${query}"
        
Try attaching relevant files or use more specific search terms.`);
        return;
    }
    
    const fileCount = files?.length || 0;
    const docInfo = hasAttachments ? ' + attached docs' : '';
    
    // Show files being used
    let filesUsed = `📄 **Analyzing ${fileCount} code files${docInfo}**\n\n`;
    
    if (files && files.length > 0) {
        filesUsed += `<details><summary>📂 Source files (${files.length})</summary>\n\n`;
        for (const f of files.slice(0, 25)) {
            filesUsed += `- \`${f.path}\`\n`;
        }
        if (files.length > 25) {
            filesUsed += `- *...and ${files.length - 25} more*\n`;
        }
        filesUsed += `\n</details>\n\n`;
    }
    
    if (attachedDocNames && attachedDocNames.length > 0) {
        filesUsed += `<details><summary>📎 Attached documents (${attachedDocNames.length})</summary>\n\n`;
        for (const name of attachedDocNames) {
            filesUsed += `- \`${name}\`\n`;
        }
        filesUsed += `\n</details>\n\n`;
    }
    
    response.markdown(filesUsed);
    
    let userPrompt = `Extract BUSINESS REQUIREMENTS for: ${query}

This analysis is for building a NEW system. Focus on WHAT business rules exist, not how they're currently implemented.

`;

    if (context) {
        userPrompt += `## Legacy Source Code
(Analyze for business rules - DO NOT reference file names or implementation details in output)

${context}

`;
    }

    if (attachedDocs) {
        userPrompt += `## Attached Documentation
(Vendor specs, API docs, or other reference materials)

${attachedDocs}

`;
    }

    userPrompt += `Generate requirements in THREE sections:

## From Code Analysis
Gherkin scenarios capturing business rules found in the code.
- NO file names, procedure names, or technical details
- Use business language only

${hasAttachments ? `## From Documentation
Requirements/capabilities described in the attached docs.
- API capabilities, data formats, integration points
- Translate technical specs to business requirements

## Merged Requirements  
Comprehensive list combining both sources:
- Deduplicate overlapping requirements
- Note any gaps (in code but not docs, or vice versa)
- Prioritize by business importance` : ''}

REMEMBER: Output must be understandable by business stakeholders and implementable in ANY technology.`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Suggest next step only if not being piped
    if (!ctx.isPiped) {
        response.markdown(`\n\n---
**Next step:** \`@astra /fediso ${query}\` or chain: \`@astra /requirements ${query} /fediso\``);
    }
}

module.exports = { handle };
