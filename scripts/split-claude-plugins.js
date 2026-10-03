#!/usr/bin/env node
'use strict';

/**
 * Split the ECC Claude Code plugin into smaller marketplace plugins.
 *
 * Moves skills/agents/commands listed in the split config from the repo root
 * into <pluginsDir>/<plugin>/, writes each sub-plugin's .claude-plugin/plugin.json,
 * registers them in .claude-plugin/marketplace.json, and makes the root `ecc`
 * plugin depend on all of them so installing `ecc` still gives the full bundle.
 *
 * Re-runnable: edit the config and run again to re-categorize. Use --restore to
 * move everything back into the root plugin.
 */

const path = require('path');
const fs = require('fs');
const split = require('./lib/plugin-split');
const io = require('./lib/plugin-split-fs');

const DEFAULT_CONFIG = path.join('manifests', 'claude-plugin-split.json');

const HELP = `Usage: node scripts/split-claude-plugins.js [options]

Split the root ECC Claude Code plugin into smaller plugins (or restore it).

Options:
  --config <path>      Split config (default: ${DEFAULT_CONFIG})
  --root <dir>         Repository root (default: repo containing this script)
  --dry-run            Print the plan without changing anything
  --restore            Move every component back into the root plugin
  --no-rewrite-refs    Do not rewrite "ecc:<name>" references to the new namespaces
  -h, --help           Show this help
`;

function parseArgs(argv) {
  const opts = { root: path.resolve(__dirname, '..'), config: null, dryRun: false, restore: false, rewriteRefs: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--root') opts.root = path.resolve(next());
    else if (arg === '--config') opts.config = path.resolve(next());
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--restore') opts.restore = true;
    else if (arg === '--no-rewrite-refs') opts.rewriteRefs = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { ...opts, config: opts.config || path.join(opts.root, DEFAULT_CONFIG) };
}

function loadConfig(file) {
  if (!fs.existsSync(file)) throw new Error(`config not found: ${file}`);
  const config = io.readJson(file);
  const errors = split.validateConfig(config);
  if (errors.length > 0) throw new Error(`invalid config ${file}:\n  - ${errors.join('\n  - ')}`);
  return config;
}

function printPlan(plan, log) {
  log(`Moves: ${plan.moves.length}`);
  for (const m of plan.moves) log(`  ${m.kind}/${m.name}: ${m.fromLabel} -> ${m.toLabel}`);
  const unassigned = Object.entries(plan.unassigned).filter(([, names]) => names.length > 0);
  if (unassigned.length > 0) {
    log('Unassigned (staying in the core plugin):');
    for (const [kind, names] of unassigned) log(`  ${kind}: ${names.join(', ')}`);
  }
}

function manifestPaths(root) {
  return {
    rootManifest: path.join(root, '.claude-plugin', 'plugin.json'),
    marketplace: path.join(root, '.claude-plugin', 'marketplace.json'),
  };
}

function writeManifests(opts, config, base) {
  const { rootManifest, marketplace } = manifestPaths(opts.root);
  io.writeJson(rootManifest, split.buildRootManifest(io.readJson(rootManifest), config, { restore: opts.restore }));
  io.writeJson(marketplace, split.buildMarketplace(io.readJson(marketplace), config, base, { restore: opts.restore }));
  for (const plugin of config.plugins) {
    if (opts.restore) {
      io.removePluginShell(opts.root, config, plugin.name);
    } else {
      const manifest = split.buildPluginManifest(plugin, base, io.presentComponents(opts.root, config, plugin.name));
      io.writeJson(path.join(io.ownerDir(opts.root, config, plugin.name), '.claude-plugin', 'plugin.json'), manifest);
    }
  }
}

function rewriteRefs(opts, config, log) {
  const { mapping, ambiguous } = split.buildRefMapping(config);
  if (ambiguous.length > 0) log(`Skipping ambiguous names for ref rewrite: ${ambiguous.join(', ')}`);
  const transform = opts.restore
    ? text => split.restoreNamespaceRefs(text, mapping, config.corePlugin)
    : text => split.rewriteNamespaceRefs(text, mapping, config.corePlugin);
  const changed = io.transformMarkdown(io.refTargets(opts.root, config), transform, { dryRun: opts.dryRun });
  log(`Namespace refs ${opts.dryRun ? 'to rewrite' : 'rewritten'} in ${changed.length} file(s)`);
  for (const file of changed) log(`  ${path.relative(opts.root, file)}`);
}

function run(opts, log) {
  const config = loadConfig(opts.config);
  const plan = io.buildPlan(opts.root, config, { restore: opts.restore });
  if (plan.missing.length > 0 || plan.conflicts.length > 0) {
    const lines = [
      ...plan.missing.map(m => `missing: ${m}`),
      ...plan.conflicts.map(c => `conflict: ${c}`),
    ];
    throw new Error(`cannot apply split:\n  - ${lines.join('\n  - ')}`);
  }

  log(`${opts.restore ? 'Restore' : 'Split'} plan for ${config.plugins.length} plugin(s)${opts.dryRun ? ' (dry run)' : ''}`);
  printPlan(plan, log);

  const base = io.readJson(manifestPaths(opts.root).rootManifest);
  // Restore rewrites refs while files still live in plugin dirs; split rewrites after moving.
  if (opts.rewriteRefs && opts.restore) rewriteRefs(opts, config, log);
  if (opts.dryRun) {
    if (opts.rewriteRefs && !opts.restore) log('Namespace refs will be rewritten after moves.');
    return;
  }
  io.applyMoves(plan.moves);
  io.pruneEmptyComponentDirs(opts.root, config);
  writeManifests(opts, config, base);
  if (opts.rewriteRefs && !opts.restore) rewriteRefs(opts, config, log);
  log('Done.');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    run(opts, line => process.stdout.write(`${line}\n`));
  } catch (error) {
    process.stderr.write(`[split-claude-plugins] ${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, run };
