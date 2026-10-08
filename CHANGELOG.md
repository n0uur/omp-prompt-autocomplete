# Changelog

## 0.2.2 — 2026-10-09

### Fixed

- **Suggestions no longer answer back.** The model sometimes suggested the agent's reply instead of your next words (`Please fix this issue` → ` Yeah I will do that`). The system prompt now says suggestions are the user's own words addressed to the agent: it may still suggest a next sentence (another instruction, detail or question), but it never answers, acknowledges or agrees to the message. As a backstop, a suggestion that opens with an acknowledgement (`Sure,`, `Yeah I…`, `Got it.`) is dropped, and so is one that starts a new sentence with the agent committing to act (`I'll…`, `Let me check…`). Mid-sentence words like `make sure` or `is it OK to` are unaffected.
- **Refine no longer changes model names and versions.** "Polish", "Fix grammar only" and the other presets would rewrite names newer than the refine model knows: `Claude Haiku 5.5` became `Claude Haiku 3.5`, and even `Gemini 3.1 Flash Lite` became `Gemini 1.5`. This happened in 24 of 40 live test runs. The model is now told that names and versions are correct as written, and it is given the list of numbers in the draft. A rewrite that drops one of them, or adds a version mentioned nowhere in the draft, instruction or background, is rejected like a lost attachment placeholder, and your draft stays unchanged. The same 40 runs now keep every version.

## 0.2.1 — 2026-09-30

### Changed

- Package metadata now includes `homepage`, `repository` and `bugs`, which point to [GitHub](https://github.com/n0uur/omp-prompt-autocomplete). The npm page links there and shows the README demo GIF.

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
