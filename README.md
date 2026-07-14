# Director OS

Director OS is an AI-powered operating system for real estate teams.

It unifies operations, intelligence, and execution into one platform that helps teams make faster decisions, coordinate work, and scale with confidence.

## Overview

Director OS is built as a modular, production-ready foundation that separates deployable applications from shared platform capabilities. The architecture is designed to support rapid product delivery while maintaining reliability, security, and long-term maintainability.

## Foundation Structure

- `apps/`: Application entry points and deployable services.
- `packages/`: Reusable platform modules.
- `docs/`: Architecture, roadmap, and engineering standards.

### Package Modules

- `packages/ai`: AI orchestration and decision-support workflows.
- `packages/database`: Data access, persistence patterns, and schema operations.
- `packages/shared`: Shared utilities, types, and cross-cutting concerns.
- `packages/auth`: Identity, authentication, and authorization capabilities.
- `packages/ui`: Reusable interface components and design primitives.
- `packages/integrations`: Connectors for third-party systems and services.

## Documentation

- `docs/architecture.md`: System architecture and package boundaries.
- `docs/roadmap.md`: Phased delivery plan and outcomes.
- `docs/coding-standards.md`: Engineering quality and implementation standards.

## Development

### Prerequisites

- Node.js LTS (see `.nvmrc`)
- npm 11+

### Install

```bash
npm install
```

### Quality Gates

```bash
npm run typecheck
npm run lint
npm test
```

### Build

```bash
npm run build
```

### Run Director Intake MVP

```bash
npm run mvp
```

Then open `http://127.0.0.1:4173` in your browser.

### Bootstrap

```bash
./scripts/bootstrap.sh
```

The repository uses npm workspaces, TypeScript project references, ESLint,
Prettier, and Vitest to keep all applications and packages consistent.
