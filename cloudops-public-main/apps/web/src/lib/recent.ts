import { useEffect, useState } from 'react';
import { useAuth } from './auth';

/**
 * Recently viewed objects and recent searches, per user, in localStorage
 * (keyed by user id so people sharing a browser don't see each other's trail).
 * Purely a convenience — losing it loses nothing.
 */

export interface RecentItem {
  kind: string;
  id: string;
  title: string;
  subtitle?: string | null;
  link: string;
  at: number;
}

const MAX_VISITS = 12;
const MAX_SEARCHES = 8;
const CHANGED = 'cloudops:recent-changed';

const visitsKey = (userId: string) => `cloudops.recent.${userId}`;
const searchesKey = (userId: string) => `cloudops.searches.${userId}`;

function read<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
function write(key: string, value: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* storage full or blocked — not worth surfacing */
  }
}

export function recordVisit(userId: string, item: Omit<RecentItem, 'at'>): void {
  const list = read<RecentItem>(visitsKey(userId)).filter((i) => i.link !== item.link);
  write(visitsKey(userId), [{ ...item, at: Date.now() }, ...list].slice(0, MAX_VISITS));
}

export function recordSearch(userId: string, q: string): void {
  const query = q.trim();
  if (query.length < 2) return;
  const list = read<string>(searchesKey(userId)).filter((s) => s.toLowerCase() !== query.toLowerCase());
  write(searchesKey(userId), [query, ...list].slice(0, MAX_SEARCHES));
}

export function clearRecentSearches(userId: string): void {
  write(searchesKey(userId), []);
}

/** The current user's recently viewed items and searches, kept in sync across the app. */
export function useRecent(): { visits: RecentItem[]; searches: string[] } {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const load = () => ({
    visits: userId ? read<RecentItem>(visitsKey(userId)) : [],
    searches: userId ? read<string>(searchesKey(userId)) : [],
  });
  const [state, setState] = useState(load);
  useEffect(() => {
    const refresh = () =>
      setState({
        visits: userId ? read<RecentItem>(visitsKey(userId)) : [],
        searches: userId ? read<string>(searchesKey(userId)) : [],
      });
    refresh();
    window.addEventListener(CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [userId]);
  return state;
}

/** Record a detail page view once its data has loaded. */
export function useRecordVisit(item: Omit<RecentItem, 'at'> | null): void {
  const { user } = useAuth();
  const userId = user?.id;
  const link = item?.link;
  const title = item?.title;
  const kind = item?.kind;
  const id = item?.id;
  const subtitle = item?.subtitle;
  useEffect(() => {
    if (!userId || !link || !title || !kind || !id) return;
    recordVisit(userId, { kind, id, title, subtitle, link });
  }, [userId, link, title, kind, id, subtitle]);
}
