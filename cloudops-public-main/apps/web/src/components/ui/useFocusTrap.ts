import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Stack of open layers (dialogs, drawers) — only the top one handles Escape / Tab. */
const layerStack: symbol[] = [];

/**
 * Traps Tab focus inside `ref` while mounted, closes on Escape (topmost layer
 * only), focuses the first field on open and restores focus on close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, onEscape: () => void, initialFocus = true) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;

  useEffect(() => {
    const id = Symbol('layer');
    layerStack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = ref.current;

    if (root && initialFocus) {
      // Explicit [data-autofocus] wins, then the first form field, then the container.
      const target =
        root.querySelector<HTMLElement>('[data-autofocus]') ??
        root.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
      (target ?? root).focus({ preventScroll: true });
    }

    function onKey(e: KeyboardEvent) {
      if (layerStack[layerStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = layerStack.indexOf(id);
      if (i >= 0) layerStack.splice(i, 1);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
    // Mount-only by design: the layer lives exactly as long as the dialog.
  }, []);
}
