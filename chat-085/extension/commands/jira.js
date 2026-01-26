/**
 * /jira command - Format content as Jira issue/story
 * 
 * Usage:
 * @astra /requirements OFAC /jira           - Format requirements as Jira story
 * @astra /history 3 /jira                   - Format conversation as Jira issue
 * @astra /jira                              - Format previous response as Jira
 * @astra /jira bug                          - Format as bug (vs story)
 * @astra /jira epic                         - Format as epic
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { streamResponse } = require('../llm/copilot');

/**
 * Load prompt from file
 */
function loadPrompt() {
    try {
        const promptPath = path.join(__dirname, '..', 'prompts', 'jira.md');
        return fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
        // Fallback if file not found
        return `Format the content as a Jira issue with:
- Summary (one line)
- Description (detailed)
- Acceptance Criteria (bullet points)
- Technical Notes
- Story Points estimate
- Suggested Labels`;
    }
}

/**
 * Extract history content (for standalone use)
 */
function extractHistoryContent(chatContext, count = 3) {
    let content = '';
    let extracted = 0;
    
    if (!chatContext?.history?.length) return '';
    
    for (let i = chatContext.history.length - 1; i >= 0 && extracted < count; i--) {
        const turn = chatContext.history[i];
        let responseText = '';
        
        if (turn.response?.length > 0) {
            for (const part of turn.response) {
                if (part.value && typeof part.value === 'string') {
                    responseText += part.value;
                } else if (part.value?.value) {
                    responseText += part.value.value;
                }
            }
        }
        
        if (responseText.length > 50) {
            content = responseText + '\n\n---\n\n' + content;
            extracted++;
        }
    }
    
    return content;
}

async function handle(ctx) {
    const { query, response, outputChannel, token, chatContext, isPiped, previousOutput, pipedContent: ctxPipedContent } = ctx;
    
    // Check for piped content
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    // Parse issue type from query
    const queryLower = (query || '').toLowerCase().trim();
    let issueType = 'story';
    if (queryLower.includes('bug')) issueType = 'bug';
    else if (queryLower.includes('epic')) issueType = 'epic';
    else if (queryLower.includes('task')) issueType = 'task';
    else if (queryLower.includes('spike')) issueType = 'spike';
    
    // Get content from various sources
    let inputContent = '';
    
    if (hasPipedContent) {
        inputContent = pipedContent;
    } else {
        // Try to get from chat history
        inputContent = extractHistoryContent(chatContext, 3);
    }
    
    if (inputContent.length < 50) {
        response.markdown(`**Usage:** \`@astra /jira [type]\`

Formats content as a Jira issue/story.

**Issue Types:** \`story\` (default), \`bug\`, \`epic\`, \`task\`, \`spike\`

**Piped from commands:**
\`\`\`
@astra /requirements OFAC /jira
@astra /requirements OFAC /jira bug
@astra /history 5 /jira epic
\`\`\`

**From previous response:**
\`\`\`
@astra /requirements payment validation
@astra /jira
\`\`\`

**Customize the prompt:**
Edit \`prompts/jira.md\` in the extension folder.
`);
        return;
    }
    
    // Load and prepare prompt
    const basePrompt = loadPrompt();
    const pipedFrom = previousOutput?.command || 'previous response';
    
    response.markdown(`## 🎫 Formatting as Jira ${issueType.charAt(0).toUpperCase() + issueType.slice(1)}

📋 *Using content from ${hasPipedContent ? `/${pipedFrom}` : 'chat history'}*

---

`);
    
    // The system prompt emphasizes completeness and following the format
    const systemPrompt = `You are an expert Business Analyst writing Jira issues.

CRITICAL INSTRUCTIONS:
1. **CAPTURE EVERY REQUIREMENT** - Do not skip, summarize, or omit ANY requirement from the input
2. **Follow the exact format** specified below - use the same headers and structure
3. **Be comprehensive** - Include all scenarios, edge cases, business rules, and technical details
4. **Maintain traceability** - Number requirements (REQ-001, REQ-002) so they can be traced to acceptance criteria

${basePrompt}

You are formatting this as a Jira **${issueType.toUpperCase()}**.
${issueType === 'bug' ? '\nAdditional sections for BUG:\n- Steps to Reproduce (numbered steps)\n- Expected Behavior\n- Actual Behavior\n- Severity: Critical/Major/Minor/Trivial\n- Environment details' : ''}
${issueType === 'epic' ? '\nAdditional sections for EPIC:\n- Business Value statement\n- Child Stories breakdown (list potential stories)\n- Timeline estimate\n- Success Metrics' : ''}
${issueType === 'spike' ? '\nAdditional sections for SPIKE:\n- Research Questions (numbered)\n- Time-box: [X days/hours]\n- Expected Deliverables\n- Decision Criteria' : ''}
`;

    const userPrompt = `Analyze the following content and create a comprehensive Jira ${issueType}.

IMPORTANT: 
- Extract and list EVERY requirement, scenario, and business rule
- Do not summarize or skip any details
- Follow the exact output format from the instructions
- Number all requirements for traceability

## Input Content to Analyze

${inputContent.slice(0, 80000)}

---

Create the Jira ${issueType} now, ensuring ALL requirements from the input are captured.`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping to next command
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    response.markdown(`

---
**Copy to Jira** or continue:
- \`@astra /jira bug\` → Reformat as bug
- \`@astra /jira epic\` → Reformat as epic
`);
}

module.exports = { handle };
