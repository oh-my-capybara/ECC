---
name: claude-plugin-split
description: Split a large Claude Code plugin into smaller marketplace plugins with a root plugin that depends on them all. Use when a plugin has too many skills, agents or commands and needs modularizing without losing the full bundle.
---

# Splitting a Claude Code plugin

Tooling in this repo (re-runnable, config-driven):
- Config: `manifests/claude-plugin-split.json`
- CLI: `node scripts/split-claude-plugins.js [--dry-run|--restore|--no-rewrite-refs]`
- npm: `plugins:split:dry-run`, `plugins:split`, `plugins:restore`
- Tests: `node tests/scripts/split-claude-plugins.test.js`

## Claude Code facts that drive the design
- `plugin.json` `dependencies` is an array of plugin names (`"name"`, `"name@marketplace"`, or `{name, version, marketplace}`).
  Installing the root plugin installs all dependencies, so the root stays the full bundle.
- Each plugin is isolated after install. A sub-plugin must not reference files outside its own directory (`../` breaks in the plugin cache).
- Components are namespaced `<plugin>:<name>`. Moving an agent from `ecc` to `ecc-workflow` turns `ecc:planner` into `ecc-workflow:planner`, so rewrite those refs in markdown.
- Never add `agents` or `hooks` fields to `plugin.json` (they are auto-loaded; see `.claude-plugin/PLUGIN_SCHEMA_NOTES.md`).
  Only declare `skills` / `commands` directories that exist.
- Marketplace entry for a sub-plugin: `source: "./plugins/<name>"`. Keep the root entry (`source: "./"`) unchanged.
- Sub-plugins with a relative-path source share the marketplace repo's tags (`<plugin>--v<version>`).

## Workflow
1. **Find coupling first.** Hooks and scripts that load files by path (`skills/<x>/...`, `scripts/...`, `${CLAUDE_PLUGIN_ROOT}`) must stay in the root plugin.
   Grep `scripts/` and `hooks/` for `skills/`, `agents/` and `commands/` path usage, and commands for `scripts/`.
   List the matches under `core` in the config.
2. **Draft the mapping.** Use `manifests/install-modules.json` modules as a starting point. Split large domains by language or framework and add `dependencies` between related plugins (react -> frontend, django -> python).
3. **Dry run.** `npm run plugins:split:dry-run`. Fix "missing" or "conflict" errors and review the "Unassigned" list (unassigned items stay in the root).
4. **Check git is clean**, then run `npm run plugins:split`.
5. **Validate with the real CLI**: `claude plugin validate .` and `claude plugin validate plugins/<name>` for every sub-plugin. All should pass with no warnings.
6. Run the repo CI validators and fix whatever scans only root `skills/`, `agents/` or `commands/`.

## Pitfalls
- Do not write `node -e "..."` one-liners with regexes or quotes in PowerShell. Write a scratch `.js` file and run it.
- Description counts in manifests (for example "293 skills") go stale after a split; update them or the catalog check fails.
- After a split, `validate-skills`, `validate-commands`, `validate-install-manifests`, `catalog:check`, `command-registry:check` and `scripts/harness-audit.js` fail until they also scan `plugins/ecc-*`.
- Run `npm install` before `eslint`, otherwise it fails on a missing `@eslint/js`.
- `--restore` reverses refs and moves; use it to undo rather than `git checkout`.
