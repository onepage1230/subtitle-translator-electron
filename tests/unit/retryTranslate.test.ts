import { describe, it, expect, vi, afterEach } from "vitest";
import { retryTranslate } from "../../electron/main/utils/pipeline";

afterEach(() => {
  vi.useRealTimers();
});

describe("retryTranslate", () => {
  it("retries retryable errors with exponential backoff", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValue("ok");
    const promise = retryTranslate(fn, "input", 5, 1000);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("invalid api key"));
    await expect(retryTranslate(fn, "input", 5, 1)).rejects.toThrow("invalid api key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting maxRetries", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));
    const promise = retryTranslate(fn, "input", 3, 1000);
    const assertion = expect(promise).rejects.toThrow("timeout");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on retryable HTTP status", async () => {
    vi.useFakeTimers();
    const err: any = new Error("server exploded");
    err.status = 500;
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const promise = retryTranslate(fn, "input", 5, 1000);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
