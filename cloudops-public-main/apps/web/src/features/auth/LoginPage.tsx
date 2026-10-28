import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocation, useNavigate } from 'react-router-dom';
import { returnPath } from '../../lib/returnPath';
import { Boxes, Eye, EyeOff, Network, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react';
import { loginSchema, type LoginInput } from '@cloudops/core';
import { useAuth } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { Alert, Button, Field, IconButton, Input } from '../../components/ui/primitives';
import { LogoMark, Wordmark } from '../../components/ui/Logo';

const CAPABILITIES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Boxes, title: 'Inventory & drift', body: 'Every resource across every tenant, searchable offline.' },
  { icon: Wallet, title: 'FinOps', body: 'Cost by org, subscription, group or resource — with spike alerts.' },
  { icon: Network, title: 'Topology', body: 'Network, identity and RBAC dependencies, discovered on sync.' },
  { icon: ShieldCheck, title: 'Standards', body: 'Baselines scored continuously against the whole estate.' },
];

/** Faint schematic of a dependency graph — the product's own subject matter. */
function Schematic() {
  const nodes: [number, number][] = [
    [60, 80], [180, 40], [300, 110], [140, 190], [260, 240], [390, 60], [420, 200], [80, 300], [340, 330], [470, 300],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [0, 3], [3, 4], [2, 4], [1, 5], [5, 6], [2, 6], [3, 7], [4, 8], [6, 9], [8, 9],
  ];
  return (
    <svg viewBox="0 0 520 380" className="pointer-events-none absolute -right-40 top-[58%] w-[620px] -translate-y-1/2 opacity-25" aria-hidden>
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a]![0]}
          y1={nodes[a]![1]}
          x2={nodes[b]![0]}
          y2={nodes[b]![1]}
          className="stroke-line-strong"
          strokeWidth="1"
        />
      ))}
      {nodes.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={i % 3 === 0 ? 7 : 4.5} className={i === 2 ? 'fill-accent/30 stroke-accent' : 'fill-surface stroke-fg-faint'} strokeWidth="1.25" />
        </g>
      ))}
    </svg>
  );
}

export function LoginPage() {
  const { login, takeSignOutReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  // Read once: why the previous session ended (e.g. it expired).
  const [signOutReason] = useState(() => takeSignOutReason());
  const [reveal, setReveal] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(values: LoginInput) {
    setError(null);
    try {
      await login(values.email, values.password);
      navigate(returnPath(location.state), { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* Product panel (desktop) */}
      <aside className="relative hidden overflow-hidden border-r border-line bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Schematic />
        <Wordmark className="relative" />
        <div className="relative max-w-md">
          <div className="font-mono text-overline uppercase text-accent">Cloud operations command center</div>
          <h1 className="mt-3 text-display text-fg">One console for your whole cloud estate.</h1>
          <p className="mt-4 text-body-lg text-fg-secondary">
            Health, spend, compliance and work across every Azure tenant — served from a local cache, so it keeps
            answering even when the cloud APIs don’t.
          </p>
          <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-6">
            {CAPABILITIES.map((c) => (
              <li key={c.title} className="flex gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-sm border border-line bg-raised">
                  <c.icon className="size-4 text-accent" aria-hidden />
                </span>
                <span>
                  <span className="block text-body-sm font-medium text-fg">{c.title}</span>
                  <span className="mt-0.5 block text-caption text-fg-muted">{c.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="relative font-mono text-overline uppercase text-fg-muted">Self-hosted · Provider-agnostic</div>
      </aside>

      {/* Sign-in form */}
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <LogoMark className="mb-8 size-10 lg:hidden" />
          <h2 className="text-h1 text-fg">Sign in</h2>
          <p className="mt-1.5 text-body text-fg-secondary">Use your CloudOps account to continue.</p>
          {signOutReason === 'expired' && !error && (
            <Alert tone="info" className="mt-6" title="Your session ended">
              Sign in again to pick up where you left off.
            </Alert>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5" noValidate>
            <Field label="Email" error={errors.email?.message}>
              <Input type="email" autoComplete="username" placeholder="you@company.com" {...register('email')} />
            </Field>
            <Field label="Password" error={errors.password?.message}>
              <Input
                type={reveal ? 'text' : 'password'}
                autoComplete="current-password"
                {...register('password')}
                trailing={
                  <IconButton
                    icon={reveal ? EyeOff : Eye}
                    label={reveal ? 'Hide password' : 'Show password'}
                    size="sm"
                    tooltip={false}
                    onClick={() => setReveal((r) => !r)}
                  />
                }
              />
            </Field>

            {error && <Alert tone="danger" title="Sign-in failed">{error}</Alert>}

            <Button type="submit" className="w-full" loading={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-8 border-t border-line pt-5 text-caption text-fg-muted">
            First run? The default seeded admin is{' '}
            <span className="font-mono text-fg-secondary">admin@cloudops.local</span>
          </p>
        </div>
      </main>
    </div>
  );
}
