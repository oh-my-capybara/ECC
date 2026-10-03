### Split Plugins

The marketplace ships the root `ecc` plugin plus smaller `ecc-*` plugins under `plugins/` (for example `ecc-workflow`, `ecc-react`, `ecc-django`). The root `ecc` plugin keeps hooks, scripts, rules, and the components that hooks/scripts reference by path, and lists every `ecc-*` plugin in `dependencies`. So `claude plugin install ecc@ecc` still installs the full bundle, while `claude plugin install ecc-react@ecc` installs only that slice (plus its own dependencies).

The mapping lives in `manifests/claude-plugin-split.json`. To re-categorize, edit it and run:

```bash
npm run plugins:split:dry-run   # preview moves
npm run plugins:split           # move files, regenerate manifests, rewrite ecc:<name> refs
npm run plugins:restore         # move everything back into the root plugin
```

Sub-plugin components are namespaced by their plugin, e.g. `ecc-workflow:planner` instead of `ecc:planner`.

### Plugin Manifest Gotchas

If you plan to edit `.claude-plugin/plugin.json`, be aware that the Claude plugin validator enforces several **undocumented but strict constraints** that can cause installs to fail with vague errors (for example, `agents: Invalid input`). In particular, component fields must be arrays, `agents` is not a supported manifest field and must not be included in plugin.json, and a `version` field is required for reliable validation and installation.

These constraints are not obvious from public examples and have caused repeated installation failures in the past. They are documented in detail in `.claude-plugin/PLUGIN_SCHEMA_NOTES.md`, which should be reviewed before making any changes to the plugin manifest.

### Custom Endpoints and Gateways

ECC does not override Claude Code transport settings. If Claude Code is configured to run through an official LLM gateway or a compatible custom endpoint, the plugin continues to work because hooks, skills, and any retained legacy command shims execute locally after the CLI starts successfully.

Use Claude Code's own environment/configuration for transport selection, for example:

```bash
export ANTHROPIC_BASE_URL=https://your-gateway.example.com
export ANTHROPIC_AUTH_TOKEN=your-token
claude
```

Run or self-host any open-source model behind that endpoint. Itô is ECC's preferred compute sponsor: [open the Itô dashboard to sign in and rent or manage GPUs](https://compute.itomarkets.com). Any GPU provider works. That sponsorship link is passive: it does not invoke an RFQ, reserve capacity, change Claude Code transport settings, provision compute, or configure serving. Separately, the opt-in `ecc ito find` bridge invokes the explicitly configured canonical Itô CLI and submits a live authenticated RFQ; it does not reserve capacity. Managed inference through Itô is not live yet.
