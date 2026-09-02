import { SectionHeader } from '@/components/ui/SectionHeader';
import { Frame, FrameBar } from '@/components/ui/Frame';
import { Reveal } from '@/components/ui/Reveal';

/**
 * Every byte below was captured from a real run of the built CLI on 2026-09-02 against
 * the repo's own `src/plan/lexical.ts`, in a fresh directory store. Nothing is edited.
 * Law 4 applies to terminal screenshots too.
 */
const STEPS: readonly { cmd: string; out: string; emberLine?: number }[] = [
  {
    cmd: 'smelt src/plan/lexical.ts --budget 4000 --focus planLexical --strategy structural > out.ts',
    out: `smelt  src/plan/lexical.ts  typescript  structural/v1
in 8,687 B → out 3,566 B   (-59.0%, 2 elisions)

  rule              lines  bytes  hash              explanation
  sibling-collapse     28  1,137  66115e5d2d09b7e9  collapsed 6 sibling declarations (2 import st…
  sibling-collapse    122  4,210  c2076c2dbb2bb34c  collapsed 9 sibling functions`,
  },
  {
    cmd: 'head -1 out.ts',
    out: '// <<smelt/v1: collapsed 6 sibling declarations (2 import statements, 2 variables, 2 interfaces) (1137B) — retrieve("66115e5d2d09b7e9")>>',
    emberLine: 0,
  },
  {
    cmd: 'smelt retrieve c2076c2dbb2bb34c | head -4',
    out: `/** Context-window sizes to try, largest first. */
function ladder(start: number): readonly number[] {
  const sizes: number[] = [];
  for (let n = start; n >= 0; n -= 1) sizes.push(n);`,
  },
  {
    cmd: 'smelt stats',
    out: `elisionsStored 2
bytesStored 5347
retrieveCalls 1
uniqueRetrieved 1
expansionRate 0.5
allElisionsRetrieved false`,
  },
];

export function Tour() {
  return (
    <section aria-labelledby="tour" className="border-b border-iron-dark">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="tour"
          index="02 · smelt → retrieve → stats →"
          title={
            <>
              Sixty seconds, from a shell.{' '}
              <span className="text-slag">The whole loop is four commands.</span>
            </>
          }
          lead={
            <>
              Cut a real file under a byte budget, read the marker it left, get the exact bytes
              back by hash, and watch the counters move. Recorded from the built CLI on the repo's
              own lexical planner — output unedited.
            </>
          }
        />
        <Reveal className="mt-10">
          <Frame>
            <FrameBar label="~/demo" meta="@smeltjs/core v0.2.0 · recorded 2026-09-02" />
            <div className="relative scroll-hint">
              <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.7] sm:p-5">
                <code>
                  {STEPS.map((step, i) => (
                    <span key={i}>
                      {i > 0 ? '\n\n' : ''}
                      <span aria-hidden="true" className="select-none text-iron-light">
                        {'$ '}
                      </span>
                      <span className="text-ash">{step.cmd}</span>
                      {'\n'}
                      {step.out.split('\n').map((line, j) => (
                        <span key={j} className={step.emberLine === j ? 'text-ember' : 'text-slag'}>
                          {line}
                          {'\n'}
                        </span>
                      ))}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          </Frame>
          <p className="mt-4 max-w-[72ch] text-[13px] leading-[1.6] text-iron-light">
            The report goes to stderr, the smelted text to stdout — the two pipe apart. The exit
            code is non-zero when a plan comes back over budget, and the report says so instead of
            cutting what you asked to keep. <code className="font-mono">expansionRate 0.5</code>{' '}
            above is the honest signal: one of two hidden blobs was asked back for.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
