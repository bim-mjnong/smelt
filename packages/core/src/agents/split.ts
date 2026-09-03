import { citing, GUIDE, GUIDE_URL } from './guide.ts';
import type { InstructionFile } from './instructions.ts';

/**
 * `smelt agents split` — the **mechanical half** of the guide's refactor, and a plain
 * statement of where the other half is.
 *
 * The guide's advice for a bloated instruction file is to cut it down to a small root
 * that points elsewhere, moving the rest into `docs/`. That advice has two halves, and
 * they are not the same kind of work:
 *
 *  - **Mechanical.** Find the sections. Decide what each one's file is called. Move
 *    the bytes. Fix every relative link that just moved a directory deeper. Leave a
 *    link to each moved file behind. All of this is text manipulation with a right
 *    answer, and it is what this module does.
 *  - **Judgment.** *Which sections are essential enough to stay in the root?* Which
 *    two paragraphs contradict each other? Which rule is too vague to be worth a
 *    token? That is a reading of a specific project by someone who knows it, which
 *    means a model, which Law 1 forbids smelt from being (ruling R1).
 *
 * So the seam is stated instead of straddled: {@link planSplit} returns a partition
 * anyone can check, and {@link refactorPrompt} returns the guide's own refactor
 * prompt **filled in with this file's actual section headings**, for the user to hand
 * to their own agent. smelt does the part with a right answer and hands over the part
 * that needs a reader — the same shape as the unconfigured rerank stage, and the same
 * reason.
 *
 * Nothing here writes. `cli/agents.ts` owns the confirm-listing discipline
 * (`smelt init`'s, verbatim: every file listed, one final confirm, an existing file
 * never overwritten without a per-file `yes`).
 */

/** Where the moved sections go. The guide's own suggested layout. */
export const SPLIT_DIR = 'docs';

/** One `##` section of an instruction file. */
export interface InstructionSection {
  /** The heading text, without its `##`. */
  readonly title: string;
  /** 1-based line of the heading. */
  readonly line: number;
  /** The section's body, heading excluded, trailing blank lines trimmed. */
  readonly body: string;
  /** UTF-8 bytes of heading + body — what moving this section saves the root file. */
  readonly bytes: number;
}

/** One file the split would write, already rendered. */
export interface SplitFile {
  /** Root-relative, `/`-separated. */
  readonly path: string;
  readonly content: string;
  /** What this file is, for the confirm listing. */
  readonly role: 'root' | 'section';
}

/** The whole mechanical proposal. Pure data: nothing on disk has moved. */
export interface SplitPlan {
  /** The file that was read. */
  readonly source: string;
  /** Its size before. */
  readonly beforeBytes: number;
  /** What the root file would become. */
  readonly afterBytes: number;
  /** The sections found, in document order. */
  readonly sections: readonly InstructionSection[];
  /** Root file first, then one file per moved section. */
  readonly files: readonly SplitFile[];
  /**
   * Why the plan is empty, when it is: a file with no `##` sections has nothing to
   * partition **by**, and inventing a partition would be the judgment half.
   */
  readonly refusal?: string;
}

/**
 * Partition one instruction file into a root and one file per `##` section.
 *
 * The partition is **by heading and nothing else**. That is the honest mechanical
 * rule: a split by heading is reproducible, reversible by hand, and obviously not a
 * judgment about what matters — which is exactly what it must not pretend to be.
 *
 * The preamble (everything above the first `##`) stays in the root, because in a
 * file written to the guide's shape the preamble *is* the essentials: the title and
 * the one-sentence description.
 */
export function planSplit(file: InstructionFile): SplitPlan {
  const sections = readSections(file.text);
  const before = file.bytes;

  if (sections.length === 0) {
    return {
      source: file.path,
      beforeBytes: before,
      afterBytes: before,
      sections: [],
      files: [],
      refusal:
        `${file.path} has no \`##\` sections, so there is nothing to partition by. ` +
        `A split invented without headings would be smelt deciding what matters, ` +
        `which is the half of the refactor it deliberately does not do.`,
    };
  }

  const used = new Set<string>();
  const moved = sections.map((section) => {
    const path = `${SPLIT_DIR}/${uniqueSlug(section.title, used)}.md`;
    return { section, path };
  });

  const rootContent = renderRoot(file.text, sections, moved);
  const files: SplitFile[] = [
    { path: file.path, content: rootContent, role: 'root' },
    ...moved.map(({ section, path }): SplitFile => ({
      path,
      content: renderSection(section),
      role: 'section',
    })),
  ];

  return {
    source: file.path,
    beforeBytes: before,
    afterBytes: Buffer.byteLength(rootContent, 'utf8'),
    sections,
    files,
  };
}

/* ------------------------------------------------------------------------------------
 * Reading sections
 * ---------------------------------------------------------------------------------- */

/**
 * Every `##` section, fences respected.
 *
 * A `## ` inside a fenced block is a Markdown example or a shell comment, not a
 * heading — splitting on one would cut a code block in half, which is the kind of
 * damage that makes a tool untrustworthy the first time it happens.
 */
