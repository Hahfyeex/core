import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { isOk, isErr } from "../shared/response";

// #782 — SEP-7 link parameter validation
import { validateSep7Uri, buildFromSep7Uri } from "../integration/sep7Handler";

// #764 — automatic TOML cache expiration
import {
  cacheStellarToml,
  getCachedStellarToml,
  clearStellarTomlCache,
  sweepStellarTomlCache,
  getStellarTomlCacheSize,
} from "../integration/sep1Toml";

// #772 — SEP-12 KYC MIME type validation
import {
  sep12KycCollect,
  validateSep12MimeType,
  validateSep12Upload,
} from "../integration/sep12Kyc";

// #765 — deduplication key scoping by operation context
import {
  deduplicateRequest,
  buildDedupKey,
  clearInflightRequests,
  getInflightRequestCount,
} from "../utility/rateLimiter";

// ─── #782 ─────────────────────────────────────────────────────────────────────

describe("#782 — SEP-7 link parameter validation in build path", () => {
  const validDestination = Keypair.random().publicKey();
  const sourceAccount = Keypair.random().publicKey();
  const buildOpts = {
    sourceAccount,
    sequenceNumber: "100",
    networkPassphrase: Networks.TESTNET,
  };

  it("rejects a negative amount instead of silently building it", async () => {
    const uri = `web+stellar:pay?destination=${validDestination}&amount=-5`;
    const result = await buildFromSep7Uri(uri, buildOpts);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Invalid amount");
    }
  });

  it("rejects an amount with too many decimal places", async () => {
    const uri = `web+stellar:pay?destination=${validDestination}&amount=1.12345678`;
    const result = await buildFromSep7Uri(uri, buildOpts);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toContain("decimal places");
  });

  it("rejects a memo text exceeding the 28-byte limit", async () => {
    const longMemo = "A".repeat(29);
    const uri = `web+stellar:pay?destination=${validDestination}&amount=10&memo=${encodeURIComponent(longMemo)}&memo_type=text`;
    const result = await buildFromSep7Uri(uri, buildOpts);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toContain("28-byte");
  });

  it("rejects an invalid destination address", async () => {
    const uri = `web+stellar:pay?destination=not_a_key&amount=10`;
    const result = await buildFromSep7Uri(uri, buildOpts);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toContain("Invalid destination");
  });

  it("rejects a non-numeric memo id", async () => {
    const uri = `web+stellar:pay?destination=${validDestination}&amount=10&memo=abc&memo_type=id`;
    const result = await buildFromSep7Uri(uri, buildOpts);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toContain("Memo ID");
  });

  it("still builds a valid pay URI with in-bounds parameters", async () => {
    const uri = `web+stellar:pay?destination=${validDestination}&amount=15.75&memo=Invoice42&memo_type=text`;
    const result = await buildFromSep7Uri(uri, buildOpts);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const tx = result.data as unknown as { operations: Array<{ amount: string }>; memo: { value: string } };
      expect(tx.operations[0].amount).toBe("15.7500000");
      expect(tx.memo.value).toBe("Invoice42");
    }
  });

  it("validateSep7Uri reports decimal-places and memo-length errors", () => {
    const longMemo = "X".repeat(30);
    const uri = `web+stellar:pay?destination=${validDestination}&amount=1.12345678&memo=${encodeURIComponent(longMemo)}&memo_type=text`;
    const result = validateSep7Uri(uri);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.valid).toBe(false);
      expect(result.data.errors.some((e) => e.includes("decimal places"))).toBe(true);
      expect(result.data.errors.some((e) => e.includes("28-byte"))).toBe(true);
    }
  });
});

// ─── #764 ─────────────────────────────────────────────────────────────────────

describe("#764 — automatic TOML cache expiration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStellarTomlCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweepStellarTomlCache removes expired entries and keeps fresh ones", () => {
    const start = 1_000_000;
    vi.setSystemTime(start);
    cacheStellarToml("https://expired.example", { FEDERATION_SERVER: "https://fed.expired" }, 1_000);
    cacheStellarToml("https://fresh.example", { FEDERATION_SERVER: "https://fed.fresh" }, 60_000);
    expect(getStellarTomlCacheSize()).toBe(2);

    vi.setSystemTime(start + 2_000); // expired.example TTL elapsed, fresh.example still valid
    const removed = sweepStellarTomlCache();
    expect(removed).toBe(1);
    expect(getStellarTomlCacheSize()).toBe(1);
    expect(getCachedStellarToml("https://fresh.example")?.FEDERATION_SERVER).toBe("https://fed.fresh");
    expect(getCachedStellarToml("https://expired.example")).toBeUndefined();
  });

  it("accessing a fresh entry proactively evicts an expired entry from another domain", () => {
    const start = 2_000_000;
    vi.setSystemTime(start);
    cacheStellarToml("https://stale.example", { AUTH_SERVER: "https://auth.stale" }, 500);
    cacheStellarToml("https://live.example", { AUTH_SERVER: "https://auth.live" }, 120_000);
    expect(getStellarTomlCacheSize()).toBe(2);

    // Advance past both the stale TTL and the sweep throttle window.
    vi.setSystemTime(start + 61_000);
    const live = getCachedStellarToml("https://live.example");
    expect(live?.AUTH_SERVER).toBe("https://auth.live");
    // The stale entry was evicted by the automatic sweep, not just lazily on access.
    expect(getStellarTomlCacheSize()).toBe(1);
  });

  it("fresh entries are not evicted by a sweep", () => {
    vi.setSystemTime(3_000_000);
    cacheStellarToml("https://ok.example", { TRANSFER_SERVER: "https://ts.ok" }, 30_000);
    expect(sweepStellarTomlCache()).toBe(0);
    expect(getStellarTomlCacheSize()).toBe(1);
  });
});

