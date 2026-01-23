/**
 * /history command - Use previous responses as context
 * 
 * Usage:
 * @astra /history                                - Show last 3 responses
 * @astra /history 5                              - Show last 5 responses
 * @astra /history 5 /requirements                - Pipe history to requirements
 * @astra /history 1 clarify the API payload      - Ask follow-up about last response
 * @astra /history 3 what validation rules?       - Ask question about last 3 responses
 */

const { streamResponse } = require('../llm/copilot');

const systemPrompt = `You are an expert assistant continuing a previous conversation.
Use the provided conversation history to answer the user's follow-up question.
Be specific and reference details from the previous responses.
If the question asks for clarification, provide detailed explanation.
If asked about code, include relevant code snippets in your response.`;

/**
 * Extract conversation history
 */
function extractHistory(chatContext, count) {
    let historyContent = '';
    let extractedCount = 0;
    const turns = [];
    
    if (!chatContext?.history?.length) {
        return { content: '', count: 0, turns: [] };
    }
    
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
            turns.unshift({ user: userPrompt, assistant: responseText });
            extractedCount++;
        }
    }
    
    // Build formatted history
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        historyContent += `### Conversation ${i + 1}\n`;
        historyContent += `**User:** ${turn.user}\n\n`;
        historyContent += `**Assistant:** ${turn.assistant}\n\n`;
        historyContent += `---\n\n`;
    }
    
    return { content: historyContent, count: extractedCount, turns };
}

async function handle(ctx) {
    const { query, response, outputChannel, token, chatContext } = ctx;
    
    // Parse: [number] [question or nothing]
    // Examples: "3", "5 /requirements", "1 clarify the payload", "what about errors?"
    const trimmed = (query || '').trim();
    
    let count = 3; // default
    let followUpQuestion = '';
    
    // Check if starts with number
    const match = trimmed.match(/^(\d+)\s*(.*)/);
    if (match) {
        count = Math.min(Math.max(parseInt(match[1], 10), 1), 10); // 1-10
        followUpQuestion = match[2].trim();
    } else if (trimmed) {
        // No number, entire thing is the question (use default count)
        followUpQuestion = trimmed;
    }
    
    // Check if no history
    if (!chatContext?.history?.length) {
        response.markdown(`⚠️ **No chat history available.**

Start a conversation first, then use \`/history\` to reference previous responses.

**Examples:**
\`\`\`
@astra how does OFAC screening work?
@astra /history clarify the validation rules     ← Ask follow-up
@astra /history 3 /requirements                  ← Pipe to command
\`\`\``);
        return;
    }
    
    // Extract history
    const { content: historyContent, count: extractedCount, turns } = extractHistory(chatContext, count);
    
    if (extractedCount === 0) {
        response.markdown(`⚠️ **No substantial responses found in history.**`);
        return;
    }
    
    // Check if follow-up is a command (starts with /)
    if (followUpQuestion.startsWith('/')) {
        // This is a pipe to another command - set pipedContent and let participant handle it
        ctx.pipedContent = historyContent;
        
        response.markdown(`## 📜 Chat History (Last ${extractedCount} responses)

**Piping to ${followUpQuestion}...**

`);
        outputChannel?.appendLine(`[AstraCode] /history: ${historyContent.length} chars piped to ${followUpQuestion}`);
        return;
    }
    
    // If there's a follow-up question, answer it using Copilot
    if (followUpQuestion) {
        response.markdown(`## 💬 Follow-up on Last ${extractedCount} Response${extractedCount > 1 ? 's' : ''}

**Question:** ${followUpQuestion}

---

`);
        
        const userPrompt = `## Previous Conversation
${historyContent}

## Follow-up Question
${followUpQuestion}

Please answer the follow-up question based on the conversation history above. Be specific and reference details from the previous responses.`;

        await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
        
        // Set piped content in case user chains another command
        ctx.pipedContent = historyContent;
        return;
    }
    
    // No question - just display the history and set for piping
    ctx.pipedContent = historyContent;
    
    const charCount = historyContent.length;
    const preview = historyContent.length > 2000 
        ? historyContent.slice(0, 2000) + '\n\n*... [truncated for display]*' 
        : historyContent;
    
    response.markdown(`## 📜 Chat History (Last ${extractedCount} responses)

**Extracted:** ${extractedCount} turns (~${Math.round(charCount / 1000)}k chars)

${preview}

---
**Ask follow-up:**
\`\`\`
@astra /history ${count} clarify the API payload details
@astra /history ${count} what validation rules are used?
\`\`\`

**Pipe to commands:**
\`\`\`
@astra /history ${count} /requirements
@astra /history ${count} /deepwiki
\`\`\``);
}

module.exports = { handle };
