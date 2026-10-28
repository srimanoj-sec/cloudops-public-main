import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Field, Input } from './Form';
import { Modal } from './Modal';

/**
 * Promise-based replacements for window.confirm / window.prompt, rendered with
 * the app's dialog. Usage: `if (!(await confirm({ title: 'Delete?' }))) return;`
 */

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}
interface PromptOptions {
  title: string;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  initialValue?: string;
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

interface DialogsApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogsContext = createContext<DialogsApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', opts, resolve })),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions) => new Promise<string | null>((resolve) => setPending({ kind: 'prompt', opts, resolve })),
    [],
  );
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogsContext.Provider value={api}>
      {children}
      {pending?.kind === 'confirm' && (
        <ConfirmDialog
          opts={pending.opts}
          onDone={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
      {pending?.kind === 'prompt' && (
        <PromptDialog
          opts={pending.opts}
          onDone={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
    </DialogsContext.Provider>
  );
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (v: boolean) => void }) {
  return (
    <Modal
      size="sm"
      title={opts.title}
      onClose={() => onDone(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)} data-autofocus>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button variant={opts.tone === 'danger' ? 'danger' : 'primary'} onClick={() => onDone(true)}>
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="text-body text-fg-secondary">{opts.description ?? 'Are you sure?'}</div>
    </Modal>
  );
}

function PromptDialog({ opts, onDone }: { opts: PromptOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initialValue ?? '');
  const submit = () => value.trim() && onDone(value);
  return (
    <Modal
      size="sm"
      title={opts.title}
      description={opts.description}
      onClose={() => onDone(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            {opts.confirmLabel ?? 'Save'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={opts.label} required>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={opts.placeholder} />
        </Field>
      </form>
    </Modal>
  );
}

export function useConfirm() {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('useConfirm must be used within DialogProvider');
  return ctx.confirm;
}

export function usePrompt() {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('usePrompt must be used within DialogProvider');
  return ctx.prompt;
}
