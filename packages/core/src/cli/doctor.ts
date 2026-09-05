import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CONFIG_FILE_NAME, CONFIG_VERSION, findConfigFile, parseConfig } from './config.ts';
import { GUARD_ONLY_FILES } from '../harness/registry.ts';
import { OURS_TOKEN, SNIPPET_START_MD, snippetStampVersion } from '../harness/snippet.ts';
import { HARNESS_PROFILES, JSON_HOOK_FILES } from '../harness/registry.ts';
import { CLI_NAME, EXIT } from './shell.ts';

/**
 * `smelt doctor` — the reader `smelt setup` and `smelt hooks` have always lacked.
 * Everything those verbs write, this verb reads back and compares against the binary
 * running it: which release wrote the instruction blocks (the stamp inside each
 * block), whether the config parses and its store directory exists, whether the MCP
 * registration survived, and which pieces are orphans — wired without their partners.
 *
 * The verdict is ADR-0003's, verbatim: doctor reports, and never writes. When
 * something is behind, the report ends with the exact repair command — `smelt setup`
 * — and nothing more happens. The exit code carries the verdict (0 current or
 * nothing-installed, the refused exit otherwise), so the other-machine loop —
 * upgrade, `smelt doctor`, `smelt setup` — needs no prose parsing.
 */

export interface DoctorIo {
  readonly output: (text: string) => void;
  /** Where installed state is read: config discovery, instruction files, hook files. */
  readonly cwd: string;
  /** The running binary's version — what "current" is measured against. */
  readonly version: string;
}

export interface DoctorOptions {
  readonly json: boolean;
}

/** One instruction block found on disk, with the release that wrote it. */
export interface DoctorBlock {
  readonly file: string;
  /** The harness profiles whose instruction file this is (often exactly one). */
  readonly harnesses: readonly string[];
  /** The release that wrote it, or `undefined` when it predates stamping. */
  readonly installedBy?: string;
  readonly status: 'current' | 'behind' | 'unversioned';
}

/** The config as doctor saw it. A malformed config is a finding, not a crash. */
export interface DoctorConfig {
  readonly present: boolean;
  readonly malformed?: boolean;
  readonly schemaVersion?: number;
  readonly currentSchema?: boolean;
  readonly budgetBytes?: number;
  readonly store: {
    readonly kind?: 'directory' | 'memory';
    readonly path?: string;
    readonly dirExists?: boolean;
  };
}

/** One MCP registration found (or notably absent) on disk. */
export interface DoctorMcp {
  readonly file: string;
  readonly server: string;
  readonly registered: boolean;
}

/** The machine receipt — `--json`. Everything doctor read, and the verdict. */
export interface DoctorReceipt {
  readonly format: 'smelt.doctor.v1';
  readonly version: string;
  /** True when something is installed and nothing is behind and there are no orphans. */
  readonly current: boolean;
  readonly installed: boolean;
  readonly config: DoctorConfig;
  readonly blocks: readonly DoctorBlock[];
  readonly hookFiles: readonly string[];
  readonly mcp: readonly DoctorMcp[];
  readonly orphans: readonly string[];
  readonly repair: readonly string[];
}

