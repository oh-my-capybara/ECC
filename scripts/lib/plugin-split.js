'use strict';

/**
 * Pure helpers for splitting the ECC Claude Code plugin into smaller plugins.
 *
 * Everything here is side-effect free: functions take plain data and return
 * new objects. Filesystem work lives in scripts/lib/plugin-split-fs.js.
 */

const COMPONENT_KINDS = Object.freeze(['skills', 'agents', 'commands']);
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANIFEST_BASE_FIELDS = Object.freeze(['author', 'homepage', 'repository', 'license']);

function componentsOf(entry) {
  const source = entry || {};
  return Object.fromEntries(COMPONENT_KINDS.map(kind => [kind, Array.isArray(source[kind]) ? source[kind] : []]));
}

function isExternalDependency(dep) {
  const name = typeof dep === 'string' ? dep : dep && dep.name;
  const marketplace = typeof dep === 'object' && dep ? dep.marketplace : undefined;
  return Boolean(marketplace) || (typeof name === 'string' && name.includes('@'));
}

function dependencyName(dep) {
  return typeof dep === 'string' ? dep : dep && dep.name;
}

function validateShape(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['config must be an object'];
  if (typeof config.corePlugin !== 'string' || !config.corePlugin) errors.push('corePlugin must be a non-empty string');
  if (typeof config.pluginsDir !== 'string' || !config.pluginsDir) errors.push('pluginsDir must be a non-empty string');
  if (!Array.isArray(config.plugins)) errors.push('plugins must be an array');
  return errors;
}

function validatePluginEntries(config) {
  const errors = [];
  const seen = new Set();
  for (const plugin of config.plugins) {
    if (!plugin || typeof plugin.name !== 'string' || !KEBAB_CASE.test(plugin.name)) {
      errors.push(`plugin name "${plugin && plugin.name}" must be kebab-case`);
      continue;
    }
    if (plugin.name === config.corePlugin) errors.push(`plugin "${plugin.name}" collides with corePlugin`);
    if (seen.has(plugin.name)) errors.push(`duplicate plugin name "${plugin.name}"`);
    seen.add(plugin.name);
    if (typeof plugin.description !== 'string' || !plugin.description.trim()) {
      errors.push(`plugin "${plugin.name}" needs a description`);
    }
  }
  return errors;
}

function validateAssignments(config) {
  const errors = [];
  const owners = new Map();
  const assignees = [{ name: `${config.corePlugin} (core)`, ...componentsOf(config.core) }, ...config.plugins];
  for (const owner of assignees) {
    const components = componentsOf(owner);
    for (const kind of COMPONENT_KINDS) {
      for (const item of components[kind]) {
        const key = `${kind}/${item}`;
        if (typeof item !== 'string' || !item || item.includes('/') || item.includes('\\')) {
          errors.push(`invalid ${kind} entry "${item}" in "${owner.name}"`);
        } else if (owners.has(key)) {
          errors.push(`${key} is assigned to both "${owners.get(key)}" and "${owner.name}"`);
        } else {
          owners.set(key, owner.name);
        }
      }
    }
  }
  return errors;
}

function findCycle(graph) {
  const state = new Map();
  const visit = (node, trail) => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'active') return [...trail, node];
    state.set(node, 'active');
    for (const next of graph.get(node) || []) {
      const cycle = visit(next, [...trail, node]);
      if (cycle) return cycle;
    }
    state.set(node, 'done');
    return null;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return null;
}

function validateDependencies(config) {
  const errors = [];
  const names = new Set(config.plugins.map(p => p && p.name));
  const graph = new Map();
  for (const plugin of config.plugins.filter(p => p && typeof p.name === 'string')) {
    const deps = Array.isArray(plugin.dependencies) ? plugin.dependencies : [];
    const internal = [];
    for (const dep of deps) {
      if (isExternalDependency(dep)) continue;
      const name = dependencyName(dep);
      if (!names.has(name)) errors.push(`plugin "${plugin.name}" depends on unknown plugin "${name}"`);
      else internal.push(name);
    }
    graph.set(plugin.name, internal);
  }
  const cycle = findCycle(graph);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return errors;
}

/** Returns a list of human-readable errors; an empty list means the config is valid. */
function validateConfig(config) {
  const shapeErrors = validateShape(config);
  if (shapeErrors.length > 0) return shapeErrors;
  return [...validatePluginEntries(config), ...validateAssignments(config), ...validateDependencies(config)];
}

/**
 * Maps every component name to the plugin that owns it, for namespace rewrites.
 * Names claimed by more than one plugin are ambiguous and left out.
 */
