# Changelog

## 0.2.0 — 2026-09-30

### Added

- **Ctrl+→ accepts one word of the suggestion at a time.** It follows the `tui.editor.cursorWordRight` binding (Ctrl+→, Alt+→ and Alt+F by default) and uses Unicode word segmentation, so Thai, Japanese and Chinese advance by dictionary word. When no suggestion is shown, word-right moves the cursor as usual.
- **Prompt refine (Alt+E).** A picker offers presets (Polish, Fix grammar only, Make it concise, Make it clear for the agent, Translate to English) or accepts your own instruction. The draft is rewritten in place, and a status line under the editor shows the current state. While a rewrite is running, Esc or typing cancels it, and Enter sends the original text. After a rewrite, Esc restores the original. Omp's undo key does the same in terminals that don't claim Ctrl+- for zoom. No autocomplete suggestion is shown until you edit the rewrite. Attachment placeholders and chips must come back unchanged, otherwise the rewrite is rejected.
- `modelRoles.refine` and `/autocomplete refine-model <spec|default>` to choose the refine model. `/autocomplete status` now shows the refine model as well.
- `OMP_PROMPT_REFINE_KEY` changes the refine shortcut.

### Changed

- Packaged as a standalone omp plugin (`omp plugin install omp-prompt-autocomplete`) with `package.json#omp.extensions`, optional peer dependencies on the host packages, and dev dependencies so the tests run with `bun install && bun test`.

## 0.1.0 — 2026-09-28

- Ghost-text autocomplete in the omp prompt editor using a small cloud model through omp's provider stack. Includes session background (project, recent files, recent turns), `/autocomplete on|off|status|context|model`, and isolation from the agent's model.
