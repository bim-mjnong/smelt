import { useState } from 'react';
import { cn } from '@/lib/utils';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Copy affordance: icon swaps to a check for 1.5s; state announced politely. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — leave the text selectable */
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-150',
        copied ? 'text-ember' : 'text-iron-light hover:text-slag',
        className,
      )}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite" className="sr-only">
        {copied ? 'copied' : ''}
      </span>
    </button>
  );
}
