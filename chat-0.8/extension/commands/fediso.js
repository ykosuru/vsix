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
    const { query, response, outputChannel, token, request, isPiped, previousOutput } = ctx;
    
    if (!query.trim() && !isPiped) {
        response.markdown(`**Usage:** \`@astra /fediso <business area>\`

Maps legacy functionality to ISO 20022 message standards.

**Examples:**
- \`@astra /fediso OFAC screening\`
- \`@astra /fediso wire transfer\`
- \`@astra /requirements payment processing /fediso\` ← piped!

**Supported Message Types:**
| Type | Description |
|------|-------------|
| pacs.008 | Customer Credit Transfer |
| pacs.002 | Payment Status Report |
| pacs.004 | Payment Return |
| camt.056 | Cancellation Request |

**Workflow:**
\`\`\`
@astra /requirements <area> /fediso   ← Chain commands!
\`\`\``);
        return;
    }
    
    // If piped from /requirements, note it
    if (isPiped && previousOutput) {
        response.markdown(`*Mapping requirements from \`/${previousOutput.command}\` to ISO 20022...*\n\n`);
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
    
    // Search workspace for code
    response.progress('Analyzing for ISO 20022 mapping...');
    const { context, files, totalLines } = await getWorkspaceContext(query, {
        maxFiles: 15,
        maxLinesPerFile: 350
    });
    
    if (!context && !attachedDocs) {
        response.markdown(`⚠️ **No code or documents found for:** "${query}"`);
        return;
    }
    
    const fileCount = files?.length || 0;
    const docInfo = hasAttachments ? ' + specs' : '';
    
    // Show files being used
    let filesUsed = `📄 **Mapping ${fileCount} files to ISO 20022${docInfo}**\n\n`;
    
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
        filesUsed += `<details><summary>📎 Attached specs (${attachedDocNames.length})</summary>\n\n`;
        for (const name of attachedDocNames) {
            filesUsed += `- \`${name}\`\n`;
        }
        filesUsed += `\n</details>\n\n`;
    }
    
    response.markdown(filesUsed);
    
    let userPrompt = `Map legacy functionality to ISO 20022: ${query}

`;

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

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
