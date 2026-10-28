import { useState } from 'react';
import { passwordSchema } from '@cloudops/core';
import { useAuth } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { Button, Field, InlineError, Input } from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';

/**
 * Self-service password change. Other sessions (other browsers/devices) are signed out.
 * `required`: the current password was set by an admin (or is the seeded default) —
 * the dialog can't be dismissed; the only other way out is signing out.
 */
export function ChangePasswordDialog({ onClose, required = false }: { onClose: () => void; required?: boolean }) {
  const { changePassword, logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirmNext.length > 0 && next !== confirmNext;
  // Same rules as the API (length, and bcrypt's 72-byte ceiling).
  const nextIssue = next.length > 0 ? passwordSchema.safeParse(next).error?.issues[0]?.message : undefined;
  const ready = Boolean(current) && next.length > 0 && !nextIssue && next === confirmNext;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await changePassword(current, next);
      toast({
        title: 'Password changed',
        description: required ? 'Your account is ready to use.' : 'Other sessions have been signed out.',
      });
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      size="sm"
      title={required ? 'Choose your own password' : 'Change password'}
      description={
        required
          ? 'Your current password was set by an administrator (or is the default). Pick a new one to continue.'
          : 'You stay signed in here; every other session is signed out.'
      }
      onClose={onClose}
      dismissible={!required}
      footer={
        <>
          {required ? (
            <Button variant="ghost" onClick={logout}>
              Sign out
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button onClick={() => void submit()} loading={busy} disabled={!ready}>
            {required ? 'Set password' : 'Change password'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <Field label={required ? 'Current (temporary) password' : 'Current password'} required>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 10 characters." error={nextIssue} required>
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords don’t match' : undefined} required>
          <Input type="password" autoComplete="new-password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
        </Field>
        {error && <InlineError>{error}</InlineError>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
