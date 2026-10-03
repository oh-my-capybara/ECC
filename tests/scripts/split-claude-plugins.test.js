/**
 * Tests for scripts/lib/plugin-split.js and scripts/split-claude-plugins.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const lib = require('../../scripts/lib/plugin-split');

const CLI = path.join(__dirname, '..', '..', 'scripts', 'split-claude-plugins.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function baseConfig(overrides = {}) {
  return {
    corePlugin: 'ecc',
    pluginsDir: 'plugins',
    rewriteRefsIn: ['agents', 'commands', 'skills', 'AGENTS.md'],
    core: { skills: ['core-skill'], agents: [], commands: [] },
    plugins: [
      {
        name: 'ecc-web',
        description: 'Web plugin',
        keywords: ['web'],
        category: 'development',
        skills: ['react-patterns'],
        agents: ['react-reviewer'],
        commands: ['react-review'],
      },
      {
        name: 'ecc-py',
        description: 'Python plugin',
        keywords: ['python'],
        dependencies: ['ecc-web'],
        skills: ['python-patterns'],
        agents: [],
        commands: [],
      },
    ],
    ...overrides,
  };
}

function makeFixture(config = baseConfig()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-split-'));
  writeFile(path.join(root, 'skills', 'core-skill', 'SKILL.md'), '# core\n');
  writeFile(path.join(root, 'skills', 'react-patterns', 'SKILL.md'), 'Use ecc:react-reviewer here.\n');
  writeFile(path.join(root, 'skills', 'react-patterns', 'scripts', 'x.js'), '// ecc:react-reviewer untouched\n');
  writeFile(path.join(root, 'skills', 'python-patterns', 'SKILL.md'), '# py\n');
  writeFile(path.join(root, 'skills', 'orphan-skill', 'SKILL.md'), '# orphan\n');
  writeFile(path.join(root, 'agents', 'react-reviewer.md'), '---\nname: react-reviewer\n---\n');
  writeFile(path.join(root, 'commands', 'react-review.md'), 'Delegate to /ecc:react-review and ecc:react-reviewer.\n');
  writeFile(path.join(root, 'AGENTS.md'), '- React -> **ecc:react-reviewer**, unknown ecc:other, myecc:react-reviewer\n');
  writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'ecc',
    version: '9.9.9',
    author: { name: 'A' },
    homepage: 'https://example.com',
    repository: 'https://github.com/x/y',
    license: 'MIT',
    mcpServers: {},
    skills: ['./skills/'],
    commands: ['./commands/'],
  }, null, 2));
  writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'ecc',
    owner: { name: 'A' },
    plugins: [
      { name: 'ecc', source: './', version: '9.9.9', author: { name: 'A', email: 'a@x' }, strict: false },
      { name: 'ecc-stale', source: './plugins/ecc-stale', version: '1.0.0' },
    ],
  }, null, 2));
  const configPath = path.join(root, 'split.json');
  writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

function runCli(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status || 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

function runTests() {
  console.log('\n=== Testing plugin-split ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => { if (ok) passed++; else failed++; };

  record(test('validateConfig accepts a valid config', () => {
    assert.deepStrictEqual(lib.validateConfig(baseConfig()), []);
  }));

  record(test('validateConfig rejects duplicate assignments across plugins and core', () => {
    const cfg = baseConfig({ core: { skills: ['react-patterns'], agents: [], commands: [] } });
    const errors = lib.validateConfig(cfg);
    assert.ok(errors.some(e => e.includes('react-patterns')), errors.join('\n'));
  }));

  record(test('validateConfig rejects non-kebab names, unknown deps and cycles', () => {
    const cfg = baseConfig();
    const bad = {
      ...cfg,
      plugins: [
        { ...cfg.plugins[0], name: 'Bad Name' },
        { ...cfg.plugins[1], dependencies: ['ecc-missing'] },
      ],
    };
    const errors = lib.validateConfig(bad);
    assert.ok(errors.some(e => e.includes('Bad Name')), errors.join('\n'));
    assert.ok(errors.some(e => e.includes('ecc-missing')), errors.join('\n'));

    const cyclic = {
      ...cfg,
      plugins: [
        { ...cfg.plugins[0], dependencies: ['ecc-py'] },
        cfg.plugins[1],
      ],
    };
    assert.ok(lib.validateConfig(cyclic).some(e => e.includes('cycle')));
  }));

  record(test('validateConfig allows cross-marketplace dependencies', () => {
    const cfg = baseConfig();
    const ok = { ...cfg, plugins: [{ ...cfg.plugins[0], dependencies: ['other@market'] }, cfg.plugins[1]] };
    assert.deepStrictEqual(lib.validateConfig(ok), []);
  }));

  record(test('rewriteNamespaceRefs rewrites only mapped, standalone ecc: refs', () => {
    const out = lib.rewriteNamespaceRefs(
      'a ecc:react-reviewer b /ecc:react-review c ecc:other d myecc:react-reviewer e ecc:react-reviewer-x',
      { 'react-reviewer': 'ecc-web', 'react-review': 'ecc-web' },
      'ecc'
    );
    assert.strictEqual(out, 'a ecc-web:react-reviewer b /ecc-web:react-review c ecc:other d myecc:react-reviewer e ecc:react-reviewer-x');
  }));

  record(test('restoreNamespaceRefs reverses the rewrite', () => {
    const map = { 'react-reviewer': 'ecc-web' };
    const original = 'x ecc:react-reviewer y';
    const rewritten = lib.rewriteNamespaceRefs(original, map, 'ecc');
    assert.strictEqual(lib.restoreNamespaceRefs(rewritten, map, 'ecc'), original);
  }));

  record(test('buildRefMapping skips names claimed by two different plugins', () => {
    const cfg = baseConfig();
    const clash = { ...cfg, plugins: [cfg.plugins[0], { ...cfg.plugins[1], skills: ['react-reviewer'] }] };
    const { mapping, ambiguous } = lib.buildRefMapping(clash);
    assert.strictEqual(mapping['react-reviewer'], undefined);
    assert.deepStrictEqual(ambiguous, ['react-reviewer']);
    assert.strictEqual(mapping['react-review'], 'ecc-web');
  }));

  record(test('buildPluginManifest produces a valid Claude manifest without agents/hooks fields', () => {
    const manifest = lib.buildPluginManifest(baseConfig().plugins[1], { version: '1.2.3', author: { name: 'A' }, license: 'MIT' }, { skills: true, commands: false });
    assert.strictEqual(manifest.name, 'ecc-py');
    assert.strictEqual(manifest.version, '1.2.3');
    assert.deepStrictEqual(manifest.dependencies, ['ecc-web']);
    assert.deepStrictEqual(manifest.skills, ['./skills/']);
    assert.strictEqual(manifest.commands, undefined);
    assert.strictEqual(manifest.agents, undefined);
    assert.strictEqual(manifest.hooks, undefined);
  }));

  record(test('buildMarketplace keeps core entry, replaces managed entries and drops stale ones', () => {
    const existing = {
      name: 'ecc',
      plugins: [
        { name: 'ecc', source: './', strict: false },
        { name: 'ecc-stale', source: './plugins/ecc-stale' },
        { name: 'external', source: { source: 'github', repo: 'a/b' } },
      ],
    };
    const out = lib.buildMarketplace(existing, baseConfig(), { version: '1.0.0' });
    assert.deepStrictEqual(out.plugins.map(p => p.name), ['ecc', 'external', 'ecc-web', 'ecc-py']);
    assert.strictEqual(out.plugins[2].source, './plugins/ecc-web');
    assert.strictEqual(existing.plugins.length, 3, 'input must not be mutated');
  }));

  record(test('buildRootManifest merges dependencies without mutating input', () => {
    const existing = { name: 'ecc', dependencies: ['keep-me', 'ecc-web'] };
    const out = lib.buildRootManifest(existing, baseConfig());
    assert.deepStrictEqual(out.dependencies, ['keep-me', 'ecc-web', 'ecc-py']);
    assert.deepStrictEqual(existing.dependencies, ['keep-me', 'ecc-web']);
    const restored = lib.buildRootManifest(out, baseConfig(), { restore: true });
    assert.deepStrictEqual(restored.dependencies, ['keep-me']);
  }));

  record(test('CLI --dry-run reports moves without touching the filesystem', () => {
    const { root, configPath } = makeFixture();
    const result = runCli(['--root', root, '--config', configPath, '--dry-run']);
    assert.strictEqual(result.code, 0, result.stderr + result.stdout);
    assert.ok(result.stdout.includes('react-patterns'));
    assert.ok(result.stdout.includes('orphan-skill'), 'should warn about unassigned items');
    assert.ok(fs.existsSync(path.join(root, 'skills', 'react-patterns')));
    assert.ok(!fs.existsSync(path.join(root, 'plugins', 'ecc-web')));
  }));

  record(test('CLI split moves components, writes manifests and rewrites refs', () => {
    const { root, configPath } = makeFixture();
    const result = runCli(['--root', root, '--config', configPath]);
    assert.strictEqual(result.code, 0, result.stderr + result.stdout);

    const web = path.join(root, 'plugins', 'ecc-web');
    assert.ok(fs.existsSync(path.join(web, 'skills', 'react-patterns', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(web, 'agents', 'react-reviewer.md')));
    assert.ok(fs.existsSync(path.join(web, 'commands', 'react-review.md')));
    assert.ok(!fs.existsSync(path.join(root, 'skills', 'react-patterns')));
    assert.ok(fs.existsSync(path.join(root, 'skills', 'core-skill')));
    assert.ok(fs.existsSync(path.join(root, 'skills', 'orphan-skill')));

    const webManifest = readJson(path.join(web, '.claude-plugin', 'plugin.json'));
    assert.strictEqual(webManifest.version, '9.9.9');
    assert.deepStrictEqual(webManifest.commands, ['./commands/']);

    const rootManifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
    assert.deepStrictEqual(rootManifest.dependencies, ['ecc-web', 'ecc-py']);
    assert.deepStrictEqual(rootManifest.mcpServers, {});

    const market = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
    assert.deepStrictEqual(market.plugins.map(p => p.name), ['ecc', 'ecc-web', 'ecc-py']);

    const skillText = fs.readFileSync(path.join(web, 'skills', 'react-patterns', 'SKILL.md'), 'utf8');
    assert.ok(skillText.includes('ecc-web:react-reviewer'));
    const scriptText = fs.readFileSync(path.join(web, 'skills', 'react-patterns', 'scripts', 'x.js'), 'utf8');
    assert.ok(scriptText.includes('// ecc:react-reviewer'), 'non-markdown files are left untouched');
    const agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('**ecc-web:react-reviewer**'));
    assert.ok(agentsMd.includes('ecc:other'));
    assert.ok(agentsMd.includes('myecc:react-reviewer'));
  }));

  record(test('CLI split is idempotent and supports re-categorizing between plugins', () => {
    const { root, configPath } = makeFixture();
    assert.strictEqual(runCli(['--root', root, '--config', configPath]).code, 0);
    assert.strictEqual(runCli(['--root', root, '--config', configPath]).code, 0);

    const cfg = baseConfig();
    const moved = {
      ...cfg,
      plugins: [
        { ...cfg.plugins[0], skills: [] },
        { ...cfg.plugins[1], skills: ['python-patterns', 'react-patterns'] },
      ],
    };
    fs.writeFileSync(configPath, JSON.stringify(moved));
    const result = runCli(['--root', root, '--config', configPath]);
    assert.strictEqual(result.code, 0, result.stderr + result.stdout);
    assert.ok(fs.existsSync(path.join(root, 'plugins', 'ecc-py', 'skills', 'react-patterns', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(root, 'plugins', 'ecc-web', 'skills')), 'empty component dirs are removed');
    const webManifest = readJson(path.join(root, 'plugins', 'ecc-web', '.claude-plugin', 'plugin.json'));
    assert.strictEqual(webManifest.skills, undefined);
  }));

  record(test('CLI fails fast when a configured component does not exist', () => {
    const cfg = baseConfig();
    const { root, configPath } = makeFixture({ ...cfg, plugins: [{ ...cfg.plugins[0], skills: ['ghost-skill'] }, cfg.plugins[1]] });
    const result = runCli(['--root', root, '--config', configPath]);
    assert.notStrictEqual(result.code, 0);
    assert.ok((result.stderr + result.stdout).includes('ghost-skill'));
    assert.ok(fs.existsSync(path.join(root, 'skills', 'python-patterns')), 'nothing moved on failure');
  }));

  record(test('CLI --restore moves everything back and reverts manifests and refs', () => {
    const { root, configPath } = makeFixture();
    const before = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.strictEqual(runCli(['--root', root, '--config', configPath]).code, 0);
    const result = runCli(['--root', root, '--config', configPath, '--restore']);
    assert.strictEqual(result.code, 0, result.stderr + result.stdout);

    assert.ok(fs.existsSync(path.join(root, 'skills', 'react-patterns', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(root, 'agents', 'react-reviewer.md')));
    assert.ok(!fs.existsSync(path.join(root, 'plugins', 'ecc-web')));
    assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), before);
    const rootManifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
    assert.strictEqual(rootManifest.dependencies, undefined);
    const market = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
    assert.deepStrictEqual(market.plugins.map(p => p.name), ['ecc']);
  }));

  record(test('CLI --no-rewrite-refs leaves references untouched', () => {
    const { root, configPath } = makeFixture();
    assert.strictEqual(runCli(['--root', root, '--config', configPath, '--no-rewrite-refs']).code, 0);
    const agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('**ecc:react-reviewer**'));
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
