'use strict';

/**
 * Filesystem side of the ECC plugin split: locating components, planning and
 * applying moves, and rewriting namespace references in markdown files.
 */

const fs = require('fs');
const path = require('path');
const { COMPONENT_KINDS, componentsOf } = require('./plugin-split');

const CORE = Symbol('core');

function entryName(kind, name) {
  return kind === 'skills' ? name : `${name}.md`;
}

function ownerDir(root, config, owner) {
  return owner === CORE ? root : path.join(root, config.pluginsDir, owner);
}

function componentPath(root, config, owner, kind, name) {
  return path.join(ownerDir(root, config, owner), kind, entryName(kind, name));
}

function ownerLabel(owner) {
  return owner === CORE ? '<root>' : owner;
}

/** Returns every owner (core first) that currently holds kind/name on disk. */
function locate(root, config, kind, name) {
  const candidates = [CORE, ...config.plugins.map(p => p.name)];
  return candidates.filter(owner => fs.existsSync(componentPath(root, config, owner, kind, name)));
}

function desiredOwners(config, options) {
  const wanted = [];
  const core = componentsOf(config.core);
  for (const kind of COMPONENT_KINDS) {
    for (const name of core[kind]) wanted.push({ kind, name, owner: CORE });
  }
  for (const plugin of config.plugins) {
    const components = componentsOf(plugin);
    for (const kind of COMPONENT_KINDS) {
      for (const name of components[kind]) wanted.push({ kind, name, owner: options.restore ? CORE : plugin.name });
    }
  }
  return wanted;
}

function listEntries(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => (kind === 'skills' ? e.isDirectory() : e.isFile() && e.name.endsWith('.md')))
    .map(e => (kind === 'skills' ? e.name : e.name.slice(0, -3)));
}

/** Root components that no config entry claims (they stay with the core plugin). */
function findUnassigned(root, config) {
  const claimed = new Set(desiredOwners(config, {}).map(w => `${w.kind}/${w.name}`));
  return Object.fromEntries(COMPONENT_KINDS.map(kind => [
    kind,
    listEntries(path.join(root, kind), kind).filter(name => !claimed.has(`${kind}/${name}`)).sort(),
  ]));
}

/**
 * Computes moves without touching disk.
 * Returns { moves, missing, conflicts, unassigned }.
 */
function buildPlan(root, config, options = {}) {
  const moves = [];
  const missing = [];
  const conflicts = [];
  for (const { kind, name, owner } of desiredOwners(config, options)) {
    const found = locate(root, config, kind, name);
    if (found.length === 0) missing.push(`${kind}/${name}`);
    else if (found.length > 1) conflicts.push(`${kind}/${name} exists in ${found.map(ownerLabel).join(', ')}`);
    else if (found[0] !== owner) {
      moves.push({
        kind,
        name,
        from: componentPath(root, config, found[0], kind, name),
        to: componentPath(root, config, owner, kind, name),
        fromLabel: ownerLabel(found[0]),
        toLabel: ownerLabel(owner),
      });
    }
  }
  return { moves, missing, conflicts, unassigned: findUnassigned(root, config) };
}

function applyMoves(moves) {
  for (const move of moves) {
    if (fs.existsSync(move.to)) throw new Error(`refusing to overwrite existing ${move.to}`);
    fs.mkdirSync(path.dirname(move.to), { recursive: true });
    fs.renameSync(move.from, move.to);
  }
}

function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/** Drops empty component dirs in sub-plugins so manifests never declare missing paths. */
function pruneEmptyComponentDirs(root, config) {
  for (const plugin of config.plugins) {
    for (const kind of COMPONENT_KINDS) removeIfEmpty(path.join(ownerDir(root, config, plugin.name), kind));
  }
}

function presentComponents(root, config, pluginName) {
  const dir = ownerDir(root, config, pluginName);
  return Object.fromEntries(COMPONENT_KINDS.map(kind => [kind, fs.existsSync(path.join(dir, kind))]));
}

/** Removes a sub-plugin directory only when nothing but its generated manifest remains. */
function removePluginShell(root, config, pluginName) {
  const dir = ownerDir(root, config, pluginName);
  const manifestDir = path.join(dir, '.claude-plugin');
  const manifest = path.join(manifestDir, 'plugin.json');
  if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
  removeIfEmpty(manifestDir);
  removeIfEmpty(dir);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function collectMarkdown(target, acc) {
  if (!fs.existsSync(target)) return acc;
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith('.md') ? [...acc, target] : acc;
  return fs.readdirSync(target, { withFileTypes: true })
    .filter(e => e.name !== 'node_modules' && e.name !== '.git')
    .reduce((list, e) => collectMarkdown(path.join(target, e.name), list), acc);
}

/** Applies `transform` to every markdown file under the given targets; returns changed paths. */
function transformMarkdown(targets, transform, options = {}) {
  const files = [...new Set(targets.reduce((acc, t) => collectMarkdown(t, acc), []))];
  const changed = [];
  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    const after = transform(before);
    if (after !== before) {
      changed.push(file);
      if (!options.dryRun) fs.writeFileSync(file, after);
    }
  }
  return changed;
}

function refTargets(root, config) {
  const configured = Array.isArray(config.rewriteRefsIn) ? config.rewriteRefsIn : [];
  return [
    ...configured.map(rel => path.join(root, rel)),
    ...config.plugins.map(p => ownerDir(root, config, p.name)),
  ];
}

module.exports = {
  CORE,
  buildPlan,
  applyMoves,
  pruneEmptyComponentDirs,
  presentComponents,
  removePluginShell,
  readJson,
  writeJson,
  transformMarkdown,
  refTargets,
  ownerDir,
};
