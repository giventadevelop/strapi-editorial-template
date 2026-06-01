# Install `html-documentation-styling` globally (Cursor + Claude Code)

## What is in this folder

| File | Purpose |
|------|---------|
| `SKILL.md` | Cursor / Claude Code skill entry (YAML frontmatter + workflow). |
| `reference.md` | Full MOSC HTML documentation spec (linked from `SKILL.md`). |
| `INSTALL_PROMPT.md` | This file: paths and a copy-paste prompt for another machine. |

Keep **all** files in the same directory named `html-documentation-styling`.

---

## Human: bring this folder to the other machine

- Commit or copy the directory  
  `image_edits/.cursor/skills/html-documentation-styling/`  
  (or zip it). On the target machine, unpack so the agent can read `SKILL.md` and `reference.md` from disk.

---

## Prompt to give the agent on the other machine

Copy everything inside the block below into a new chat (Cursor or Claude Code). Replace the placeholder path with the folder **on that machine** where `SKILL.md` lives (repo clone, USB path, or download folder).

```
You are on a new machine. Install the "html-documentation-styling" agent skill for global use in BOTH Cursor and Claude Code.

Source folder (adjust to this machine’s path — must contain SKILL.md and reference.md):
  <PASTE_FULL_PATH_TO_html-documentation-styling_FOLDER_HERE>

Do this:

1. Verify the source folder contains at least: SKILL.md, reference.md.

2. Cursor (global Agent Skills):
   - Windows: copy the entire folder to %USERPROFILE%\.cursor\skills\html-documentation-styling\
   - macOS/Linux: copy to ~/.cursor/skills/html-documentation-styling/
   - Create parent directories if missing. Overwrite only this skill folder if it already exists.

3. Claude Code (global skills):
   - Default: copy the same entire folder to %USERPROFILE%\.claude\skills\html-documentation-styling\ (Windows) or ~/.claude/skills/html-documentation-styling/ (macOS/Linux).
   - If the user uses CLAUDE_CONFIG_DIR, place the folder under <CLAUDE_CONFIG_DIR>/skills/html-documentation-styling/ instead (ask or infer from env).

4. After copying, list the final paths and confirm both SKILL.md and reference.md exist at each destination.

5. Briefly tell the user how the skill is invoked: when authoring HTML documentation, attach or mention the skill "html-documentation-styling" / HTML documentation styling (MOSC), and the agent should read reference.md per SKILL.md.

Do not rename the inner files. Do not strip YAML frontmatter from SKILL.md.
```

---

## Paths quick reference

| Product | Global skills directory | Skill folder name |
|---------|-------------------------|-------------------|
| Cursor | `%USERPROFILE%\.cursor\skills\` (Windows) or `~/.cursor/skills/` | `html-documentation-styling` |
| Claude Code | `%USERPROFILE%\.claude\skills\` or `~/.claude/skills/` (or under `CLAUDE_CONFIG_DIR`) | `html-documentation-styling` |

Official docs: [Cursor Agent Skills](https://cursor.com/docs), [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills).

---

## Optional: project-only copy

To scope the skill to one repo instead of globally, copy this folder to that project’s `.cursor/skills/html-documentation-styling/` (Cursor) and/or `.claude/skills/html-documentation-styling/` (Claude Code) at the project root.

---

## Sync note (from SKILL.md)

The canonical rule in the **mosc-temp** repo is `.cursor/rules/html_documentation_styling_guide.mdc`. If that changes materially, merge updates into `reference.md` here so this skill stays aligned.
