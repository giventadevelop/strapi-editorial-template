---
name: html-documentation-styling
description: >-
  Produces standalone or repo HTML documentation matching the MOSC design system:
  light-blue code blocks (#e8f4f8 / #0d3b66), colored section containers (usage/parameters/output),
  command blocks with Template + Copy buttons, data-command-base and data-template-command,
  Windows single-line CLI (no backslash continuations), script-name and code-highlight classes,
  parameters-list and section-intro, tables with blue gradient headers (never gray), copyable
  AI/video prompt blocks, WCAG-oriented contrast, semantic HTML. Use when creating or editing
  documentation HTML, project guides, or when the user mentions HTML documentation styling,
  command-block docs, or this skill by name.
---

# HTML documentation styling (MOSC)

## When to use

Apply this skill whenever you author or refactor **HTML documentation** (e.g. under `documentation/**/*.html`) or long-form guides that should match the project’s visual and UX standards.

## Workflow

1. Read **[reference.md](reference.md)** for the full specification: CSS snippets, command-block HTML shape, JavaScript patterns (`updateCommand`, `copyCommand`, `copyTemplateCommand`, `initializeCommands`), tables, typography, accessibility, anti-patterns, and the **Summary Checklist**.
2. For **simple pages** (no interactive CLI): still use the **color system**, **section containers**, **code/pre styling**, **tables**, **info/warning boxes**, and **no gray** section headers or code backgrounds.
3. For **script guides**: implement full **command blocks** with parameter inputs, **both** Template and Copy buttons, **`id="{command-id}-single-code"`** for the Windows single-line line, and **`DOMContentLoaded`** initialization as in reference.
4. Before finishing, run through the **Summary Checklist** at the end of [reference.md](reference.md).

## Non-negotiables (short)

| Topic | Rule |
|--------|------|
| Code / pre | Background `#e8f4f8`, text `#0d3b66`, border `#b8d4e3`; not gray or charcoal |
| Script filenames | `<code class="script-name">...</code>` (purple gradient per reference) |
| Major sections | Colored `.section-container` + `.section-header` (no plain gray blocks) |
| Tables | Blue gradient `th`, row hover; code in cells uses the same light-blue code style |
| CLI in docs | Single line for Windows; dedicated “Windows single-line” copy area when using command blocks |
| Commands | Copy controls required; interactive blocks need **Template** + **Copy** and `data-template-command` |
| Long prompts | Copy button required (`white-space: pre-wrap` body); do not ship prompt-only `<pre>` without a control |
| Styling | Prefer CSS classes in `<style>`; avoid inline styles except where the reference explicitly allows |

## Progressive disclosure

- **Templates and file skeleton**: see “File Structure Template” in [reference.md](reference.md).
- **Canonical repo examples**: “Reference Implementations” section in [reference.md](reference.md) (paths under `documentation/...`).

## Keeping in sync

The canonical source in the **mosc-temp** repository is `.cursor/rules/html_documentation_styling_guide.mdc`. If that rule changes materially, regenerate or merge into `reference.md` so this skill stays aligned.
