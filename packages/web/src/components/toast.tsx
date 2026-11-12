// Toasts, for actions whose result the page wouldn't otherwise show: a save that changes nothing
// on screen, a check that only moves a time. Anything that needs fixing stays on the page too.
import { Toaster, toast } from 'sonner';

/** postJson's error codes, in words. */
const REASONS: Record<string, string> = {
  unreachable: 'Kamaji couldn’t be reached',
  not_found: 'Kamaji no longer has this site',
  bad_request: 'Kamaji didn’t accept what was sent',
  unreadable: 'Kamaji’s answer didn’t make sense to this page',
  not_set_up: 'This Kamaji has no Craftish Care keys',
};

export const reason = (error: string) => REASONS[error] ?? `Kamaji answered ${error}`;

export const saved = (message: string) => toast.success(message);
export const failed = (message: string) => toast.error(message);

/** Mounted once, in the shell. Its colours are the theme's, so it follows light and dark. */
export function Toasts() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: 'var(--panel)',
          color: 'var(--ink)',
          border: '1px solid var(--line)',
          borderRadius: 3,
          fontSize: 12,
        },
      }}
    />
  );
}
