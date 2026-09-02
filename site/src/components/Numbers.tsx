import bench from '@/generated/bench.json';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Reveal } from '@/components/ui/Reveal';

/**
 * Law 4, mechanically: this table is generated at build time from the latest tier-1
 * run in packages/core/bench/RESULTS.md (see scripts/bench-data.mjs). No number here
 * is typed by hand; the reduction column is computed from the measured bytes.
 */
interface Row {
  case: string;
  inputBytes: number;
  outputBytes: number;
  elisions: number;
  note: string;
  overBudget: boolean;
}

const fmt = new Intl.NumberFormat('en-US');

function plannerOf(note: string): string {
  const m = note.match(/(structural|lexical)\/v\d+/);
  return m ? m[0] : '—';
}

function budgetOf(note: string): string {
  const m = note.match(/budget ([\d,]+) B/);
  return m ? `${m[1]} B` : '—';
}

function reduction(row: Row): string {
  const pct = ((row.outputBytes - row.inputBytes) / row.inputBytes) * 100;
  return `${pct.toFixed(1)}%`;
}

export function Numbers() {
  const rows = bench.rows as Row[];
  return (
    <section aria-labelledby="numbers" className="border-b border-iron-dark">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="numbers"
          index="05 · measured, or absent →"
          title={
            <>
              Measured numbers.{' '}
              <span className="text-slag">Generated from the bench table, never typed.</span>
            </>
          }
          lead={
            <>
              From the committed measurement harness (
              <code className="font-mono text-[13px]">pnpm bench</code>
              ), tier 1 — bytes and elision counts, deterministic, offline, reproducible from a
              fresh clone. This table is parsed out of{' '}
              <code className="font-mono text-[13px]">bench/RESULTS.md</code> at build time.
            </>
          }
        />

        <Reveal className="mt-10">
          <div className="grid gap-10 lg:grid-cols-12 lg:gap-8">
            <div className="lg:col-span-8">
              <p className="font-mono text-[13px] text-slag">
                run {bench.runDate} · corpus {bench.corpusCommit} · {bench.tier} · unit: UTF-8 bytes
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-iron-dark">
                      <th
                        scope="col"
                        className="py-2.5 pr-4 font-mono text-[13px] font-normal text-slag"
                      >
                        case
                      </th>
                      <th
                        scope="col"
                        className="py-2.5 pr-4 font-mono text-[13px] font-normal text-slag"
                      >
                        planner
                      </th>
                      <th
                        scope="col"
                        className="py-2.5 pr-4 font-mono text-[13px] font-normal text-slag"
                      >
                        budget
                      </th>
                      <th
                        scope="col"
                        className="py-2.5 pr-4 text-right font-mono text-[13px] font-normal text-slag"
                      >
                        in (B)
                      </th>
                      <th
                        scope="col"
                        className="py-2.5 pr-4 text-right font-mono text-[13px] font-normal text-slag"
                      >
                        out (B)
                      </th>
                      <th
                        scope="col"
                        className="py-2.5 text-right font-mono text-[13px] font-normal text-slag"
                      >
                        reduction
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[13px]">
                    {rows.map((row) => (
                      <tr key={row.case} className="border-b border-iron-dark">
                        <td className="py-3 pr-4 text-ash">{row.case}</td>
                        <td className="py-3 pr-4 text-slag">{plannerOf(row.note)}</td>
                        <td className="py-3 pr-4 text-slag">{budgetOf(row.note)}</td>
                        <td className="py-3 pr-4 text-right text-slag">
                          {fmt.format(row.inputBytes)}
                        </td>
                        <td className="py-3 pr-4 text-right text-slag">
                          {fmt.format(row.outputBytes)}
                        </td>
                        <td className="py-3 text-right">
                          {row.overBudget ? (
                            <span className="text-ember">over budget, reported</span>
                          ) : (
                            <span className="text-ash">{reduction(row)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 font-mono text-[12px] text-slag">
                generated at build time by site/scripts/bench-data.mjs from
                packages/core/bench/RESULTS.md
              </p>
            </div>

            <div className="text-[14px] leading-[1.7] text-slag lg:col-span-4">
              <h3 className="font-mono text-[13px] text-iron-light">what these are / are not</h3>
              <p className="mt-2">
                <span className="text-ash">What these are:</span> byte reductions on a small
                committed corpus, each row reproducible with{' '}
                <code className="font-mono text-[13px]">pnpm bench</code>.
              </p>
              <p className="mt-3">
                <span className="text-ash">What they are not:</span> token savings, cost savings, or
                an aggregate claim — the corpus is six cases, the build-log row is a synthetic
                best-case and says so in its header, and one case came back over budget and is
                reported as exactly that.
              </p>
              <p className="mt-3">
                Token counts (tier 2) and the expansion rate on real traffic (tier 3) have not been
                run yet; until they are, this page claims nothing about them.
              </p>
              <p className="mt-3">
                For the class of saving to expect on real agent traffic, the honest comparable
                remains{' '}
                <a
                  href="https://github.com/headroomlabs-ai/headroom"
                  className="text-ash underline decoration-iron underline-offset-4 transition-colors hover:decoration-ember"
                >
                  Headroom's
                </a>{' '}
                stated 21–57% across its four proof scenarios (README, 2026-09) — their numbers, on
                their corpus, cited as exactly that.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
