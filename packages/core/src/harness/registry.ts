import { aider } from './aider.ts';
import { claudeCode } from './claude-code.ts';
import { cline } from './cline.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { gemini } from './gemini.ts';
import { grok } from './grok.ts';
import { hermes } from './hermes.ts';
import { kilocode } from './kilocode.ts';
import { opencode } from './opencode.ts';
import type { HarnessId, HarnessJsonHooks, HarnessProfile } from './profile.ts';

/**
 * The registry — every harness smelt knows, one {@link HarnessProfile} each.
 *
 * `Record<HarnessId, HarnessProfile>` on purpose: adding a `HarnessId` in `profile.ts`
 * without writing its profile is a compile error, so the id list and the facts cannot
 * drift. Every derived view — the `--harness` help list, the wizard's table, the
 * managed event names, the files a re-run reads its toggles back from — is computed
 * from this object, never written twice.
 *
 * This module imports **nothing from `cli/`**. That is the point: the registry used to
 * live in `cli/hooks.ts`, which imports `CLI_NAME` from `cli/args.ts`, so `args.ts`
 * could not import it back and the `--harness` help list was hand-typed five lines
 * below two lists that were correctly derived.
 *
 * Key order is meaningful: it is the order every rendered harness list uses (the help
 * text, the wizard's table, the "Known: …" of an unknown-harness error), so keep it
 * stable and append new harnesses at the end.
 */
export const HARNESS_PROFILES: Readonly<Record<HarnessId, HarnessProfile>> = {
  'claude-code': claudeCode,
  codex,
  gemini,
  grok,
  hermes,
  cursor,
  opencode,
  cline,
  kilocode,
  aider,
};

/** Every profile, in registry order. The list every rendered table walks. */
export const HARNESSES: readonly HarnessProfile[] = Object.values(HARNESS_PROFILES);

/** Every harness id, in registry order — the `--harness` help list, derived. */
export const HARNESS_IDS: readonly HarnessId[] = HARNESSES.map((profile) => profile.id);

/** The profile for a harness id, or `undefined` for a string the user made up. */
export function harnessById(id: string): HarnessProfile | undefined {
  return HARNESSES.find((profile) => profile.id === id);
}

/** Every JSON hook step any profile declares, in registry order. */
function jsonHookSteps(): readonly HarnessJsonHooks[] {
  return HARNESSES.flatMap((profile) =>
    profile.install.filter((step): step is HarnessJsonHooks => step.kind === 'json-hooks'),
  );
}

/**
 * The two session-lifecycle hooks this preset offers, named in each harness's schema:
 * `smelt stats` when a turn ends, an opening `smelt map` when a session starts. Only
 * the harnesses whose schema carries these events wire them (`step.lifecycle`), and
 * `cli/hooks.ts` writes the entries under these exact keys — one spelling, so the
 * managed-event list below cannot fall behind what the installer writes.
 */
export const LIFECYCLE_EVENTS = { stats: 'Stop', map: 'SessionStart' } as const;

/**
 * The events this installer manages, across every harness's spelling of them —
 * foreign entries under them are always preserved, and events nobody claims are never
 * touched. Derived, so a harness that spells its pre-tool event a new way is managed
 * by existing.
 */
export const MANAGED_EVENTS: readonly string[] = [
  ...new Set(
    jsonHookSteps().flatMap((step) => [
      step.event,
      ...(step.lifecycle ? Object.values(LIFECYCLE_EVENTS) : []),
    ]),
  ),
];

/** The managed events that wire the PreToolUse guard, across harness spellings. */
export const GUARD_EVENTS: readonly string[] = [
  ...new Set(jsonHookSteps().map((step) => step.event)),
];

/** The JSON hook files a re-run reads installed toggles back from, per harness. */
export const JSON_HOOK_FILES: readonly string[] = [
  ...new Set(jsonHookSteps().map((step) => step.file)),
];

/** Guard-only files whose presence means the guard toggle was installed. */
export const GUARD_ONLY_FILES: readonly string[] = [
  ...new Set(
    HARNESSES.flatMap((profile) =>
      profile.install
        .filter((step) => step.kind === 'own-file' && step.guardOnly)
        .map((step) => step.file),
    ),
  ),
];
