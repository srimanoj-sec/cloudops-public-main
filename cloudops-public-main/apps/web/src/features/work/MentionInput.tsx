import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Textarea, cn } from '../../components/ui/primitives';

/**
 * A comment box that completes @mentions from the people directory. Picking a
 * person inserts `@Full Name`; the API notifies everyone mentioned that way.
 * Enter (without Shift) submits.
 */
export function MentionInput({
  value,
  onChange,
  onSubmit,
  people,
  placeholder,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  people: string[];
  placeholder?: string;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const token = useMemo(() => /(^|\s)@([^@\n]{0,40})$/.exec(value.slice(0, caret))?.[2] ?? null, [value, caret]);
  const matches = useMemo(() => {
    if (token === null || token === dismissed) return [];
    const q = token.toLowerCase();
    return people.filter((p) => p.toLowerCase().includes(q) && p.toLowerCase() !== q).slice(0, 6);
  }, [token, dismissed, people]);
  const open = matches.length > 0;

  function insert(name: string) {
    const before = value.slice(0, caret).replace(/@([^@\n]{0,40})$/, `@${name} `);
    const next = before + value.slice(caret);
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(matches[Math.min(active, matches.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(token);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <Textarea
        ref={ref}
        rows={2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="min-h-[2.5rem] resize-y"
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People"
          className="absolute bottom-full left-0 z-20 mb-1 w-64 animate-pop-in overflow-hidden rounded-md border border-line-strong bg-overlay p-1 shadow-2"
        >
          {matches.map((p, i) => (
            <li
              key={p}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(p);
              }}
              className={cn(
                'cursor-pointer truncate rounded-xs px-2.5 py-1.5 text-body-sm',
                i === active ? 'bg-hover text-fg' : 'text-fg-secondary',
              )}
            >
              @{p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
