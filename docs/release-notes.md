# Release Notes

## 2026-07-14

### Director Vision Engine v1

- Added structured analysis pipeline for each photo:
  - scene detection
  - quality scoring
  - marketing scoring
  - problem detection
  - confidence-based recommendations
- Added expandable per-photo analysis cards in the intake dashboard.
- Added Executive Summary panel with strengths, weaknesses, missing shots, hero recommendation, and estimated MLS readiness.
- Preserved existing intake capabilities:
  - drag/drop and folder intake
  - media counts
  - duplicate/similarity grouping
  - filtering and manual overrides
  - MLS sequencing
  - text/JSON exports

### Developer Experience

- Added root standard script alias:
  - npm run dev -> npm run mvp
- Existing scripts remain available:
  - npm run build
  - npm run test
  - npm run lint
  - npm run typecheck
  - npm run mvp
