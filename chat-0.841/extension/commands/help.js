/**
 * /help command
 */

function handle(ctx) {
    const { response } = ctx;
    
    response.markdown(`# 🔍 AstraCode Help

## ⚡ Quick Reference Card

| I want to... | Command |
|--------------|---------|
| Generate fresh code | \`/gencode /source llm /spec NAME ...\` |
| Generate from requirements | \`/requirements ... /gencode\` |
| Enhance existing code | \`/augment add ...\` |
| Learn from workspace | \`/augment /source h,w learn from ...\` |
| Analyze attachments only | \`/requirements /source a\` |
| Extract business logic | \`/logic ...\` |
| Create Jira ticket | \`/jira epic\` or \`/jira story\` |

---

## 📥 The /source Modifier

Control where commands get their input data.

### Source Options

| Option | Meaning | Example |
|--------|---------|---------|
| \`llm\` | Pure LLM - no context | \`/source llm\` |
| \`h\` | History - previous response | \`/source h\` |
| \`w\` | Workspace - search codebase | \`/source w\` |
| \`a\` | Attachments - attached files | \`/source a\` |

### Combining Sources

\`\`\`
/source h,w      ← History + Workspace
/source h,a      ← History + Attachments  
/source w,a      ← Workspace + Attachments
/source h,w,a    ← All three
\`\`\`

### Command Defaults

| Command | Default | What It Means |
|---------|---------|---------------|
| \`/gencode\` | \`h\` | Uses previous response as input |
| \`/augment\` | \`h\` | Enhances previous code |
| \`/requirements\` | \`w,a\` | Searches workspace + reads attachments |
| \`/logic\` | \`w,a\` | Searches workspace + reads attachments |

### Important: Piped Content Overrides /source

When you chain commands, piped content **always** takes priority:

\`\`\`
@astra /requirements OFAC /gencode
        ↑                   ↑
        │                   └── Uses /requirements output (piped)
        └── Searches workspace (default)
\`\`\`

So \`/gencode\` receives the requirements even without \`/source h\`.

---

## 🚀 Workflows

### Fresh Code Generation
\`\`\`
@astra /gencode /source llm /spec pacs008 credit transfer service
@astra /augment add validation
@astra /augment add exception handling
@astra /augment /source h,w learn retry patterns from MT103
@astra /jira epic
\`\`\`

### Requirements → ISO → Code Pipeline
\`\`\`
@astra /requirements OFAC screening
@astra /fediso
@astra /gencode
\`\`\`

### Analyze Attachments Only
\`\`\`
[Attach: design-spec.pdf, api-doc.md]
@astra /requirements /source a payment processing
\`\`\`

### Learn from Existing Code
\`\`\`
@astra /gencode /source llm payment service
@astra /augment /source h,w add error handling like PaymentProcessor
\`\`\`

---

## 📋 Commands Reference

### Code Generation

| Command | /source | Default | Description |
|---------|:-------:|---------|-------------|
| \`/gencode\` | ✅ | \`h\` | Generate Java code |
| \`/augment\` | ✅ | \`h\` | Enhance code iteratively |

### Analysis

| Command | /source | Default | Description |
|---------|:-------:|---------|-------------|
| \`/requirements\` | ✅ | \`w,a\` | Extract business requirements |
| \`/logic\` | ✅ | \`w,a\` | Extract business logic |
| \`/describe\` | | | Explain code functionality |
| \`/find\` | | | Search for code |
| \`/stats\` | | | Workspace/attachment statistics |

### Documentation & Output

| Command | Description |
|---------|-------------|
| \`/fediso\` | Map to ISO 20022 |
| \`/deepwiki\` | Generate documentation |
| \`/jira\` | Format as Jira ticket |
| \`/conf.r\` | Read Confluence page(s) |
| \`/conf.w\` | Write to Confluence |

---

## 📄 Specs (/spec modifier)

Load domain specifications from \`prompts/specs/\`:

\`\`\`
@astra /gencode /source llm /spec pacs008 credit transfer
\`\`\`

| Format | Use Case |
|--------|----------|
| \`.xsd\` | XML Schema (ISO 20022, SWIFT) |
| \`.xml\` | XML samples |
| \`.json\` | JSON schema/samples |
| \`.md\` | Markdown documentation |

**Add your own:** Drop files in \`prompts/specs/\`

---

## ⚙️ Settings

Configure in **VS Code Settings** → search "astracode":

| Setting | Default | Options |
|---------|---------|---------|
| \`codegen.framework\` | springboot | quarkus, micronaut |
| \`codegen.architecture\` | microservice | hexagonal, monolith |
| \`codegen.persistence\` | jpa | jdbc, mongodb |
| \`codegen.messaging\` | kafka | rabbitmq, sqs |

---

## 🔗 Pipeline Examples

\`\`\`
@astra /requirements OFAC /fediso /gencode
@astra /conf.r Design Spec /requirements /jira
@astra /find MT103 /logic /gencode
@astra /logic payment /gencode /augment add validation
\`\`\`
`);
    
    // Add configure sources button
    response.button({
        command: 'astracode.configureSources',
        title: '⚙️ Configure Input Sources'
    });
}

module.exports = { handle };
