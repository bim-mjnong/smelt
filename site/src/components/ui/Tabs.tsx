import { useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * A proper tablist: keyboard-operable (arrow keys, Home/End), cross-fades content in
 * 150ms with no layout jump (the panel keeps whatever height the tallest use needs
 * via the caller's min-height).
 */
export function Tabs({
  tabs,
  label,
  className,
  onChange,
}: {
  tabs: readonly Tab[];
  label: string;
  className?: string;
  onChange?: (id: string) => void;
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  const select = (i: number) => {
    const next = (i + tabs.length) % tabs.length;
    setActive(next);
    refs.current[next]?.focus();
    onChange?.(tabs[next]!.id);
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowRight') select(i + 1);
    else if (e.key === 'ArrowLeft') select(i - 1);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(tabs.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={i === active}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => {
              setActive(i);
              onChange?.(tab.id);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'rounded-[6px] px-3 py-1.5 font-mono text-[13px] transition-colors duration-150',
              i === active
                ? 'bg-lift text-ash shadow-[inset_0_0_0_1px_var(--color-iron-dark)]'
                : 'text-iron-light hover:text-slag',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={i !== active}
          className="mt-2 transition-opacity duration-150"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
