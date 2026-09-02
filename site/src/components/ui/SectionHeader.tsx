import type { ReactNode } from 'react';

/**
 * Asymmetric section header (terminal-dark §2.2): headline left on the grid,
 * description right, a numbered index line in mono underneath the description.
 */
export function SectionHeader({
  id,
  index,
  title,
  lead,
  children,
}: {
  id: string;
  index: string;
  title: ReactNode;
  lead: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-12 md:gap-8">
      <h2
        id={id}
        className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ash md:col-span-6 md:text-[32px] lg:text-[38px]"
      >
        {title}
      </h2>
      <div className="md:col-span-5 md:col-start-8">
        <p className="max-w-[52ch] text-[15px] leading-[1.6] text-slag md:text-base">{lead}</p>
        <p className="mt-3 font-mono text-[13px] text-iron-light" aria-hidden="true">
          {index}
        </p>
        {children}
      </div>
    </div>
  );
}
