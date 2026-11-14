import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiError, getJson } from './api';

export type Resource<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string; retry: () => void }
  | {
      state: 'ready';
      data: T;
      loadedAt: number;
      /** A refresh failed: the data shown is the last good copy and must say so. */
      refreshError: string | null;
      reload: () => void;
    };

/**
 * Loads an API path and keeps it fresh: on an interval if `pollMs` is set, and whenever the window
 * regains focus. `pollMs` can depend on what was last loaded (quick only while a run is going, for
 * instance). A failed refresh keeps the last good data and reports the failure beside it.
 */
export function useResource<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { pollMs?: number | ((last: z.infer<S> | null) => number) } = {},
): Resource<z.infer<S>> {
  type T = z.infer<S>;
  const [data, setData] = useState<{ value: T; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const schemaRef = useRef(schema);
  const pollMs =
    typeof options.pollMs === 'function' ? options.pollMs(data?.value ?? null) : options.pollMs;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    getJson(path, schemaRef.current, controller.signal).then(
      (value: T) => {
        setData({ value, at: Date.now() });
        setError(null);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      },
    );
    return () => controller.abort();
  }, [path, nonce]);

  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    const timer = pollMs ? window.setInterval(reload, pollMs) : undefined;
    return () => {
      window.removeEventListener('focus', onFocus);
      if (timer) window.clearInterval(timer);
    };
  }, [reload, pollMs]);

  if (data)
    return { state: 'ready', data: data.value, loadedAt: data.at, refreshError: error, reload };
  if (error) return { state: 'error', message: error, retry: reload };
  return { state: 'loading' };
}
