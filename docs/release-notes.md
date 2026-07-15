# Release Notes

## 2026-07-14

### Director Production Workspace Improvements

- Required property address before creating/importing a project.
- Improved hero selection to avoid side-elevation bias unless appropriate.
- Expanded scene taxonomy with `exterior-side` and `primary-bathroom`.
- Added scene confidence alternatives in analysis output.
- Improved virtual staging recommendation behavior to avoid over-rejecting high-quality staged photos.
- Improved floor-plan separation from photo analysis and counts.
- Improved RAW/edited duplicate pairing logic.
- Added friendly photo naming in the workspace UI.
- Added clickable executive-summary findings that jump to relevant assets.
- Added larger photo preview modal from thumbnails.
- Preserved ranking location when scene classification is edited.
- Expanded Director Conversation with image previews and explanation-rich recommendations.
- Added recursive drag/drop folder import handling for nested media.
- Added Matterport workspace support with validated Matterport/Zillow3D/virtual-tour URLs persisted per project.
- Expanded Walkthrough with timeline, property fact panel, seller summary, follow-up questions, and listing notes.
- Improved local developer experience: `npm run dev` now starts watch build + server, auto-opens browser, auto-selects available port, and enables live reload.

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