// ─── #772 ─────────────────────────────────────────────────────────────────────

describe("#772 — SEP-12 KYC MIME type validation", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

  it("validateSep12MimeType accepts allowlisted types and rejects others", () => {
    expect(validateSep12MimeType("image/png").ok).toBe(true);
    expect(validateSep12MimeType("application/pdf").ok).toBe(true);
    expect(validateSep12MimeType("image/jpeg").ok).toBe(true);
    expect(validateSep12MimeType("application/octet-stream").ok).toBe(false);
    expect(validateSep12MimeType("application/x-msdownload").ok).toBe(false);
    expect(validateSep12MimeType("").ok).toBe(false);
  });

  it("normalize Content-Type (strips parameters, lowercases)", () => {
    const result = validateSep12MimeType("IMAGE/PNG; charset=utf-8");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).toBe("image/png");
  });

  it("rejects a file whose bytes don't match the declared type (e.g. exe as png)", async () => {
    const result = await validateSep12Upload({
      data: exeBytes,
      filename: "id.png",
      contentType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("signature");
  });

  it("accepts a file whose bytes match the declared type", async () => {
    const result = await validateSep12Upload({
      data: pngBytes,
      filename: "id.png",
      contentType: "image/png",
    });
    expect(result.ok).toBe(true);
  });

  it("sep12KycCollect rejects an unsupported MIME type without calling fetch", async () => {
    const fetcher = vi.fn();
    const result = await sep12KycCollect(
      "https://anchor.example/upload",
      { data: pngBytes, filename: "id.png", contentType: "application/octet-stream" },
      { fetch: fetcher as unknown as typeof fetch },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sep12KycCollect rejects a spoofed signature without calling fetch", async () => {
    const fetcher = vi.fn();
    const result = await sep12KycCollect(
      "https://anchor.example/upload",
      { data: exeBytes, filename: "id.png", contentType: "image/png" },
      { fetch: fetcher as unknown as typeof fetch },
    );
    expect(isErr(result)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uploads a valid file and returns the anchor response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await sep12KycCollect(
      "https://anchor.example/upload",
      { data: pngBytes, filename: "id.png", contentType: "image/png" },
      { fetch: fetcher as unknown as typeof fetch },
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.data).toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "Content-Type": "image/png" });
  });

  it("rejects a non-HTTPS upload URL", async () => {
    const result = await sep12KycCollect(
      "http://anchor.example/upload",
      { data: pngBytes, filename: "id.png", contentType: "image/png" },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION");
  });
});

// ─── #765 ─────────────────────────────────────────────────────────────────────

describe("#765 — deduplication key scoping by operation context", () => {
  beforeEach(() => {
    clearInflightRequests();
  });

  it("buildDedupKey incorporates provider, endpoint, account, and tag", () => {
    expect(buildDedupKey("getAccount")).toBe("getAccount");
    expect(buildDedupKey("getAccount", { provider: "mainnet" })).toBe("getAccount|provider:mainnet");
    expect(
      buildDedupKey("getAccount", {
        provider: "mainnet",
        endpoint: "https://horizon.example",
        account: "GABC",
      }),
    ).toBe("getAccount|provider:mainnet|endpoint:https://horizon.example|account:GABC");
    expect(buildDedupKey("getAccount", { tag: "v2" })).toBe("getAccount|tag:v2");
  });

  it("calls scoped to different endpoints do not share a cached promise", async () => {
    const operation = vi.fn(async (endpoint: string) => ({ endpoint }));
    const [a, b] = await Promise.all([
      deduplicateRequest("getAccount", () => operation("endpointA"), { endpoint: "endpointA" }),
      deduplicateRequest("getAccount", () => operation("endpointB"), { endpoint: "endpointB" }),
    ]);
    expect(isOk(a)).toBe(true);
    expect(isOk(b)).toBe(true);
    if (isOk(a) && isOk(b)) {
      expect(a.data).toEqual({ endpoint: "endpointA" });
      expect(b.data).toEqual({ endpoint: "endpointB" });
    }
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("calls with the same scope share a cached promise (dedup still works)", async () => {
    const operation = vi.fn(async () => "shared");
    const [a, b] = await Promise.all([
      deduplicateRequest("getAccount", () => operation(), { endpoint: "endpointA" }),
      deduplicateRequest("getAccount", () => operation(), { endpoint: "endpointA" }),
    ]);
    expect(a).toEqual(b);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("omitting scope preserves the original key-only behaviour", async () => {
    const operation = vi.fn(async () => "value");
    const [a, b] = await Promise.all([
      deduplicateRequest("account:GABC", () => operation()),
      deduplicateRequest("account:GABC", () => operation()),
    ]);
    expect(a).toEqual(b);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("getInflightRequestCount tracks in-flight requests", async () => {
    let resolveOp: (v: string) => void = () => {};
    const pending = deduplicateRequest("inflight-test", () => new Promise<string>((r) => {
      resolveOp = r;
    }));
    expect(getInflightRequestCount()).toBe(1);
    resolveOp("done");
    await pending;
    expect(getInflightRequestCount()).toBe(0);
  });
});
