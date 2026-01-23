# AstraCode

AI-powered legacy modernization, ISO 20022 migration, and Java code generation for VS Code.

## Quick Start

```
@astra /requirements OFAC screening /fediso /gencode
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/requirements` | Extract business requirements | `@astra /requirements OFAC` |
| `/fediso` | Map to ISO 20022 standards | `@astra /fediso wire transfer` |
| `/gencode` | Generate Java code | `@astra /gencode payment service` |
| `/deepwiki` | Generate documentation | `@astra /deepwiki .` (entire repo) |
| `/conf.r` | Read Confluence page(s) | `@astra /conf.r Page1, Page2` |
| `/conf.w` | Write to Confluence | `@astra /conf.w My Page Title` |
| `/history` | Use previous responses / ask follow-up | `@astra /history 3 clarify the API` |
| `/describe` | Explain code | `@astra /describe function_name` |
| `/find` | Search code | `@astra /find partprune` |
| `/translate` | Translate legacy code | `@astra /translate PROC_NAME` |
| `/stats` | Workspace statistics | `@astra /stats` |
| `/clear` | Clear context help | `@astra /clear` |
| `/help` | Show help | `@astra /help` |

## Input Sources

AstraCode can use multiple input sources (combinable):

| Source | How to Use |
|--------|------------|
| 🔍 **Workspace** | Provide a query: `@astra /requirements OFAC` |
| 📎 **Attachments** | Drag files into chat (PDFs, docs, code) |
| 🔗 **Confluence** | `@astra /conf.r Page Name /requirements` |
| 📜 **History** | `@astra /history 5 /requirements` |

## Pipelines

Chain commands with `/`:

```bash
# Full modernization pipeline
@astra /requirements OFAC /fediso /gencode

# From Confluence
@astra /conf.r Design Spec /requirements /fediso /gencode

# From chat history
@astra /history 5 /requirements /fediso

# Then publish
@astra /conf.w Generated OFAC Service
```

## Confluence Integration

### OAuth (Enterprise SSO)
1. Register app at https://developer.atlassian.com/console/myapps/
2. Add OAuth 2.0, callback: `vscode://astracode.astracode/auth/callback`
3. Set `astracode.confluence.clientId` in VS Code settings
4. Run **Confluence: Sign In** from command palette (Cmd+Shift+P)

### API Token (Simple)
```json
{
  "astracode.confluence.baseUrl": "https://company.atlassian.net/wiki",
  "astracode.confluence.spaceKey": "DEV",
  "astracode.confluence.username": "your.email@company.com",
  "astracode.confluence.apiToken": "your-api-token"
}
```

## Code Generation Settings

Configure in **VS Code Settings** → search "astracode":

| Setting | Options | Default |
|---------|---------|---------|
| `codegen.framework` | springboot, quarkus, micronaut, jakarta | springboot |
| `codegen.messaging` | kafka, rabbitmq, activemq, jms, sqs | kafka |
| `codegen.architecture` | microservice, lambda, monolith, hexagonal | microservice |
| `codegen.deployment` | ocp, kubernetes, aws-lambda, aws-ecs, vm | kubernetes |
| `codegen.persistence` | jpa, jdbc, r2dbc, mongodb, dynamodb | jpa |
| `codegen.javaVersion` | 17, 21, 11 | 17 |

## Examples

### Extract Requirements from Legacy Code
```
@astra /requirements wire transfer processing
```

### Document Entire Repository
```
@astra /deepwiki .
@astra /conf.w Project Documentation
```

### Generate Code from Confluence Spec
```
@astra /conf.r API Specification /requirements /gencode
```

### Use Chat History
```
@astra how does payment validation work?
@astra what about error handling?

# Ask follow-up questions
@astra /history 2 clarify the payload structure
@astra /history 1 what validation rules are used?

# Pipe to commands
@astra /history 2 /requirements
```

### With Attachments
```
[Drag vendor-spec.pdf into chat]
@astra /requirements payment processing
```

## Aliases

| Alias | Command |
|-------|---------|
| `/reqs` | `/requirements` |
| `/iso` | `/fediso` |
| `/code` | `/gencode` |
| `/wiki` | `/deepwiki` |
| `/hist` | `/history` |
| `/reset` | `/clear` |

## Tips

- **Clear attachments:** Press `Cmd+L` (Mac) / `Ctrl+L` (Windows)
- **Check logs:** Output panel → AstraCode
- **Follow-ups work:** Just ask `@astra` follow-up questions naturally

## Version

v0.8.4
