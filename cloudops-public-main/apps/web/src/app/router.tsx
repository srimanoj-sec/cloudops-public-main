import { Suspense, lazy, type ComponentType } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  createBrowserRouter,
  useLocation,
  useRouteError,
} from 'react-router-dom';
import { RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Layout } from './Layout';
import { Button, EmptyState, LoadingBlock, Spinner } from '../components/ui/primitives';
import { LogoMark } from '../components/ui/Logo';
import { LoginPage } from '../features/auth/LoginPage';
import { returnPath } from '../lib/returnPath';

/**
 * Route-level code splitting: each screen is its own chunk, so the first paint
 * only downloads the shell (ECharts & friends load with the pages that use them).
 */
function page(load: () => Promise<Record<string, unknown>>, name: string) {
  const Component = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  return (
    <Suspense fallback={<LoadingBlock label="Loading…" className="min-h-[40vh]" />}>
      <Component />
    </Suspense>
  );
}

function BootScreen() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4">
        <LogoMark className="size-10" />
        <Spinner label="Loading CloudOps…" />
      </div>
    </div>
  );
}

/** Signed in, but the API can't be reached to confirm it — don't sign out, offer a retry. */
function UnreachableScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <EmptyState
        icon={WifiOff}
        title="Can’t reach CloudOps right now"
        description={`${message} You’re still signed in — try again in a moment.`}
        action={
          <Button icon={RefreshCw} onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}

function ProtectedShell() {
  const { user, loading, bootError, retryBootstrap } = useAuth();
  const location = useLocation();
  if (loading) return <BootScreen />;
  if (bootError) return <UnreachableScreen message={bootError} onRetry={retryBootstrap} />;
  // Remember where the user was headed (a shared link, or the page their session expired on).
  if (!user)
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  return <Layout />;
}

function PublicOnly() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (user) return <Navigate to={returnPath(location.state)} replace />;
  return <Outlet />;
}

/** A chunk that fails to load after a deploy (stale tab) — a reload fixes it. */
function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Loading chunk|Importing a module script failed/i.test(
      error.message,
    )
  );
}

/** Render errors inside a page — shown within the shell so navigation still works. */
function RouteError() {
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  return (
    <EmptyState
      icon={TriangleAlert}
      title={stale ? 'A newer version is available' : 'This page hit a problem'}
      description={
        stale
          ? 'CloudOps was updated since this tab was opened. Reload to continue.'
          : 'Something went wrong while showing this page. Reloading usually fixes it; if not, the details are in the browser console.'
      }
      action={
        <>
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
          <Link to="/" className="link text-body-sm">
            Go to dashboard
          </Link>
        </>
      }
    />
  );
}

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  {
    element: <PublicOnly />,
    children: [{ path: '/login', element: <LoginPage /> }],
  },
  {
    element: <ProtectedShell />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          {
            path: '/',
            element: page(() => import('../features/dashboard/DashboardPage'), 'DashboardPage'),
          },
          {
            path: '/organizations',
            element: page(
              () => import('../features/organizations/OrganizationsPage'),
              'OrganizationsPage',
            ),
          },
          {
            path: '/resource-groups',
            element: page(
              () => import('../features/resourceGroups/ResourceGroupsPage'),
              'ResourceGroupsPage',
            ),
          },
          {
            path: '/inventory',
            element: page(() => import('../features/inventory/InventoryPage'), 'InventoryPage'),
          },
          {
            path: '/inventory/:id',
            element: page(
              () => import('../features/inventory/ResourceDetailPage'),
              'ResourceDetailPage',
            ),
          },
          {
            path: '/topology',
            element: page(() => import('../features/topology/TopologyPage'), 'TopologyPage'),
          },
          {
            path: '/finops',
            element: page(() => import('../features/finops/FinopsPage'), 'FinopsPage'),
          },
          { path: '/work', element: page(() => import('../features/work/WorkPage'), 'WorkPage') },
          {
            path: '/work/:id',
            element: page(() => import('../features/work/WorkItemPage'), 'WorkItemPage'),
          },
          {
            path: '/notifications',
            element: page(
              () => import('../features/notifications/NotificationsPage'),
              'NotificationsPage',
            ),
          },
          {
            path: '/workspaces',
            element: page(() => import('../features/workspaces/WorkspacesPage'), 'WorkspacesPage'),
          },
          {
            path: '/standards',
            element: page(() => import('../features/standards/StandardsPage'), 'StandardsPage'),
          },
          {
            path: '/remediation',
            element: page(
              () => import('../features/remediation/RemediationPage'),
              'RemediationPage',
            ),
          },
          {
            path: '/remediation/new',
            element: page(
              () => import('../features/remediation/RemediationNewPage'),
              'RemediationNewPage',
            ),
          },
          {
            path: '/remediation/:id',
            element: page(
              () => import('../features/remediation/RemediationRunPage'),
              'RemediationRunPage',
            ),
          },
          {
            path: '/operations/syncs',
            element: page(() => import('../features/operations/SyncCenterPage'), 'SyncCenterPage'),
          },
          {
            path: '/operations/drift',
            element: page(() => import('../features/operations/DriftPage'), 'DriftPage'),
          },
          {
            path: '/insights',
            element: page(() => import('../features/operations/CloudInsightsPage'), 'CloudInsightsPage'),
          },
          {
            path: '/automation',
            element: page(() => import('../features/automation/AutomationPage'), 'AutomationPage'),
          },
          {
            path: '/providers',
            element: page(() => import('../features/providers/ProvidersPage'), 'ProvidersPage'),
          },
          {
            path: '/settings/users',
            element: page(() => import('../features/admin/UsersPage'), 'UsersPage'),
          },
          {
            path: '/settings/audit',
            element: page(() => import('../features/admin/AuditPage'), 'AuditPage'),
          },
          {
            path: '/settings/system',
            element: page(() => import('../features/admin/SystemPage'), 'SystemPage'),
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
