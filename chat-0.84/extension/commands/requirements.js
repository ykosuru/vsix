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
    const { query, response, outputChannel, token, request, isPiped, previousOutput, pipedContent: ctxPipedContent } = ctx;
    
    // Check for piped content from previous command (e.g., /conf.r)
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    if (!query.trim() && !hasPipedContent) {
        response.markdown(`**Usage:** \`@astra /requirements <business area>\`

Extracts BUSINESS requirements from legacy code for building a NEW system.

**Input Sources (can combine):**
- 🔍 Query → searches workspace code
- 📎 Attachments → attached files (PDFs, docs, code)
- 🔗 Piped → from \`/conf.r\` or \`/history\`

**Examples:**
\`\`\`
@astra /requirements OFAC screening
@astra /requirements OFAC /fediso /gencode
\`\`\`

**With Attachments:**
\`\`\`
[Attach: vendor-api.pdf, spec.docx]
@astra /requirements payment processing
\`\`\`

**From Confluence:**
\`\`\`
@astra /conf.r Design Spec /requirements
\`\`\`

**From Chat History:**
\`\`\`
@astra /history 5 /requirements
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
    
    // Search workspace for code if query provided
    // - Standalone: search with query
    // - Piped: optionally augment piped content with workspace code
    let context = '';
    let files = [];
    
    if (query.trim()) {
        response.progress('Analyzing legacy code...');
        const searchResult = await getWorkspaceContext(query, {
            maxFiles: 20,
            maxLinesPerFile: 350
        });
        context = searchResult.context;
        files = searchResult.files || [];
    }
    
    if (!context && !attachedDocs && !hasPipedContent) {
        response.markdown(`⚠️ **No content found.**
        
Provide a query, attach files, or pipe from \`/conf.r\`:
\`\`\`
@astra /conf.r Design Spec /requirements
\`\`\``);
        return;
    }
    
    const fileCount = files?.length || 0;
    const pipedFrom = hasPipedContent && previousOutput ? previousOutput.command : null;
    
    // Show all input sources being used
    let sourcesUsed = '**📥 Input Sources:**\n\n';
    let sourceCount = 0;
    
    if (hasPipedContent) {
        sourcesUsed += `- 🔗 **Piped content** ${pipedFrom ? `from \`/${pipedFrom}\`` : ''}\n`;
        sourceCount++;
    }
    
    if (fileCount > 0) {
        sourcesUsed += `- 🔍 **Workspace code** (${fileCount} files)\n`;
        sourceCount++;
    }
    
    if (hasAttachments) {
        sourcesUsed += `- 📎 **Attached files** (${attachedDocNames.length})\n`;
        sourceCount++;
    }
    
    sourcesUsed += '\n';
    
    // Collapsible details for each source
    if (files && files.length > 0) {
        sourcesUsed += `<details><summary>📂 Source files (${files.length})</summary>\n\n`;
        for (const f of files.slice(0, 25)) {
            sourcesUsed += `- \`${f.path}\`\n`;
        }
        if (files.length > 25) {
            sourcesUsed += `- *...and ${files.length - 25} more*\n`;
        }
        sourcesUsed += `\n</details>\n\n`;
    }
    
    if (attachedDocNames && attachedDocNames.length > 0) {
        sourcesUsed += `<details><summary>📎 Attached documents (${attachedDocNames.length})</summary>\n\n`;
        for (const name of attachedDocNames) {
            sourcesUsed += `- \`${name}\`\n`;
        }
        sourcesUsed += `\n</details>\n\n`;
    }
    
    response.markdown(sourcesUsed);
    
    let userPrompt = `Extract BUSINESS REQUIREMENTS for: ${query || 'the provided content'}

This analysis is for building a NEW system. Focus on WHAT business rules exist, not how they're currently implemented.

`;

    // Add piped content (e.g., from /conf.r)
    if (hasPipedContent) {
        userPrompt += `## Source Document${pipedFrom ? ` (from /${pipedFrom})` : ''}
(Extract business requirements from this content)

${pipedContent.slice(0, 50000)}

`;
    }

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

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set content for piping to next command (e.g., /fediso)
    ctx.pipedContent = generatedContent;
    
    // Debug logging
    if (outputChannel) {
        outputChannel.appendLine(`[AstraCode] /requirements: Generated ${generatedContent?.length || 0} chars for piping`);
    }
    
    // Suggest next step only if not being piped
    if (!ctx.isPiped) {
        response.markdown(`\n\n---
**Next steps:**
- \`@astra /fediso ${query || ''}\` → Map to ISO 20022
- \`@astra /requirements ${query || ''} /fediso /gencode\` → Full pipeline`);
    }
}

module.exports = { handle };
