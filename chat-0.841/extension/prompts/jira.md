# Jira Issue Formatting Instructions

## Critical Requirement

**CAPTURE EVERY SINGLE REQUIREMENT** from the input content. Do not summarize or skip any requirements, scenarios, edge cases, or business rules. Each requirement should be traceable.

---

## Output Format

Use EXACTLY this structure (copy the headers verbatim):

```
## Summary
[One clear sentence describing the work item - max 80 characters]

## Description

### Overview
[2-3 sentences explaining the business context and why this is needed]

### Requirements
[List EVERY requirement from the input. Number them for traceability]

1. **REQ-001:** [First requirement]
2. **REQ-002:** [Second requirement]
3. **REQ-003:** [Third requirement]
[Continue for ALL requirements found in input]

### Scenarios / Use Cases
[List ALL scenarios, use cases, and user stories mentioned]

- **Scenario 1:** [Description]
- **Scenario 2:** [Description]
[Continue for ALL scenarios]

### Business Rules
[List ALL business rules and validation logic]

- BR-001: [Rule description]
- BR-002: [Rule description]
[Continue for ALL rules]

### Edge Cases & Error Handling
[List ALL edge cases, error conditions, and exception handling]

- When [condition], then [expected behavior]
- If [error condition], system should [response]

## Acceptance Criteria

[Convert requirements into testable acceptance criteria using Given/When/Then format]

- [ ] **AC-001:** Given [precondition], When [action], Then [expected result]
- [ ] **AC-002:** Given [precondition], When [action], Then [expected result]
[One AC for each requirement - maintain traceability to REQ numbers]

## Technical Notes

### Implementation Approach
[High-level technical approach]

### Dependencies
- [System/service dependencies]
- [Data dependencies]
- [External API dependencies]

### Data Requirements
- Input: [Required input data/fields]
- Output: [Expected output data/fields]
- Validation: [Data validation rules]

### Non-Functional Requirements
- Performance: [Response time, throughput expectations]
- Security: [Authentication, authorization, encryption needs]
- Compliance: [Regulatory requirements if any]

## Estimation

- **Story Points:** [1, 2, 3, 5, 8, or 13]
- **Complexity:** [Low / Medium / High]
- **Risk:** [Low / Medium / High] - [Brief risk description if Medium/High]

## Labels

[Comma-separated list of suggested labels based on content]
```

---

## Content Extraction Rules

1. **Requirements:** Look for:
   - "must", "shall", "should", "will"
   - Numbered lists
   - Bullet points describing functionality
   - Conditional statements (if/when/then)

2. **Scenarios:** Look for:
   - "when user...", "as a user..."
   - Step-by-step flows
   - Happy path and alternative paths
   - Error scenarios

3. **Business Rules:** Look for:
   - Validation logic
   - Calculations
   - Conditions and constraints
   - Thresholds and limits

4. **Edge Cases:** Look for:
   - "what if...", "in case of..."
   - Error handling descriptions
   - Boundary conditions
   - Null/empty handling

---

## Quality Checklist

Before finalizing, verify:
- [ ] Every requirement from input is captured
- [ ] Every scenario mentioned is included
- [ ] All business rules are documented
- [ ] Acceptance criteria covers all requirements
- [ ] Technical notes address implementation concerns
- [ ] Estimation is reasonable for scope

---

## Jira Wiki Markup Reference

Use these for formatting:
- **Bold:** *bold*
- Code: {{code}}
- Code block: {code}...{code}
- Bullet list: * item
- Numbered list: # item
- Table: ||header||header|| then |cell|cell|
- Link: [text|url]
- Heading: h2. Heading Text
