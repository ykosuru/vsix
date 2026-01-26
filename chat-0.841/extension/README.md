# AstraCode

AI-powered legacy modernization, ISO 20022 migration, and Java code generation for VS Code.

## Quick Start

```bash
# Fresh code generation with spec
@astra /gencode /source llm /spec pacs008 credit transfer service

# Extract requirements and generate code
@astra /requirements OFAC screening /fediso /gencode

# Iteratively enhance code
@astra /augment add validation
@astra /augment /source h,w learn patterns from MT103
```

## The /source Modifier

Control where commands get their input:

| Option | Meaning | Example |
|--------|---------|---------|
| `llm` | Pure LLM (no context) | `/source llm` |
| `h` | History (previous response) | `/source h` |
| `w` | Workspace (search codebase) | `/source w` |
| `a` | Attachments (attached files) | `/source a` |

**Combine:** `/source h,w` or `/source w,a` or `/source h,w,a`

### Command Defaults

| Command | Default | What It Means |
|---------|---------|---------------|
| `/gencode` | `h` | Uses previous response (requirements, logic) |
| `/augment` | `h` | Enhances previous code |
| `/requirements` | `w,a` | Searches workspace + reads attachments |
| `/logic` | `w,a` | Searches workspace + reads attachments |

### Examples

```bash
# Fresh generation (no context)
@astra /gencode /source llm payment service

# Build on previous requirements
@astra /requirements OFAC screening
@astra /gencode                         # Uses requirements above

# Learn from workspace
@astra /augment /source h,w add error handling like MT103

# Attachments only
@astra /requirements /source a          # Only attached files
```

## Commands

| Command | /source | Description |
|---------|:-------:|-------------|
| `/gencode` | ✅ | Generate Java code |
| `/augment` | ✅ | Enhance code iteratively |
| `/requirements` | ✅ | Extract business requirements |
| `/logic` | ✅ | Extract business logic |
| `/fediso` | | Map to ISO 20022 |
| `/deepwiki` | | Generate documentation |
| `/jira` | | Format as Jira issue |
| `/describe` | | Explain code |
| `/find` | | Search workspace |
| `/stats` | | Workspace statistics |
| `/conf.r` | | Read Confluence |
| `/conf.w` | | Write to Confluence |
| `/history N` | | Use N previous responses |
| `/help` | | Show help |

## Spec Files (/spec)

Load domain schemas from `prompts/specs/`:

```bash
@astra /gencode /source llm /spec pacs008 credit transfer service
```

| Format | Use Case |
|--------|----------|
| `.xsd` | XML Schema (ISO 20022, SWIFT) |
| `.xml` | XML samples |
| `.json` | JSON schema/samples |
| `.md` | Markdown documentation |

**Add your own:** Drop files in `prompts/specs/`

## Pipelines

Chain commands - output flows automatically:

```bash
# Full modernization pipeline
@astra /requirements OFAC /fediso /gencode

# From Confluence
@astra /conf.r Design Spec /requirements /gencode

# Iterative enhancement
@astra /logic MT103 /gencode /augment add validation
```

## Iterative Workflow

```bash
# 1. Generate fresh code
@astra /gencode /source llm /spec pacs008 credit transfer

# 2. Add features
@astra /augment add input validation
@astra /augment add exception handling

# 3. Learn from workspace
@astra /augment /source h,w add MT103 retry patterns

# 4. Polish
@astra /augment add logging and metrics

# 5. Create ticket
@astra /jira epic
```

## Code Generation Settings

Configure in **VS Code Settings** → search "astracode":

| Setting | Default | Options |
|---------|---------|---------|
| `codegen.framework` | springboot | quarkus, micronaut |
| `codegen.architecture` | microservice | hexagonal, monolith |
| `codegen.persistence` | jpa | jdbc, mongodb |
| `codegen.messaging` | kafka | rabbitmq, sqs |

## Confluence Integration

### OAuth (Enterprise SSO)
1. Register app at https://developer.atlassian.com/console/myapps/
2. Add OAuth 2.0, callback: `vscode://astracode.astracode/auth/callback`
3. Set `astracode.confluence.clientId` in VS Code settings
4. Run **Confluence: Sign In** from command palette

### API Token (Simple)
```json
{
  "astracode.confluence.baseUrl": "https://company.atlassian.net/wiki",
  "astracode.confluence.spaceKey": "DEV",
  "astracode.confluence.username": "your.email@company.com",
  "astracode.confluence.apiToken": "your-api-token"
}
```

## Customization

| File | Purpose |
|------|---------|
| `prompts/gencode.md` | Code generation guidelines |
| `prompts/augment.md` | Enhancement guidelines |
| `prompts/logic.md` | Logic extraction format |
| `prompts/jira.md` | Jira ticket format |
| `prompts/specs/*.xsd` | Domain specifications |

## Tips

- **Clear attachments:** `Cmd+L` (Mac) / `Ctrl+L` (Windows)
- **Check logs:** Output panel → AstraCode
- **Piped content overrides /source:** In pipelines, output flows automatically

## Version

v0.8.5
