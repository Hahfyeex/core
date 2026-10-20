import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface RateLimiterOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  /**
   * Maximum number of requests waiting to start. Requests beyond this limit
   * fail with `RATE_LIMITED`; active operations are not counted. Omitted means
   * the queue remains unbounded for backwards compatibility.
   */
  maxQueueSize?: number;
}

export interface RateLimiter {
  execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>>;
  readonly pending: number;
}

const inFlightRequests = new Map<string, Promise<SorokitResult<unknown>>>();

/**
 * Structured scoping context for {@link deduplicateRequest}. Incorporating the
 * endpoint, account, and RPC provider into the deduplication key prevents two
 * calls that target different contexts from sharing a cached promise — e.g. a
 * request to endpoint A silently returning endpoint B's response (#765).
 */
export interface DeduplicationScope {
  /** RPC endpoint / Horizon URL the request targets. */
  endpoint?: string;
  /** Account public key the request is scoped to. */
  account?: string;
  /** RPC provider or network identifier (e.g. "mainnet", "testnet"). */
  provider?: string;
  /** Additional caller-supplied scoping discriminator. */
  tag?: string;
}

/**
 * Build a deduplication key fully scoped by operation context. Prefer this over
 * a hand-written key so the endpoint/account/provider are part of the cache key
 * and cross-context collisions cannot occur (#765).
 *
 * @example
 * const key = buildDedupKey("getAccount", {
 *   provider: "mainnet",
 *   endpoint: horizonUrl,
 *   account: publicKey,
 * });
 */
export function buildDedupKey(operation: string, scope: DeduplicationScope = {}): string {
  const parts: string[] = [operation];
  if (scope.provider) parts.push(`provider:${scope.provider}`);
  if (scope.endpoint) parts.push(`endpoint:${scope.endpoint}`);
  if (scope.account) parts.push(`account:${scope.account}`);
  if (scope.tag) parts.push(`tag:${scope.tag}`);
  return parts.join("|");
}

/**
 * Number of in-flight deduplicated requests currently tracked by
 * {@link deduplicateRequest}. Useful for diagnostics and test isolation.
 */
export function getInflightRequestCount(): number {
  return inFlightRequests.size;
}

/**
 * Clear all in-flight deduplicated requests. Useful for test isolation when a
 * promise is deliberately left pending.
 */
export function clearInflightRequests(): void {
  inFlightRequests.clear();
}

/**
 * Deduplicate concurrent requests that share a key.
 *
 * When `scope` is provided the key is combined with the endpoint/account/provider
 * context via {@link buildDedupKey}, so calls that differ only by RPC endpoint
 * or account no longer collide on the same cached promise (#765). Omitting
 * `scope` preserves the original key-only behaviour for backwards compatibility.
 */
export function deduplicateRequest<T>(
  key: string,
  operation: () => Promise<T>,
  scope?: DeduplicationScope,
): Promise<SorokitResult<T>> {
  const dedupKey = scope ? buildDedupKey(key, scope) : key;
  const existing = inFlightRequests.get(dedupKey);
  if (existing) return existing as Promise<SorokitResult<T>>;

  const pending = Promise.resolve()
    .then(operation)
    .then(ok)
    .catch((cause: unknown) =>
      err<T>(
        SorokitErrorCode.NETWORK_ERROR,
        cause instanceof Error ? cause.message : "Request failed",
        cause,
      ),
    )
    .finally(() => inFlightRequests.delete(dedupKey));
  inFlightRequests.set(dedupKey, pending);
  return pending;
}

export function createRateLimiter(
  limit: number,
  windowMs: number,
  options: RateLimiterOptions = {},
): RateLimiter {
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError("limit and windowMs must be positive numbers");
  }
  if (options.maxQueueSize !== undefined &&
    (!Number.isInteger(options.maxQueueSize) || options.maxQueueSize < 0)) {
    throw new RangeError("maxQueueSize must be a non-negative integer");
  }

  const queue: Array<() => void> = [];
  const starts: number[] = [];
  const maxRetries = options.maxRetries ?? 2;
  const initialBackoffMs = options.initialBackoffMs ?? 100;
  const maxQueueSize = options.maxQueueSize;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    while (starts.length > 0 && now - starts[0]! >= windowMs) starts.shift();
    while (queue.length > 0 && starts.length < limit) {
      starts.push(Date.now());
      queue.shift()!();
    }
    if (queue.length > 0 && starts.length > 0) {
      timer = setTimeout(drain, Math.max(1, windowMs - (Date.now() - starts[0]!)));
    }
  };

  const acquire = (): Promise<void> => {
    drain();
    if (
      maxQueueSize !== undefined &&
      queue.length >= maxQueueSize &&
      starts.length >= limit
    ) {
      return Promise.reject(new Error("Rate limiter queue is full."));
    }
    return new Promise((resolve) => {
      queue.push(resolve);
      drain();
    });
  };

  return {
    get pending() { return queue.length; },
    async execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>> {
      try {
        await acquire();
      } catch (cause) {
        return err(
          SorokitErrorCode.RATE_LIMITED,
          "Rate limiter queue is full.",
          cause,
        );
      }
      let lastCause: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return ok(await operation());
        } catch (cause) {
          lastCause = cause;
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, initialBackoffMs * 2 ** attempt));
          }
        }
      }
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        lastCause instanceof Error ? lastCause.message : "Rate-limited request failed",
        lastCause,
      );
    },
  };
}
