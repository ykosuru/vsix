/**
 * /fediso command - Map legacy functionality to ISO 20022 standards
 * 
 * Takes legacy code/requirements and maps to modern ISO 20022 message standards.
 * Supports attached documents (ISO specs, vendor docs).
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are an ISO 20022 migration expert helping modernize legacy payment systems to ISO 20022.

Your task: Map legacy functionality to ISO 20022 message standards.

ISO 20022 Message Types Reference:
- **pacs.008** - FI to FI Customer Credit Transfer (wire transfers)
- **pacs.009** - FI to FI Financial Institution Credit Transfer
- **pacs.002** - Payment Status Report
- **pacs.004** - Payment Return
- **pacs.028** - FI to FI Payment Status Request
- **pain.001** - Customer Credit Transfer Initiation
- **pain.002** - Customer Payment Status Report
- **camt.053** - Bank to Customer Statement
- **camt.054** - Bank to Customer Debit/Credit Notification
- **camt.056** - FI to FI Payment Cancellation Request
- **camt.029** - Resolution of Investigation
- **head.001** - Business Application Header

Key ISO 20022 Elements:
- GrpHdr (Group Header) - Message identification, creation date
- CdtTrfTxInf (Credit Transfer Transaction Info) - Payment details
- Dbtr/Cdtr (Debtor/Creditor) - Party information
- DbtrAgt/CdtrAgt (Debtor/Creditor Agent) - Bank information
- RmtInf (Remittance Information) - Payment reference
- SplmtryData (Supplementary Data) - Extensions

OUTPUT FORMAT:

## Business Capability: <name>

### Legacy Behavior
<what the old system does - business level>

### ISO 20022 Mapping

**Message Type:** <pacs.008, camt.056, etc.>

**Field Mapping:**
| Business Concept | ISO 20022 Path | Element | Notes |
|-----------------|----------------|---------|-------|
| Transaction ID | /Document/FIToFICstmrCdtTrf/CdtTrfTxInf/PmtId/InstrId | InstrId | Unique instruction ID |
| Amount | /Document/.../InstdAmt | InstdAmt | With Ccy attribute |

**Sample XML Structure:**
\`\`\`xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <!-- key elements -->
</Document>
\`\`\`

### Migration Considerations
- New capabilities in ISO 20022
- Data enrichment opportunities
- Compliance improvements`;

async function handle(ctx) {
    const { query, response, outputChannel, token, request, chatContext, isPiped, previousOutput, pipedContent: ctxPipedContent } = ctx;
    
    // Check for directly piped content from previous command
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    // Extract previous response from chat history (fallback)
    let previousResponse = '';
    if (!hasPipedContent && chatContext && chatContext.history && chatContext.history.length > 0) {
        for (let i = chatContext.history.length - 1; i >= 0; i--) {
            const turn = chatContext.history[i];
            if (turn.response && turn.response.length > 0) {
                for (const part of turn.response) {
                    if (part.value && typeof part.value === 'string') {
                        previousResponse += part.value + '\n';
                    } else if (part.value && part.value.value) {
                        previousResponse += part.value.value + '\n';
                    }
                }
                if (previousResponse.length > 100) break;
            }
        }
    }
    
    const hasPreviousContext = hasPipedContent || previousResponse.length > 200;
    
    // Combine piped content and chat history
    const inputContent = hasPipedContent ? pipedContent : previousResponse;
    
    if (!query.trim() && !isPiped && !hasPreviousContext) {
        response.markdown(`**Usage:** \`@astra /fediso <business area>\`

Maps legacy functionality to ISO 20022 message standards.

**Examples:**
- \`@astra /fediso OFAC screening\`
- \`@astra /fediso wire transfer\`
- \`@astra /conf.r Design Spec /requirements /fediso\`

**Supported Message Types:**
| Type | Description |
|------|-------------|
| pacs.008 | Customer Credit Transfer |
| pacs.002 | Payment Status Report |
| pacs.004 | Payment Return |
| camt.056 | Cancellation Request |

**Workflow:**
\`\`\`
@astra /requirements OFAC /fediso /gencode   ← Full pipeline
@astra /conf.r Spec /requirements /fediso    ← From Confluence
\`\`\``);
        return;
    }
    
    // Show input source
    if (hasPipedContent && previousOutput) {
        response.markdown(`🔗 *Mapping content from \`/${previousOutput.command}\` to ISO 20022...*\n\n`);
    } else if (isPiped && previousOutput) {
        response.markdown(`🔗 *Mapping requirements from \`/${previousOutput.command}\` to ISO 20022...*\n\n`);
    } else if (hasPreviousContext && !query.trim()) {
        response.markdown(`📋 *Using previous response as input for ISO 20022 mapping...*\n\n`);
    }
    
    // Check for attached documents (ISO specs, etc.)
    let attachedDocs = '';
    let hasAttachments = false;
    let attachedDocNames = [];
    
    if (request && request.references && request.references.length > 0) {
        hasAttachments = true;
        response.progress('Reading attached specifications...');
        
        for (const ref of request.references) {
            try {
                let content = '';
                let fileName = '';
                
                if (ref.id && typeof ref.id === 'string') {
                    const uri = vscode.Uri.parse(ref.id);
                    const fileContent = await vscode.workspace.fs.readFile(uri);
                    content = Buffer.from(fileContent).toString('utf8');
                    fileName = path.basename(uri.fsPath);
                } else if (ref.value && typeof ref.value === 'string') {
                    content = ref.value;
                    fileName = 'attached-spec';
                }
                
                if (content) {
                    attachedDocNames.push(fileName);
                    const maxChars = 50000;
                    if (content.length > maxChars) {
                        content = content.slice(0, maxChars) + '\n... [truncated]';
                    }
                    attachedDocs += `\n### Specification: ${fileName}\n${content}\n`;
                }
            } catch (e) {
                outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
            }
        }
    }
    
    // Search workspace for code only if we have a query
    let context = '';
    let files = [];
    
    if (query.trim()) {
        response.progress('Analyzing for ISO 20022 mapping...');
        const searchResult = await getWorkspaceContext(query, {
            maxFiles: 15,
            maxLinesPerFile: 350
        });
        context = searchResult.context;
        files = searchResult.files || [];
    }
    
    if (!context && !attachedDocs && !hasPreviousContext) {
        response.markdown(`⚠️ **No input found.** Provide a query, attach documents, or pipe from another command.`);
        return;
    }
    
    const fileCount = files?.length || 0;
    const pipedFrom = hasPipedContent && previousOutput ? previousOutput.command : null;
    
    // Show all input sources
    let sourcesUsed = '**📥 Input Sources:**\n\n';
    
    if (hasPipedContent) {
        sourcesUsed += `- 🔗 **Piped content** ${pipedFrom ? `from \`/${pipedFrom}\`` : ''}\n`;
    }
    
    if (fileCount > 0) {
        sourcesUsed += `- 🔍 **Workspace code** (${fileCount} files)\n`;
    }
    
    if (hasAttachments) {
        sourcesUsed += `- 📎 **Attached specs** (${attachedDocNames.length})\n`;
    }
    
    sourcesUsed += '\n';
    
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
        sourcesUsed += `<details><summary>📎 Attached specs (${attachedDocNames.length})</summary>\n\n`;
        for (const name of attachedDocNames) {
            sourcesUsed += `- \`${name}\`\n`;
        }
        sourcesUsed += `\n</details>\n\n`;
    }
    
    response.markdown(sourcesUsed);
    
    let userPrompt = '';
    
    // If using piped content or previous response as input
    if (hasPreviousContext && !query.trim()) {
        userPrompt = `Map these requirements to ISO 20022 message standards:

## Input Content
${inputContent.slice(0, 50000)}

`;
    } else {
        userPrompt = `Map legacy functionality to ISO 20022: ${query}

`;
    }

    if (context) {
        userPrompt += `## Legacy Source Code
${context}

`;
    }

    if (attachedDocs) {
        userPrompt += `## Attached Specifications (ISO specs, vendor docs, API definitions)
${attachedDocs}

`;
    }

    userPrompt += `For each business capability identified:

1. **Describe the business requirement** (WHAT it does, not how)

2. **Identify the ISO 20022 message type(s):**
   - Which message(s) apply? (pacs.008, camt.056, etc.)
   - Is it a request, response, or notification?

3. **Create field mapping table:**
   | Business Concept | ISO 20022 Path | Element | Notes |
   
4. **Show sample XML structure** for the key elements

5. **Migration considerations:**
   - What's new/better in ISO 20022?
   - Data enrichment opportunities
   - Compliance/regulatory benefits

Focus on practical mappings that a development team can implement.`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set content for piping to next command (e.g., /gencode)
    ctx.pipedContent = generatedContent;
    
    // Suggest next step only if not being piped
    if (!isPiped) {
        response.markdown(`\n\n---
**Next step:** \`@astra /gencode\` to generate Java code from these mappings.`);
    }
}

module.exports = { handle };
