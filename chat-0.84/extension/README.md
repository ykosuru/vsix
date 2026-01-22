[README.md](https://github.com/user-attachments/files/24810215/README.md)
# AstraCode

AI-powered code analysis using GitHub Copilot.

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/find` | Search for code | `@astra /find partprune` |
| `/describe` | Describe functionality | `@astra /describe partition pruning` |
| `/deepwiki` | Generate wiki docs | `@astra /deepwiki query optimizer` |
| `/translate` | Translate legacy code | `@astra /translate PROC_NAME` |
| `/requirements` | Extract requirements | `@astra /requirements validation` |

## General Queries

Just ask questions without a command:
- `@astra how does partition pruning work?`
- `@astra explain the query optimizer`

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `astracode.preferredModel` | Copilot model to use | `gpt-4o` |

## Requirements

- VS Code 1.85+
- GitHub Copilot extension
