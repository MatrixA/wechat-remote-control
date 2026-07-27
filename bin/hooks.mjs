/**
 * Install / uninstall the agent hooks (and Claude's status line).
 *
 * Driven by `bin/wrc hooks install|uninstall`; SKILL.md's attach Step 4/5 and uninstall
 * Step 1 shell out to the same command instead of carrying their own copy of the merge.
 * All the decisions live in dist/hookcmd.js + dist/hookuninstall.js, where they are unit
 * tested — this file is only I/O: pick the config file, read it, hand it to the pure
 * function, write it back atomically.
 *
 * Usage:  node bin/hooks.mjs install|uninstall [--agent claude|codex|both] [--skill-dir DIR]
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CONFIG_DIR, CODEX_HOME } from '../dist/constants.js';
import { mergeWrcHooks, wrcStatusLine, hookConfigFileFor, HOOK_MARK } from '../dist/hookcmd.js';
import { stripWrcHooks, stripWrcStatusLine } from '../dist/hookuninstall.js';

const DEFAULT_SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const action = argv[0];
  const opts = { action, agent: 'both', skillDir: DEFAULT_SKILL_DIR };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--agent') opts.agent = argv[++i];
    else if (argv[i] === '--skill-dir') opts.skillDir = argv[++i];
    else die(`unknown argument: ${argv[i]}`);
  }
  if (action !== 'install' && action !== 'uninstall') die('expected "install" or "uninstall"');
  if (!['claude', 'codex', 'both'].includes(opts.agent)) die(`--agent must be claude, codex or both (got "${opts.agent}")`);
  return opts;
}

function die(msg) {
  console.error(`hooks: ${msg}`);
  process.exit(2);
}

const configDirFor = (kind) => (kind === 'codex' ? CODEX_HOME : CLAUDE_CONFIG_DIR);

function readConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Never clobber a config we cannot parse — a half-written settings.json is the
    // user's problem to look at, and overwriting it would lose their other tools.
    die(`${path} is not valid JSON (${err.message}) — fix or move it, then re-run`);
  }
}

/** Write via a temp file + rename so a crash mid-write cannot truncate the config. */
function writeConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.wrc-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, path);
}

function install(kind, skillDir) {
  const path = hookConfigFileFor(kind, configDirFor(kind));
  const cfg = readConfig(path);
  const wasInstalled = JSON.stringify(cfg).includes(HOOK_MARK);

  mergeWrcHooks(cfg, skillDir, kind);
  // Codex has no status-line mechanism; only Claude gets one.
  if (kind === 'claude') cfg.statusLine = wrcStatusLine(skillDir);
  writeConfig(path, cfg);

  console.log(`hooks installed  agent=${kind} file=${path}`);
  if (kind === 'codex' && !wasInstalled) {
    // Codex reads hooks.json once at startup. Without a restart its turns complete but
    // no Stop ever reaches the bridge, so the IM sits on "typing" forever.
    console.log('  NOTE: codex reads hooks.json only at startup — restart it in its tmux pane');
    console.log('        (/quit, then `codex resume --last` to keep the conversation).');
  }
  return path;
}

function uninstall(kind, skillDir) {
  const path = hookConfigFileFor(kind, configDirFor(kind));
  if (!existsSync(path)) {
    console.log(`hooks absent     agent=${kind} file=${path} (nothing to remove)`);
    return path;
  }
  const cfg = readConfig(path);
  stripWrcHooks(cfg, skillDir);
  if (kind === 'claude') stripWrcStatusLine(cfg, skillDir);
  writeConfig(path, cfg);

  console.log(`hooks removed    agent=${kind} file=${path}`);
  return path;
}

const { action, agent, skillDir } = parseArgs(process.argv.slice(2));
const kinds = agent === 'both' ? ['claude', 'codex'] : [agent];
for (const kind of kinds) {
  if (action === 'install') install(kind, skillDir);
  else uninstall(kind, skillDir);
}