export function runDoctor(options: DoctorOptions, io: DoctorIo): number {
  const say = (text: string): void => {
    if (!options.json) io.output(text);
  };
  const orphans: string[] = [];
  const repair: string[] = [];

  // ── the instruction blocks: every profile's instruction file that exists and is ours ──
  const blocks: DoctorBlock[] = [];
  const fileOwners = new Map<string, string[]>();
  for (const profile of Object.values(HARNESS_PROFILES)) {
    const owners = fileOwners.get(profile.instructionFile) ?? [];
    owners.push(profile.id);
    fileOwners.set(profile.instructionFile, owners);
  }
  for (const [file, harnesses] of fileOwners) {
    const path = join(io.cwd, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const ours = text.includes(SNIPPET_START_MD) || text.includes(OURS_TOKEN);
    if (!ours) continue;
    const installedBy = snippetStampVersion(text);
    const stampable = text.includes(SNIPPET_START_MD); // whole-owned files carry no stamp line yet
    const status = !stampable ? 'unversioned' : installedBy === io.version ? 'current' : 'behind';
    blocks.push({
      file,
      harnesses,
      ...(installedBy === undefined ? {} : { installedBy }),
      status,
    });
    if (status === 'behind') {
      repair.push(...harnesses.map((id) => `${CLI_NAME} setup --harness ${id}`));
    }
  }
  const behindBlocks = blocks.filter((block) => block.status === 'behind');

  // ── the hook files: JSON wiring and guard-only shims, presence and ours-ness ──
  const hookFiles: string[] = [];
  for (const name of [...JSON_HOOK_FILES, ...GUARD_ONLY_FILES]) {
    const path = join(io.cwd, name);
    if (!existsSync(path)) continue;
    if (readFileSync(path, 'utf8').includes(OURS_TOKEN)) hookFiles.push(name);
  }

  // ── the MCP registrations: every profile's declared step, checked on disk ──
  const mcpSeen = new Map<string, DoctorMcp>();
  for (const profile of Object.values(HARNESS_PROFILES)) {
    for (const step of profile.install) {
      if (step.kind !== 'mcp-registration') continue;
      const key = `${step.file}·${step.path[1]}`;
      if (mcpSeen.has(key)) continue;
      const path = join(io.cwd, step.file);
      let registered = false;
      if (existsSync(path)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
          registered =
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as Record<string, unknown>)[step.path[0]] !== undefined &&
            typeof (parsed as Record<string, Record<string, unknown>>)[step.path[0]] === 'object' &&
            (parsed as Record<string, Record<string, unknown>>)[step.path[0]]![step.path[1]] !==
              undefined;
        } catch {
          registered = false;
        }
      }
      mcpSeen.set(key, { file: step.file, server: step.path[1], registered });
    }
  }
  const mcp = [...mcpSeen.values()];

  // ── the config: present, parseable, and its store's directory real ──
  const configPath = findConfigFile(io.cwd);
  let config: DoctorConfig = {
    present: false,
    store: {},
  };
  if (configPath !== undefined) {
    try {
      const parsed = parseConfig(readFileSync(configPath, 'utf8'), configPath);
      const dirExists =
        parsed.store?.kind === 'directory'
          ? existsSync(join(dirname(configPath), parsed.store.path))
          : undefined;
      config = {
        present: true,
        schemaVersion: parsed.smeltConfig,
        currentSchema: parsed.smeltConfig === CONFIG_VERSION,
        ...(parsed.defaultBudgetBytes === undefined
          ? {}
          : { budgetBytes: parsed.defaultBudgetBytes }),
        store: {
          ...(parsed.store === undefined ? {} : { kind: parsed.store.kind }),
          ...(parsed.store?.kind === 'directory' ? { path: parsed.store.path } : {}),
          ...(dirExists === undefined ? {} : { dirExists }),
        },
      };
      if (parsed.store?.kind === 'directory' && dirExists === false) {
        orphans.push(
          `the store directory (${parsed.store.path}) does not exist — retrieves across processes would fail`,
        );
        repair.push(`${CLI_NAME} setup`);
      }
    } catch (error) {
      config = { present: true, malformed: true, store: {} };
      orphans.push(
        `${CONFIG_FILE_NAME} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
      repair.push(`${CLI_NAME} setup`);
    }
  }

  // ── orphans: pieces whose partners are missing ──
  const wired = blocks.length > 0 || hookFiles.length > 0;
  if (mcp.some((one) => one.registered) && !wired) {
    orphans.push(
      'an MCP registration is present but no hooks wiring is — the guard and the retrieval contract travel together',
    );
    repair.push(`${CLI_NAME} setup`);
  }
  if (wired && !config.present) {
    orphans.push(
      'hooks are wired but there is no smelt.config.json — the store and budget the hooks promise live there',
    );
    repair.push(`${CLI_NAME} setup`);
  }

  // ── verdict ──
  const installed = wired || config.present || mcp.some((one) => one.registered);
  const current = installed && behindBlocks.length === 0 && orphans.length === 0;

  say(`${CLI_NAME} doctor — binary ${io.version}, reading ${io.cwd}\n`);
  if (!installed) {
    say(`Nothing of smelt's is installed here. \`${CLI_NAME} setup\` would change that.\n`);
  } else {
    if (config.present) {
      say(
        `  ${CONFIG_FILE_NAME}: ${
          config.malformed === true
            ? 'MALFORMED'
            : `schema ${String(config.schemaVersion)}, budget ${
                config.budgetBytes === undefined ? 'unset' : String(config.budgetBytes)
              }, store ${describeStore(config)}`
        }\n`,
      );
    } else {
      say(`  ${CONFIG_FILE_NAME}: absent\n`);
    }
    for (const block of blocks) {
      say(
        `  ${block.file}: written by ${
          block.installedBy ?? 'a pre-stamping release (unversioned)'
        } [${block.status}] — ${block.harnesses.join(', ')}\n`,
      );
    }
    for (const name of hookFiles) say(`  ${name}: wired\n`);
    for (const one of mcp) {
      if (one.registered) say(`  ${one.file}: ${one.server} registered\n`);
    }
    for (const orphan of orphans) say(`  ORPHAN: ${orphan}\n`);
    if (behindBlocks.length > 0) {
      say(
        `\nBehind: the running binary is ${io.version}; re-run setup to bring the ` +
          `installed state to it:\n` +
          [...new Set(repair)].map((command) => `  ${command}\n`).join(''),
      );
    } else if (orphans.length > 0) {
      say(`\nRepair:\n${[...new Set(repair)].map((command) => `  ${command}\n`).join('')}`);
    }
    say(
      current
        ? `Current: everything on disk agrees with binary ${io.version}.\n`
        : `Not current — see above. Doctor never writes; ${CLI_NAME} setup is the repair.\n`,
    );
  }

  if (options.json) {
    const receipt: DoctorReceipt = {
      format: 'smelt.doctor.v1',
      version: io.version,
      current,
      installed,
      config,
      blocks,
      hookFiles,
      mcp,
      orphans,
      repair: [...new Set(repair)],
    };
    io.output(JSON.stringify(receipt, null, 2) + '\n');
  }
  return current || !installed ? EXIT.ok : EXIT.refused;
}

function describeStore(config: DoctorConfig): string {
  if (config.store.kind === undefined) return 'unset';
  if (config.store.kind === 'memory') return 'memory';
  return `directory at ${config.store.path ?? ''} (${
    config.store.dirExists ? 'present' : 'MISSING'
  })`;
}
