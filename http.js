import { parse } from "lossless-json";
import { setTimeout as delay } from "node:timers/promises";
import { integerSetting } from "./security.js";

export async function requestJson(url, options = {}, fetcher = fetch) {
  const safeRead = (options.method || "GET") === "GET";
  const attempts = safeRead ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url, {
        ...options, redirect: "error",
        signal: AbortSignal.timeout(integerSetting("HTTP_TIMEOUT_MS", 20000, 100, 60000)),
      });
      if (safeRead && [429, 502, 503, 504].includes(response.status) && attempt < attempts - 1) {
        const retry = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await delay(Math.min(3000, Math.max(250, Number.isFinite(retry) ? retry * 1000 : 250 * 2 ** attempt)));
        continue;
      }
      // Parse decimal tokens as strings, avoiding binary floating-point loss at ingestion.
      const limit = integerSetting("MAX_API_BYTES", 8000000, 1024, 32000000);
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error("API response exceeds size limit");
        chunks.push(chunk);
      }
      let data;
      try { data = parse(Buffer.concat(chunks).toString("utf8"), undefined, value => value); }
      catch { throw new Error("Zoho returned invalid JSON"); }
      return { status: response.status, httpOk: response.ok, data };
    } catch (error) {
      if (safeRead && attempt < attempts - 1 && ["TypeError", "TimeoutError"].includes(error.name)) {
        await delay(250 * 2 ** attempt); continue;
      }
      throw new Error("Zoho request failed or timed out; no result was verified", { cause: error });
    }
  }
}
export function booksSuccess(response) {
  return response.httpOk && response.data && !Array.isArray(response.data) &&
    typeof response.data === "object" && String(response.data.code) === "0";
}
