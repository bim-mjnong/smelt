/**
 * The SetupRecipe (CONTEXT.md): the one true way to put smelt on a machine — the
 * install commands, the init defaults, the store default, the hooks step, the MCP
 * registration — held as data, because prose is never the source. Every rendering
 * derives from this module or is pinned to it by a guard
 * (`test/guards/setup-recipe.test.ts`); the same facts used to be retyped until the
 * store default existed under three doc spellings, one of them wrong, and the MCP
 * registration command lived in four places at once.
 *
 * This module imports nothing and does nothing: it is the fact layer every setup
 * surface reads, and the seam the `setup` verb, the skill pack, and the site's fact
 * generator hang off.
 */
export const SETUP_RECIPE = {
  install: {
    /** The library, into a project. */
    library: 'npm install @smeltjs/core',
    /** The CLI, onto the machine. (Not named `global`: that word is Law 1's.) */
    globalInstall: 'npm install -g @smeltjs/core',
    /** The CLI, without installing it. */
    oneShot: 'npx @smeltjs/core',
  },
  /**
   * The budget the setup path writes when its caller names none — the number every
   * example already uses. Written loudly and recorded with its provenance; the
   * `smelt` verb's own budget-required refusal is untouched by it.
   */
  recommendedBudgetBytes: 4000,
  store: {
    /** Where the persistent store lives, relative to smelt.config.json. */
    defaultDir: '.smelt/store',
  },
  mcp: {
    /** The MCP server, run from the project directory. */
    run: 'npx @smeltjs/mcp',
    /**
     * Registration as Claude Code's CLI spells it — the canonical string while the
     * harness profiles cannot yet carry per-harness registration; the
     * mcp-registration step kind generalizes this per harness.
     */
    register: 'claude mcp add smelt -- npx @smeltjs/mcp',
  },
} as const;

export type SetupRecipe = typeof SETUP_RECIPE;

/** One step of the recipe, in the order a new machine walks it. */
export interface SetupStep {
  readonly id: 'install' | 'init' | 'hooks' | 'mcp';
  readonly title: string;
  readonly command: string;
}

/**
 * The recipe's steps, in order. Every command is a named fact above — a step that
 * retyped its command here would be the second copy this module exists to end.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
  { id: 'install', title: 'install the CLI', command: SETUP_RECIPE.install.globalInstall },
  { id: 'init', title: 'write smelt.config.json', command: 'smelt init' },
  { id: 'hooks', title: 'wire the hooks preset', command: 'smelt hooks install' },
  { id: 'mcp', title: 'register the MCP server', command: SETUP_RECIPE.mcp.register },
];
