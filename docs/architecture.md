# Director OS Architecture

## Overview

Director OS is an AI-powered operating system for real estate teams, designed as a modular platform with clear boundaries between applications and shared packages.

## Project Structure

- `apps/`: Deployable applications and interfaces.
- `packages/`: Shared libraries and platform modules.
- `docs/`: Architecture, standards, and planning documentation.

## Runtime Architecture (Current)

### Intake Web Flow

1. User selects or drops an unnamed listing folder.
2. Browser classifies media types and extracts image-level signals from canvas pixel data.
3. Analysis pipeline computes quality, marketing, scene, problem, and recommendation outputs.
4. Results render as dashboard cards, executive summary, hero ranking, and editable sequencing table.
5. Reports export to text and JSON for downstream use.

### Vision Pipeline (Director Vision Engine v1)

- Input: extracted image signals (brightness, contrast, saturation, sharpness, edge density, color ratios, etc.).
- Scene Detection: maps each image to a structured real estate scene taxonomy with confidence.
- Photo Quality: produces 12 normalized quality dimensions.
- Marketing Analysis: produces hero score, Zillow appeal, MLS appeal, luxury appeal, emotional impact, click likelihood.
- Problem Detection: flags staging and technical blockers with confidence.
- Recommendations: keep, retake, edit, remove, move-earlier, move-later with confidence and rationale.

## Package Boundaries

- `packages/ai`: AI orchestration, prompt workflows, and decision support logic.
- `packages/database`: Data access, schema management, and persistence services.
- `packages/shared`: Shared utilities, types, constants, and cross-cutting helpers.
- `packages/auth`: Authentication, authorization, and identity management.
- `packages/ui`: Reusable UI components, design tokens, and presentation primitives.
- `packages/integrations`: External system connectors and integration adapters.

## Design Principles

- Keep domain logic isolated from infrastructure details.
- Prefer explicit interfaces between packages.
- Build for observability, testability, and maintainability.
- Enforce least-privilege access across all services.
- Treat AI outputs as advisory unless explicitly validated.

## Implementation Notes

- Current vertical slice is web-first and browser-executed.
- Analysis is deterministic and local in v1, with AI-shaped structured outputs.
- Integration seams are preserved for future hosted model backends and connector pipelines.