function buildRefMapping(config) {
  const claims = new Map();
  for (const plugin of config.plugins) {
    const components = componentsOf(plugin);
    for (const kind of COMPONENT_KINDS) {
      for (const item of components[kind]) {
        claims.set(item, new Set([...(claims.get(item) || []), plugin.name]));
      }
    }
  }
  const mapping = {};
  const ambiguous = [];
  for (const [item, plugins] of claims) {
    if (plugins.size === 1) mapping[item] = [...plugins][0];
    else ambiguous.push(item);
  }
  return { mapping, ambiguous: ambiguous.sort() };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const REF_PATTERN_CACHE = new Map();

function namespacePattern(namespace) {
  if (!REF_PATTERN_CACHE.has(namespace)) {
    REF_PATTERN_CACHE.set(namespace, new RegExp(`(?<![\\w-])(${escapeRegExp(namespace)}):([a-z0-9][a-z0-9-]*)(?![\\w-])`, 'g'));
  }
  return REF_PATTERN_CACHE.get(namespace);
}

/** Rewrites `<corePlugin>:<name>` to `<owner>:<name>` for every mapped name. */
function rewriteNamespaceRefs(text, mapping, corePlugin) {
  return text.replace(namespacePattern(corePlugin), (match, _ns, name) =>
    Object.prototype.hasOwnProperty.call(mapping, name) ? `${mapping[name]}:${name}` : match);
}

/** Inverse of rewriteNamespaceRefs: `<owner>:<name>` back to `<corePlugin>:<name>`. */
function restoreNamespaceRefs(text, mapping, corePlugin) {
  const owners = [...new Set(Object.values(mapping))];
  return owners.reduce((acc, owner) => acc.replace(namespacePattern(owner), (match, _ns, name) =>
    mapping[name] === owner ? `${corePlugin}:${name}` : match), text);
}

function pickBase(base) {
  return Object.fromEntries(MANIFEST_BASE_FIELDS.filter(key => base[key] !== undefined).map(key => [key, base[key]]));
}

/**
 * Builds `.claude-plugin/plugin.json` for a sub-plugin.
 * `present` says which component directories exist so declared paths always resolve.
 * Never emits `agents` or `hooks` (auto-discovered; see PLUGIN_SCHEMA_NOTES.md).
 */
function buildPluginManifest(plugin, base, present) {
  const deps = Array.isArray(plugin.dependencies) ? plugin.dependencies : [];
  return {
    name: plugin.name,
    version: base.version,
    description: plugin.description,
    ...pickBase(base),
    keywords: Array.isArray(plugin.keywords) ? [...plugin.keywords] : [],
    ...(deps.length > 0 ? { dependencies: [...deps] } : {}),
    ...(present && present.skills ? { skills: ['./skills/'] } : {}),
    ...(present && present.commands ? { commands: ['./commands/'] } : {}),
  };
}

function pluginSource(config, name) {
  return `./${config.pluginsDir}/${name}`;
}

function isManagedEntry(entry, config) {
  return typeof entry.source === 'string' && entry.source.startsWith(`./${config.pluginsDir}/`);
}

function buildMarketplaceEntry(plugin, config, base) {
  const keywords = Array.isArray(plugin.keywords) ? [...plugin.keywords] : [];
  return {
    name: plugin.name,
    source: pluginSource(config, plugin.name),
    description: plugin.description,
    version: base.version,
    ...pickBase(base),
    keywords,
    category: plugin.category || 'development',
    tags: keywords,
  };
}

/** Returns a new marketplace object: unmanaged entries kept in order, managed entries regenerated. */
function buildMarketplace(existing, config, base, options = {}) {
  const kept = (existing.plugins || []).filter(entry => !isManagedEntry(entry, config));
  const generated = options.restore ? [] : config.plugins.map(plugin => buildMarketplaceEntry(plugin, config, base));
  return { ...existing, plugins: [...kept, ...generated] };
}

/** Returns a new root manifest whose `dependencies` include (or, on restore, exclude) every sub-plugin. */
function buildRootManifest(existing, config, options = {}) {
  const managed = new Set(config.plugins.map(p => p.name));
  const others = (existing.dependencies || []).filter(dep => !managed.has(dependencyName(dep)));
  const dependencies = options.restore ? others : [...others, ...config.plugins.map(p => p.name)];
  const { dependencies: _drop, ...rest } = existing;
  return dependencies.length > 0 ? { ...rest, dependencies } : rest;
}

module.exports = {
  COMPONENT_KINDS,
  componentsOf,
  validateConfig,
  buildRefMapping,
  rewriteNamespaceRefs,
  restoreNamespaceRefs,
  buildPluginManifest,
  buildMarketplace,
  buildRootManifest,
  pluginSource,
};
