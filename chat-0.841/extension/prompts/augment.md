# Code Augmentation Instructions

## Purpose

Enhance existing code based on the provided instructions and reference sources.

---

## Augmentation Modes
ß
### 1. Pure LLM Enhancement
When no reference code provided, use best practices to enhance:
- Add exception handling
- Add logging
- Add retry logic
- Refactor patterns
- Add documentation

### 2. Learn from Reference
When reference code (workspace/attachments) provided:
- Extract patterns from reference
- Apply similar patterns to target code
- Preserve reference's error handling approach
- Match reference's coding style where appropriate

---

## Output Format

```
## Augmented Code

### Changes Made
- [Change 1]: [Description]
- [Change 2]: [Description]

### Code

[Complete updated code - not just the changes]

### Notes
- [Any important notes about the changes]
```

---

## Guidelines

1. **Preserve Functionality**: Never break existing functionality
2. **Complete Code**: Output the full updated code, not patches
3. **Explain Changes**: List what was added/modified
4. **Match Style**: Follow the existing code style
5. **Learn Patterns**: When reference provided, extract and apply patterns intelligently
6. **Be Conservative**: Only change what's requested

---

## When Learning from Reference

Extract these patterns:
- Exception handling approach
- Logging patterns
- Validation logic
- Retry/recovery patterns
- Naming conventions
- Code organization
- Comment style
