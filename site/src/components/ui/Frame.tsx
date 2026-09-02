import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page's one structural motif (terminal-dark §10.1): an outer frame holding an
 * inner surface, hairline on both, 4px gap, concentric radii 16 → 12. It wraps the
 * things a developer looks INTO — terminals, code, tables. Prose never gets a frame.
 */
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-[16px] border border-iron-dark bg-[#0f1013] p-1', className)}>
      <div className="overflow-hidden rounded-[12px] border border-iron-dark bg-lift">{children}</div>
    </div>
  );
}

/** The frame's chrome bar: a filename/label tab plus right-side metadata. */
export function FrameBar({
  label,
  meta,
  right,
}: {
  label: string;
  meta?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-iron-dark px-4 py-2">
      <span className="font-mono text-[13px] text-slag">{label}</span>
      {meta ? <span className="ml-auto font-mono text-[12px] text-iron-light">{meta}</span> : null}
      {right ? <span className={meta ? '' : 'ml-auto'}>{right}</span> : null}
    </div>
  );
}
