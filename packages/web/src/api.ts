import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Fetches a Kamaji API path and checks the response against its shared schema. */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError("Couldn't reach Kamaji", null);
  }
  if (response.status === 403) throw new ApiError('This login isn’t allowed in', 403);
  if (!response.ok) throw new ApiError(`Kamaji answered ${response.status}`, response.status);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success)
    throw new ApiError('Kamaji sent something this page doesn’t understand', response.status);
  return parsed.data;
}

/** Posts JSON to a Kamaji API path. Returns the parsed answer, or the server's error code. */
export async function postJson<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; status: number | null; error: string }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: null, error: 'unreachable' };
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error =
      json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
        ? (json as { error: string }).error
        : `http_${response.status}`;
    return { ok: false, status: response.status, error };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, error: 'unreadable' };
}
