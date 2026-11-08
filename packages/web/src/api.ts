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
