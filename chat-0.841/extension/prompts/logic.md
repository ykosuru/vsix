# Business Logic Extraction Instructions

## Purpose

Extract ALL business logic from the provided code. Be exhaustive - do not skip any logic.

---

## Output Format

Use EXACTLY this structure:

```
## Business Logic: [Functionality Name]

### 1. Input Processing
[How inputs are received, parsed, validated before processing]

- **Input:** [field/parameter] - [type] - [validation rules]
- **Input:** [field/parameter] - [type] - [validation rules]

### 2. Validations & Preconditions
[All validation checks performed before main processing]

| # | Field/Condition | Rule | Error if Failed |
|---|----------------|------|-----------------|
| V1 | [field] | [must be / must not be] | [error code/message] |
| V2 | [field] | [condition] | [error code/message] |

### 3. Conditional Logic (If/Then/Else)
[All branching logic - be comprehensive]

```
IF [condition]
    THEN [action]
    ELSE IF [condition]
        THEN [action]
    ELSE [default action]
```

- **C1:** IF [condition] THEN [outcome]
- **C2:** IF [condition] THEN [outcome] ELSE [outcome]

### 4. Switch/Case Logic
[All switch statements and their cases]

```
SWITCH [variable]
    CASE [value1]: [action]
    CASE [value2]: [action]
    DEFAULT: [action]
```

### 5. Calculations & Transformations
[All mathematical operations, data transformations, mappings]

| # | Calculation | Formula | Notes |
|---|-------------|---------|-------|
| CALC1 | [name] | [formula/expression] | [when applied] |
| CALC2 | [name] | [formula/expression] | [when applied] |

### 6. Data Manipulations
[String operations, array processing, data conversions]

- **M1:** [operation] - [description]
- **M2:** [operation] - [description]

### 7. Loops & Iterations
[All loops with their purpose and exit conditions]

- **L1:** FOR EACH [item] IN [collection]: [action]
- **L2:** WHILE [condition]: [action]

### 8. External System Interactions
[All calls to external APIs, databases, services]

| System | Operation | Request | Expected Response |
|--------|-----------|---------|-------------------|
| [system name] | [GET/POST/etc] | [payload description] | [response structure] |

### 9. Response Code Handling
[How different response codes from external systems are handled]

| Source | Code/Status | Meaning | Action Taken |
|--------|-------------|---------|--------------|
| [system] | 200/OK | Success | [action] |
| [system] | 400/ERROR | Bad request | [action] |
| [system] | 500/TIMEOUT | Server error | [action] |

### 10. Exception Handling
[All try/catch blocks, error handling, fallback logic]

| Exception Type | Trigger Condition | Handling Action | Recovery |
|----------------|-------------------|-----------------|----------|
| [exception] | [when thrown] | [catch action] | [retry/fail/fallback] |

### 11. Output Processing
[How results are formatted, returned, or persisted]

- **Output:** [field/response] - [type] - [format/destination]

### 12. State Changes
[Any modifications to databases, files, session, or global state]

| Entity | Operation | Condition |
|--------|-----------|-----------|
| [table/file] | [INSERT/UPDATE/DELETE] | [when] |

### 13. Business Rules Summary
[Consolidated list of all business rules extracted]

| Rule ID | Rule Description | Source (file:line) |
|---------|------------------|-------------------|
| BR-001 | [rule] | [location] |
| BR-002 | [rule] | [location] |
```

---

## Extraction Guidelines

1. **Be Exhaustive:** Extract EVERY piece of logic, not just the main flow
2. **Include Edge Cases:** Capture all boundary conditions and special handling
3. **Trace to Source:** Reference file:line numbers where possible
4. **Preserve Intent:** Explain WHAT the logic does and WHY
5. **Note Assumptions:** Document any implicit assumptions in the code
6. **Flag Complexity:** Highlight nested conditions or complex logic

---

## What to Look For

- `if`, `else if`, `else` statements
- `switch`, `case`, `default` statements
- `for`, `foreach`, `while`, `do-while` loops
- `try`, `catch`, `finally`, `throw` blocks
- Arithmetic operators: `+`, `-`, `*`, `/`, `%`
- Comparison operators: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logical operators: `&&`, `||`, `!`, `AND`, `OR`, `NOT`
- Assignment with transformation
- Function/method calls (especially external)
- Return statements with conditions
- Null checks, empty checks, boundary checks
- Status code checks (HTTP, database, custom)
- Retry logic, circuit breakers, timeouts
