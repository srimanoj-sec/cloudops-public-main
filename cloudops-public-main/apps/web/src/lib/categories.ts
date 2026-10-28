import type { TopologyCategory } from '@cloudops/core';

/** Per-service node colours (keyed to the shared TOPOLOGY_CATEGORIES), tuned for the dark canvas. */
export const CATEGORY_COLORS: Record<TopologyCategory, string> = {
  Compute: '#6ba6f7',
  Network: '#56c271',
  Storage: '#e8ae45',
  Database: '#b18cf0',
  'Web/App': '#38d4c5',
  Containers: '#ec7ab5',
  Integration: '#f28b54',
  Analytics: '#d6cf4f',
  Security: '#f06868',
  Identity: '#8c9eff',
  Management: '#8a98a3',
  'AI + ML': '#f5a3ff',
  Monitoring: '#7fc4e8',
  Other: '#5c6973',
};
