# AstraCode Architecture

## Overview

AstraCode is a VS Code Chat Participant extension that provides AI-powered legacy code analysis, ISO 20022 migration support, and Java code generation. It integrates with GitHub Copilot's Language Model API to analyze codebases and generate modernization artifacts.

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Copilot Chat                          │    │
│  │  ┌─────────────────────────────────────────────────────┐│    │
│  │  │  @astra /requirements OFAC screening /fediso        ││    │
│  │  └─────────────────────────────────────────────────────┘│    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    AstraCode Extension                   │    │
│  │  ┌───────────┐  ┌──────────┐  ┌───────────────────┐    │    │
│  │  │participant│→ │ commands │→ │ workspace-search  │    │    │
│  │  └───────────┘  └──────────┘  └───────────────────┘    │    │
│  │        │              │                │                │    │
│  │        ▼              ▼                ▼                │    │
│  │  ┌─────────────────────────────────────────────────┐   │    │
│  │  │              llm/copilot.js                      │   │    │
│  │  │         (Copilot Language Model API)             │   │    │
│  │  └─────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
astracode/
├── extension.js              # Entry point, activates extension
├── participant.js            # Chat participant handler, command routing
├── package.json              # Extension manifest, commands, settings
│
├── commands/                 # Command handlers
│   ├── index.js              # Command registry
│   ├── requirements.js       # /requirements - Extract business requirements
│   ├── fediso.js             # /fediso - ISO 20022 mapping
│   ├── gencode.js            # /gencode - Java code generation
│   ├── deepwiki.js           # /deepwiki - Wiki documentation
│   ├── describe.js           # /describe - Code explanation
│   ├── find.js               # /find - Code search
│   ├── translate.js          # /translate - Legacy code translation
│   ├── general.js            # Default handler (no command)
│   └── help.js               # /help - Show help
│
├── llm/                      # LLM integration
│   ├── copilot.js            # Copilot API wrapper
│   └── workspace-search.js   # File search and context building
│
└── utils/
    └── workspace.js          # Workspace utilities
