import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface KycFieldDefinition {
  name: string;
  type?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface KycSubmissionInfo {
  [key: string]: unknown;
}

export interface KycRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  authToken?: string;
}

function normalizeServerUrl(serverUrl: string): URL {
  const value = serverUrl.trim();
  if (!value) throw new Error("A server URL is required.");
  return /^https?:\/\//i.test(value)
    ? new URL(value.endsWith("/") ? value : `${value}/`)
    : new URL(`https://${value}`);
}

async function fetchJson<T>(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const data = (await response.json()) as T;
    if (!response.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `Request failed with status ${response.status}.`;
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getKycFields(
  serverUrl: string,
  account: string,
  options: KycRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!account?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An account identifier is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep12/fields", base.toString());
    url.searchParams.set("account", account);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "GET",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC field retrieval failed.", cause);
  }
}

export async function submitKycInfo(
  serverUrl: string,
  account: string,
  info: KycSubmissionInfo,
  options: KycRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!account?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An account identifier is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep12/customer", base.toString());
    url.searchParams.set("account", account);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
        },
        body: JSON.stringify(info),
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC submission failed.", cause);
  }
}

export async function getKycStatus(
  serverUrl: string,
  account: string,
  options: KycRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!account?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An account identifier is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep12/status", base.toString());
    url.searchParams.set("account", account);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "GET",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC status lookup failed.", cause);
  }
}


// ─── SEP-12 KYC Document Upload (#772) ─────────────────────────────────────────

/**
 * MIME types permitted for SEP-12 KYC document uploads. Restricting uploads to
 * a known-safe allowlist prevents clients from smuggling arbitrary Content-Types
 * (e.g. an executable labelled `image/png`) to the anchor server (#772).
 */
export const SEP12_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const;

/** A single KYC document to upload to an anchor. */
export interface Sep12KycFile {
  /**
   * File contents. Accepts a browser `Blob`, an `ArrayBuffer`, or a
   * `Uint8Array` (Node `Buffer` is also a `Uint8Array`).
   */
  data: Blob | ArrayBuffer | Uint8Array;
  /** Original filename (used only for diagnostics / extension hints). */
  filename: string;
  /** Caller-declared MIME type, validated against the allowlist. */
  contentType: string;
}

export interface Sep12KycCollectOptions extends KycRequestOptions {
  /** HTTP method for the upload. Defaults to `PUT`. */
  method?: "PUT" | "POST";
  /** Extra request headers (e.g. `Content-Disposition`). */
  headers?: Record<string, string>;
}

/** Normalize a Content-Type by stripping parameters and lower-casing. */
function normalizeMimeType(contentType: string): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Validate that a Content-Type is allowed for SEP-12 KYC uploads. Returns the
 * normalized MIME type on success, or an error message otherwise.
 */
export function validateSep12MimeType(
  contentType: string,
): { ok: true; mimeType: string } | { ok: false; error: string } {
  const mimeType = normalizeMimeType(contentType);
  if (!mimeType) {
    return { ok: false, error: "A Content-Type is required for KYC uploads." };
  }
  if (!(SEP12_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return {
      ok: false,
      error: `Unsupported MIME type '${mimeType}'. Allowed types: ${SEP12_ALLOWED_MIME_TYPES.join(", ")}.`,
    };
  }
  return { ok: true, mimeType };
}

/** Read up to `n` leading bytes from any supported file payload. */
async function readHeadBytes(
  data: Sep12KycFile["data"],
  n: number,
): Promise<Uint8Array> {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const buffer = await data.slice(0, n).arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data, 0, Math.min(n, data.byteLength));
  }
  return data.subarray(0, n);
}

/**
 * Verify the leading magic bytes match the declared MIME type. This catches
 * spoofed labels such as an executable uploaded as `image/png` (#772).
 */
function matchesSignature(mimeType: string, head: Uint8Array): boolean {
  const eq = (offset: number, byte: number): boolean => head[offset] === byte;
  switch (mimeType) {
    case "image/png":
      return (
        head.length >= 8 &&
        eq(0, 0x89) && eq(1, 0x50) && eq(2, 0x4e) && eq(3, 0x47) &&
        eq(4, 0x0d) && eq(5, 0x0a) && eq(6, 0x1a) && eq(7, 0x0a)
      );
    case "image/jpeg":
    case "image/jpg":
      return head.length >= 3 && eq(0, 0xff) && eq(1, 0xd8) && eq(2, 0xff);
    case "image/gif":
      return head.length >= 4 && eq(0, 0x47) && eq(1, 0x49) && eq(2, 0x46) && eq(3, 0x38);
    case "image/webp":
      return (
        head.length >= 12 &&
        eq(0, 0x52) && eq(1, 0x49) && eq(2, 0x46) && eq(3, 0x46) &&
        eq(8, 0x57) && eq(9, 0x45) && eq(10, 0x42) && eq(11, 0x50)
      );
    case "application/pdf":
      return head.length >= 4 && eq(0, 0x25) && eq(1, 0x50) && eq(2, 0x44) && eq(3, 0x46);
    default:
      return true;
  }
}

/**
 * Validate a KYC upload's MIME type AND magic-byte signature before any network
 * request. Returns the normalized MIME type on success, or an error message.
 */
export async function validateSep12Upload(
  file: Sep12KycFile,
): Promise<{ ok: true; mimeType: string } | { ok: false; error: string }> {
  const mime = validateSep12MimeType(file.contentType);
  if (!mime.ok) return mime;
  const head = await readHeadBytes(file.data, 16);
  if (!matchesSignature(mime.mimeType, head)) {
    return {
      ok: false,
      error: `File signature does not match the declared MIME type '${mime.mimeType}'.`,
    };
  }
  return { ok: true, mimeType: mime.mimeType };
}

/**
 * Upload a KYC document to an anchor-provided URL.
 *
 * The Content-Type is validated against {@link SEP12_ALLOWED_MIME_TYPES} and its
 * magic bytes are checked against the declared type before the upload leaves the
 * client, so a spoofed or dangerous file cannot be smuggled to the anchor (#772).
 *
 * @param uploadUrl - HTTPS URL provided by the anchor for the document upload.
 * @param file      - The document payload, filename, and Content-Type.
 * @param options   - Optional fetch impl, auth token, timeout, method, headers.
 * @returns `ok(body)` with the anchor's JSON response, or an `error` result.
 */
export async function sep12KycCollect(
  uploadUrl: string,
  file: Sep12KycFile,
  options: Sep12KycCollectOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  // Validate MIME type and signature before transmitting anything (#772).
  const validation = await validateSep12Upload(file);
  if (!validation.ok) {
    return err(SorokitErrorCode.VALIDATION, validation.error);
  }

  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    return err(SorokitErrorCode.VALIDATION, "A valid KYC upload URL is required.");
  }
  if (url.protocol !== "https:") {
    return err(SorokitErrorCode.VALIDATION, "KYC upload URL must use HTTPS.");
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
  }

  const method = options.method ?? "PUT";
  const headers: Record<string, string> = {
    "Content-Type": validation.mimeType,
    ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
    ...(options.headers ?? {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetcher(url, {
      method,
      headers,
      body: file.data,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        body =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { raw: text };
      } catch {
        body = { raw: text };
      }
    }
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `KYC upload failed with status ${response.status}.`;
      return err(SorokitErrorCode.NETWORK_ERROR, message);
    }
    return ok(body);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC upload failed.", cause);
  } finally {
    clearTimeout(timer);
  }
}
