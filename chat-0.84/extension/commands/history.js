/**
 * /history command - Use previous responses as context
 * 
 * Usage:
 * @astra /history 3                    - Use last 3 responses as context
 * @astra /history 5 /requirements      - Pipe history to requirements
 * @astra /history                      - Default: last 3 responses
 */

async function handle(ctx) {
    const { query, response, outputChannel, chatContext } = ctx;
    
    // Parse number from query (default 3)
    const match = query.match(/^(\d+)/);
    const count = match ? Math.min(parseInt(match[1], 10), 10) : 3; // Max 10
    
    if (!chatContext?.history?.length) {
        response.markdown(`⚠️ **No chat history available.**

Start a conversation first, then use \`/history\` to reference previous responses.

**Examples:**
\`\`\`
@astra how does OFAC screening work?
@astra /history /requirements           ← Extract requirements from above
@astra /history 5 /deepwiki             ← Document last 5 responses
\`\`\``);
        return;
    }
    
    // Extract last N responses
    let historyContent = '';
    let extractedCount = 0;
    
    for (let i = chatContext.history.length - 1; i >= 0 && extractedCount < count; i--) {
        const turn = chatContext.history[i];
        
        // Get user prompt
        const userPrompt = turn.prompt || '';
        
        // Get assistant response
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
            // Prepend (we're going backwards)
            const turnContent = `### Turn ${extractedCount + 1}\n**User:** ${userPrompt}\n\n**Response:**\n${responseText}\n\n---\n\n`;
            historyContent = turnContent + historyContent;
            extractedCount++;
        }
    }
    
    if (extractedCount === 0) {
        response.markdown(`⚠️ **No substantial responses found in history.**`);
        return;
    }
    
    // Set as piped content for next command
    ctx.pipedContent = historyContent;
    
    // Show what was extracted
    const charCount = historyContent.length;
    response.markdown(`## 📜 Chat History (Last ${extractedCount} responses)

**Extracted:** ${extractedCount} turns (~${Math.round(charCount / 1000)}k chars)

${historyContent.length > 3000 ? historyContent.slice(0, 3000) + '\n\n*... [truncated for display, full content piped to next command]*' : historyContent}

---
**Pipe to commands:**
\`\`\`
@astra /history ${count} /requirements    ← Extract requirements
@astra /history ${count} /deepwiki        ← Generate documentation  
@astra /history ${count} /fediso          ← Map to ISO 20022
\`\`\``);
}

module.exports = { handle };