export function readSections(text: string): readonly InstructionSection[] {
  const lines = text.split('\n');
  const starts: { readonly index: number; readonly title: string }[] = [];
  let fence: string | undefined;

  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      if (fence === undefined) fence = marker[1]!.slice(0, 1);
      else if (marker[1]!.startsWith(fence)) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) starts.push({ index, title: heading[1]! });
  });

  return starts.map(({ index, title }, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    const body = lines
      .slice(index + 1, end)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    return {
      title,
      line: index + 1,
      body,
      bytes: Buffer.byteLength(`${lines[index]!}\n${body}\n`, 'utf8'),
    };
  });
}

/* ------------------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------------------- */

/** The moved section as its own file: the heading promoted to `#`, links rewritten. */
function renderSection(section: InstructionSection): string {
  return `# ${section.title}\n\n${rewriteLinks(section.body)}\n`;
}

/**
 * The root file: everything above the first `##`, then one link per moved section.
 *
 * The link list is the point of the whole exercise — the guide's ideal root file is
 * small and points elsewhere — so it is written plainly, one line per section, with
 * the section's own title as the link text.
 */
function renderRoot(
  text: string,
  sections: readonly InstructionSection[],
  moved: readonly { readonly section: InstructionSection; readonly path: string }[],
): string {
  const lines = text.split('\n');
  const preamble = lines
    .slice(0, (sections[0]?.line ?? lines.length + 1) - 1)
    .join('\n')
    .replace(/\n+$/, '');
  const links = moved.map(({ section, path }) => `- [${section.title}](${path})`).join('\n');
  return `${preamble}\n\n## More\n\n${links}\n`;
}

/**
 * Fix the relative links in a section that is moving one directory down.
 *
 * A section that said `[the gate](CONTRIBUTING.md)` at the root must say
 * `../CONTRIBUTING.md` from `docs/`, or the split turns a working pointer into a
 * `dead-link` — the lint's own flagship finding, minted by the tool that fixes it.
 * External links, anchors and paths that already climb out are left alone.
 */
export function rewriteLinks(body: string): string {
  return body.replace(
    /(\[[^\]]*\]\()([^)\s]+)(\))/g,
    (whole, open: string, target: string, close: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
      if (target.startsWith('#') || target.startsWith('/') || target.startsWith('..')) return whole;
      const cleaned = target.startsWith('./') ? target.slice(2) : target;
      if (cleaned.startsWith(`${SPLIT_DIR}/`))
        return `${open}${cleaned.slice(SPLIT_DIR.length + 1)}${close}`;
      return `${open}../${cleaned}${close}`;
    },
  );
}

/** `Build & test` → `build-test`, made unique within one plan. */
function uniqueSlug(title: string, used: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'section';
  let slug = base;
  let counter = 2;
  while (used.has(slug)) {
    slug = `${base}-${String(counter)}`;
    counter += 1;
  }
  used.add(slug);
  return slug;
}

/* ------------------------------------------------------------------------------------
 * The judgment half, handed over
 * ---------------------------------------------------------------------------------- */

/**
 * The guide's refactor prompt, filled in with this file's real sections.
 *
 * This is the seam, printed. smelt will not decide which of somebody's sections are
 * essential — that is a reading of their project, and Law 1 keeps smelt offline and
 * modelless — so it hands over the guide's own five-step prompt with the section list
 * already substituted in, ready to paste into whichever agent the user is running.
 *
 * The five steps are the guide's; the wording is smelt's summary of them, with the
 * article cited so the reader can check it. The list of sections is measured, not
 * invented: every heading and every byte count comes from the file on disk.
 */
export function refactorPrompt(plan: SplitPlan): string {
  const inventory = plan.sections
    .map(
      (section) =>
        `  - "${section.title}" (${String(section.bytes)} bytes, line ${String(section.line)})`,
    )
    .join('\n');

  return [
    `Here is my ${plan.source} (${String(plan.beforeBytes)} bytes). Its \`##\` sections are:`,
    '',
    inventory,
    '',
    `Refactor it, following the five steps from ${GUIDE_URL}:`,
    '',
    '  1. Find contradictions. Where two instructions conflict, show me both and ask',
    '     which one to keep — do not pick for me.',
    '  2. Identify the essentials for the root file: a one-sentence project description,',
    '     the package manager if it is not npm, the build and typecheck commands if they',
    '     are non-standard, and anything genuinely relevant to every task.',
    '  3. Group the rest into categories (TypeScript, testing, API design, git workflow),',
    '     one file per category.',
    '  4. Create the file structure: a minimal root that links to each file, and the',
    '     files themselves under docs/.',
    '  5. Flag for deletion anything redundant, too vague to be actionable, or so obvious',
    '     it is not worth a token on every request.',
    '',
    `Why this matters: ${GUIDE.loadsEveryRequest}.`,
    '',
  ].join('\n');
}

/** The one sentence that says where smelt stops. Printed by the CLI, and in its help. */
export function splitSeamNotice(): string {
  return (
    `smelt did the mechanical half: it partitioned by heading, rewrote the links that ` +
    `moved a directory, and wrote nothing without asking. It did NOT decide which ` +
    `sections are essential — that is a reading of your project, so it needs a model, ` +
    `and smelt has none by law. The prompt above is the judgment half, filled in with ` +
    `your real sections; hand it to your own agent` +
    citing(GUIDE.pointsElsewhere)
  );
}