```

## Core Components

### 1. Extension Entry Point (`extension.js`)

Activates the extension and registers the chat participant.

```javascript
function activate(context) {
    const participant = vscode.chat.createChatParticipant(
        'astracode.chat',
        (request, chatContext, response, token) => {
            return handleRequest(request, chatContext, response, token, ...);
        }
    );
}
```

### 2. Participant Handler (`participant.js`)

The central router that:
- Parses command chains (pipes)
- Routes to appropriate command handlers
- Passes context (chat history, workspace, attachments)

```
┌────────────────────────────────────────────────────────────┐
│                    participant.js                           │
│                                                             │
│  handleRequest(request, chatContext, response, token)       │
│         │                                                   │
│         ▼                                                   │
│  parseCommandChain("/requirements OFAC /fediso /gencode")   │
│         │                                                   │
│         ▼                                                   │
│  [                                                          │
│    { command: 'requirements', query: 'OFAC' },              │
│    { command: 'fediso', query: '' },                        │
│    { command: 'gencode', query: '' }                        │
│  ]                                                          │
│         │                                                   │
│         ▼                                                   │
│  Execute each command in sequence                           │
└────────────────────────────────────────────────────────────┘
```

### 3. Command Handlers (`commands/*.js`)

Each command follows a standard pattern:

```javascript
async function handle(ctx) {
    const {
        query,           // User's query text
        response,        // VS Code ChatResponseStream
        outputChannel,   // Debug output channel
        token,           // Cancellation token
        request,         // Original request (for attachments)
        chatContext,     // Chat history (for previous responses)
        isPiped,         // True if chained from another command
        previousOutput   // Info about previous command in chain
    } = ctx;
    
    // 1. Handle empty query / show help
    // 2. Read attachments if any
    // 3. Search workspace for relevant files
    // 4. Build prompt with context
    // 5. Stream response from Copilot
}
```

### 4. Workspace Search (`llm/workspace-search.js`)

Searches the workspace for files matching query terms.

```
┌─────────────────────────────────────────────────────────┐
│                  workspace-search.js                     │
│                                                          │
│  getWorkspaceContext(query, options)                     │
│         │                                                │
│         ▼                                                │
│  extractSearchTerms("partition pruning")                 │
│         │                                                │
│         ▼                                                │
│  ["partprune", "partition_pruning", "partition", ...]    │
│         │                                                │
│         ▼                                                │
│  searchFiles(workspaceRoot, terms)                       │
│         │                                                │
│         ▼                                                │
│  scoreFiles() → Sort by relevance                        │
│         │                                                │
│         ▼                                                │
│  Load file contents with line numbers                    │
│         │                                                │
│         ▼                                                │
│  { context: "### File: ...\n```c\n1: ...", files: [...]} │
└─────────────────────────────────────────────────────────┘
```

**Search Term Extraction:**

For C-style codebases, generates variations:
- `"partition pruning"` → `["partprune", "partition_pruning", "partition", "pruning", "prune"]`

### 5. Copilot Integration (`llm/copilot.js`)

Wraps the VS Code Language Model API.

```javascript
async function streamResponse(systemPrompt, userPrompt, response, outputChannel, token) {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const messages = [
        vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n${userPrompt}`)
    ];
    
    const result = await model.sendRequest(messages, {}, token);
    for await (const chunk of result.text) {
        response.markdown(chunk);
    }
}
```

## Data Flow

### Single Command Flow

```
User: @astra /requirements OFAC screening

┌──────────────┐    ┌──────────────┐    ┌─────────────────┐
│  VS Code     │───▶│ participant  │───▶│ requirements.js │
│  Chat UI     │    │   .js        │    │                 │
└──────────────┘    └──────────────┘    └────────┬────────┘
                                                  │
                    ┌─────────────────────────────┼─────────────────────────────┐
                    │                             ▼                             │
                    │  ┌──────────────────────────────────────────────────┐    │
                    │  │ 1. Read attachments (request.references)         │    │
                    │  │ 2. Search workspace (workspace-search.js)        │    │
                    │  │ 3. Build prompt with context                     │    │
                    │  │ 4. Stream to Copilot (copilot.js)                │    │
                    │  │ 5. Display response                              │    │
                    │  └──────────────────────────────────────────────────┘    │
                    │                             │                             │
                    │                             ▼                             │
                    │                    ┌─────────────────┐                    │
                    │                    │  Chat Response  │                    │
                    │                    └─────────────────┘                    │
                    └───────────────────────────────────────────────────────────┘
```

### Piped Command Flow

```
User: @astra /requirements OFAC /fediso /gencode

┌─────────────────────────────────────────────────────────────────────────┐
│                           participant.js                                 │
│                                                                          │
│  parseCommandChain() → [requirements, fediso, gencode]                   │
│                                                                          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐      │
│  │  /requirements  │───▶│    /fediso      │───▶│    /gencode     │      │
│  │                 │    │                 │    │                 │      │
│  │ isPiped: false  │    │ isPiped: true   │    │ isPiped: true   │      │
│  │ query: "OFAC"   │    │ query: "OFAC"   │    │ query: "OFAC"   │      │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘      │
│           │                      │                      │                │
│           ▼                      ▼                      ▼                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     Chat Response Stream                         │    │
│  │  [Requirements]  →  [ISO 20022 Mapping]  →  [Java Code]         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Using Previous Response (Step-by-Step Workflow)

```
User: @astra /requirements OFAC screening
      ↓ (Output displayed)
User: @astra /fediso
      ↓ (Reads previous response from chatContext)
User: @astra /gencode
      ↓ (Reads previous response from chatContext)

┌─────────────────────────────────────────────────────────────────────────┐
│                      Reading Previous Response                           │
│                                                                          │
│  if (chatContext.history.length > 0) {                                   │
│      for (turn of chatContext.history) {                                 │
│          if (turn.response) {                                            │
│              previousResponse = extractText(turn.response);              │
│          }                                                               │
│      }                                                                   │
│  }                                                                       │
│                                                                          │
│  // Include in prompt if no explicit query provided                      │
│  if (!query.trim() && previousResponse.length > 200) {                   │
│      userPrompt = `Based on previous response:\n${previousResponse}`;    │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Configuration System

Settings are defined in `package.json` and read via VS Code Configuration API.

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "astracode.codegen.framework": {
          "type": "string",
          "enum": ["springboot", "quarkus", "micronaut"],
          "default": "springboot"
        },
        "astracode.codegen.messaging": {
          "type": "string",
          "enum": ["kafka", "rabbitmq", "activemq", "none"],
          "default": "kafka"
        }
      }
    }
  }
}
```

**Reading settings in code:**

```javascript
function getCodeGenSettings() {
    const config = vscode.workspace.getConfiguration('astracode.codegen');
    return {
        framework: config.get('framework') || 'springboot',
        messaging: config.get('messaging') || 'kafka',
        // ...
    };
}
```

## Adding a New Command

### Step 1: Create Command Handler

```javascript
// commands/newcmd.js
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are an expert at...`;

async function handle(ctx) {
    const { query, response, outputChannel, token, chatContext, isPiped } = ctx;
    
    // 1. Show help if no query
    if (!query.trim() && !isPiped) {
        response.markdown(`**Usage:** \`@astra /newcmd <query>\``);
        return;
    }
    
    // 2. Search workspace
    const { context, files } = await getWorkspaceContext(query);
    
    // 3. Show files being used
    response.markdown(`📄 **Analyzing ${files.length} files**\n\n`);
    
    // 4. Build and send prompt
    const userPrompt = `Analyze: ${query}\n\n${context}`;
    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
```

### Step 2: Register in Index

```javascript
// commands/index.js
const newcmd = require('./newcmd');

const commands = {
    // ... existing commands
    newcmd: newcmd.handle,
    nc: newcmd.handle,  // alias
};
```

### Step 3: Add to Package Manifest

```json
{
  "contributes": {
    "chatParticipants": [{
      "commands": [
        { "name": "newcmd", "description": "Description here" }
      ]
    }]
  }
}
```

## Attachment Handling

Users can attach files (PDFs, specs, docs) for richer analysis.

```javascript
// Reading attachments
if (request && request.references && request.references.length > 0) {
    for (const ref of request.references) {
        if (ref.id && typeof ref.id === 'string') {
            const uri = vscode.Uri.parse(ref.id);
            const content = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf8');
            // Include in prompt
        }
    }
}
```

## Error Handling

### Model Fallback

```javascript
// llm/copilot.js
for (const model of orderedModels) {
    try {
        const result = await model.sendRequest(messages, {}, token);
        // Success - use this model
        workingModel = model;
        return;
    } catch (error) {
        // Try next model
        continue;
    }
}
// All models failed
response.markdown('⚠️ **All models failed.**');
```

### Graceful Degradation

- If workspace search finds no files → Show warning, suggest alternatives
- If attachments fail to read → Log error, continue without
- If previous response empty → Prompt user to run previous command first

## Testing

### Manual Testing

1. **Single commands:**
   ```
   @astra /requirements OFAC screening
   @astra /fediso wire transfer
   @astra /gencode payment service
   ```

2. **Piped commands:**
   ```
   @astra /requirements OFAC /fediso
   @astra /requirements payment /fediso /gencode
   ```

3. **Step-by-step (using previous response):**
   ```
   @astra /requirements OFAC
   @astra /fediso          ← should use above output
   @astra /gencode         ← should use above output
   ```

4. **With attachments:**
   ```
   [Attach: api-spec.pdf]
   @astra /requirements payment processing
   ```

### Debug Output

View logs in:
- **Output Channel:** View → Output → Select "AstraCode"
- **DevTools Console:** Help → Toggle Developer Tools → Console

## Key Design Decisions

### 1. Workspace Search over Copilot's @workspace

Initially tried using Copilot's built-in workspace search, but:
- Language Model API doesn't include workspace context automatically
- Need to explicitly load and include file contents in prompts

### 2. Search Term Generation

For C-style codebases, Copilot's query expansion generates Java-style terms (`PartitionPruner`) that miss C naming (`partprune.c`). Solution:
- Generate compound terms from user's words
- Prioritize user's exact words over AI expansion

### 3. Command Chaining

Implemented pipe syntax (`/cmd1 query /cmd2 /cmd3`) for:
- Single command execution of full workflow
- Each command sees output context from previous
- Query propagates to all commands in chain

### 4. Previous Response Access

For step-by-step workflow:
- Commands read `chatContext.history` for previous assistant responses
- Enables: `/requirements` → `/fediso` → `/gencode` as separate commands

## Performance Considerations

| Factor | Limit | Rationale |
|--------|-------|-----------|
| Max files per search | 10-25 | Token limits, response time |
| Max lines per file | 200-500 | Context window limits |
| Max total lines | 3000-5000 | ~15-25k tokens |
| Attachment size | 50k chars | Prevent memory issues |
| Search depth | 8 levels | Prevent deep recursion |

## Version History

| Version | Key Changes |
|---------|-------------|
| 0.8.0 | Simplified architecture, workspace search |
| 0.8.1 | Command chaining, file listing in output |
| 0.8.2 | `/gencode` with settings, previous response support |

## Dependencies

- **VS Code API:** `vscode` module
- **Copilot:** GitHub Copilot extension (for Language Model API)
- **Node.js Built-ins:** `fs`, `path`

No external npm dependencies required.
