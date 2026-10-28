import type { Tone } from '../../components/ui/primitives';

/** Visual tone for a resource lifecycle stage (see LIFECYCLE_STAGES in core). */
export function lifecycleTone(stage: string | null | undefined): Tone {
  switch (stage) {
    case 'Deprecated':
      return 'warning';
    case 'Retired':
    case 'Deleted':
      return 'danger';
    default:
      return 'neutral';
  }
}
