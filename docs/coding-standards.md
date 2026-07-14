# Director OS Coding Standards

## Core Standards

- Write clear, maintainable, and testable code.
- Keep modules small and focused on one responsibility.
- Avoid hidden side effects and implicit behavior.
- Prefer composition over deep inheritance.

## Naming and Structure

- Use descriptive names for files, functions, and variables.
- Keep consistent naming conventions across all packages.
- Organize code by domain and feature boundaries.

## Quality Requirements

- Add tests for business-critical logic.
- Validate inputs at service boundaries.
- Handle errors explicitly with actionable messages.
- Use structured logging for operational visibility.

## Security and Data

- Never hardcode secrets or credentials.
- Apply least-privilege access for services and users.
- Sanitize and validate all external inputs.
- Protect sensitive data in transit and at rest.

## AI and Integrations

- Treat AI-generated output as untrusted until validated.
- Log integration failures with traceable context.
- Design integration adapters to fail safely and recover cleanly.
