const MAX_FILE_BYTES = 600 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PART_BYTES = 50 * 1024 * 1024;
const VIDEO_PREFIX = "videos/";
const LATEST_KEY = "metadata/latest.json";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/latest") {
        return cors(await latestTransmission(env));
      }

      if (request.method === "GET" && url.pathname.startsWith("/media/")) {
        return cors(await serveVideo(request, env, url.pathname.slice("/media/".length)));
      }

      if (url.pathname.startsWith("/api/uploads/") || url.pathname === "/api/publish") {
        if (!(await isAuthorized(request, env))) return cors(json({ error: "Unauthorized" }, 401));
      }

      if (request.method === "POST" && url.pathname === "/api/uploads/create") {
        return cors(await createUpload(request, env));
      }

      if (request.method === "PUT" && url.pathname === "/api/uploads/part") {
        return cors(await uploadPart(request, env, url));
      }

      if (request.method === "POST" && url.pathname === "/api/uploads/complete") {
        return cors(await completeUpload(request, env));
      }

      if (request.method === "POST" && url.pathname === "/api/uploads/abort") {
        return cors(await abortUpload(request, env));
      }

      if (request.method === "POST" && url.pathname === "/api/publish") {
        return cors(await publishTransmission(request, env, url));
      }

      return cors(json({ error: "Not found" }, 404));
    } catch (error) {
      console.error(error);
      return cors(json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500));
    }
  },
};

async function latestTransmission(env) {
  const object = await env.KJC_BUCKET.get(LATEST_KEY);
  if (!object) return json({ transmission: null }, 404, { "cache-control": "no-store" });
  return json(await object.json(), 200, { "cache-control": "no-store" });
}

async function createUpload(request, env) {
  const body = await readJson(request);
  const fileSize = Number(body.fileSize);
  const contentType = String(body.contentType || "").toLowerCase();

  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return json({ error: "Invalid file size" }, 400);
  if (fileSize > MAX_FILE_BYTES) return json({ error: "V0 accepts videos up to 600 MB" }, 413);
  if (contentType !== "video/mp4" && contentType !== "video/quicktime") {
    return json({ error: "V0 accepts MP4 or MOV video files" }, 415);
  }

  const storedBytes = await currentVideoBytes(env.KJC_BUCKET);
  if (storedBytes + fileSize > MAX_LIBRARY_BYTES) {
    return json({ error: "The 8 GB KJC safety ceiling would be exceeded" }, 409);
  }

  const extension = contentType === "video/quicktime" ? "mov" : "mp4";
  const key = `${VIDEO_PREFIX}${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${extension}`;
  const upload = await env.KJC_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=3600",
    },
    customMetadata: {
      originalName: cleanMetadata(String(body.fileName || "video"), 160),
      expectedBytes: String(fileSize),
    },
    storageClass: "Standard",
  });

  return json({ key: upload.key, uploadId: upload.uploadId, partSize: MAX_PART_BYTES });
}

async function uploadPart(request, env, url) {
  const key = safeVideoKey(url.searchParams.get("key"));
  const uploadId = required(url.searchParams.get("uploadId"), "uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  const contentLength = Number(request.headers.get("content-length"));

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return json({ error: "Invalid part number" }, 400);
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_PART_BYTES) {
    return json({ error: "Upload part is too large" }, 413);
  }
  if (!request.body) return json({ error: "Missing upload body" }, 400);

  const upload = env.KJC_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(request, env) {
  const body = await readJson(request);
  const key = safeVideoKey(body.key);
  const uploadId = required(body.uploadId, "uploadId");
  const parts = Array.isArray(body.parts) ? body.parts : [];

  if (!parts.length) return json({ error: "No uploaded parts supplied" }, 400);
  const normalizedParts = parts
    .map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag || "") }))
    .sort((a, b) => a.partNumber - b.partNumber);

  if (normalizedParts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
    return json({ error: "Uploaded parts are incomplete" }, 400);
  }

  const upload = env.KJC_BUCKET.resumeMultipartUpload(key, uploadId);
  const object = await upload.complete(normalizedParts);

  if (object.size > MAX_FILE_BYTES) {
    await env.KJC_BUCKET.delete(key);
    return json({ error: "Completed video exceeded the 600 MB safety limit" }, 413);
  }

  const totalBytes = await currentVideoBytes(env.KJC_BUCKET);
  if (totalBytes > MAX_LIBRARY_BYTES) {
    await env.KJC_BUCKET.delete(key);
    return json({ error: "Completed upload exceeded the 8 GB KJC safety ceiling" }, 409);
  }

  return json({ key: object.key, size: object.size });
}

async function abortUpload(request, env) {
  const body = await readJson(request);
  const upload = env.KJC_BUCKET.resumeMultipartUpload(
    safeVideoKey(body.key),
    required(body.uploadId, "uploadId"),
  );
  await upload.abort();
  return json({ aborted: true });
}

async function publishTransmission(request, env, url) {
  const body = await readJson(request);
  const key = safeVideoKey(body.key);
  const video = await env.KJC_BUCKET.head(key);
  if (!video) return json({ error: "Uploaded video was not found" }, 404);

  const number = String(body.number || "").padStart(3, "0");
  const location = cleanMetadata(String(body.location || ""), 100);
  const date = String(body.date || "");
  const note = cleanMetadata(String(body.note || ""), 280);

  if (!/^\d{3}$/.test(number)) return json({ error: "Transmission number must contain up to three digits" }, 400);
  if (!location) return json({ error: "Location is required" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Date must use YYYY-MM-DD" }, 400);

  const record = {
    number,
    location,
    date,
    note,
    key,
    videoUrl: `${url.origin}/media/${encodeURIComponent(key)}`,
    size: video.size,
    publishedAt: new Date().toISOString(),
  };

  await env.KJC_BUCKET.put(`metadata/transmission-${number}.json`, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    storageClass: "Standard",
  });
  await env.KJC_BUCKET.put(LATEST_KEY, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    storageClass: "Standard",
  });

  return json(record, 201);
}

async function serveVideo(request, env, encodedKey) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response("Bad video key", { status: 400 });
  }
  safeVideoKey(key);

  const object = await env.KJC_BUCKET.get(key, { range: request.headers });
  if (!object) return new Response("Video not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");

  if (object.range) {
    const offset = object.range.offset ?? Math.max(0, object.size - (object.range.suffix || 0));
    const length = object.range.length ?? Math.min(object.range.suffix || object.size, object.size);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

async function currentVideoBytes(bucket) {
  let total = 0;
  let cursor;
  do {
    const page = await bucket.list({ prefix: VIDEO_PREFIX, cursor });
    total += page.objects.reduce((sum, object) => sum + object.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

async function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const [left, right] = await Promise.all([digest(supplied), digest(env.ADMIN_TOKEN)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function safeVideoKey(value) {
  const key = required(value, "key");
  if (!/^videos\/[a-zA-Z0-9._-]+\.(mp4|mov)$/.test(key)) throw new Error("Invalid video key");
  return key;
}

function required(value, name) {
  const text = String(value || "");
  if (!text) throw new Error(`Missing ${name}`);
  return text;
}

function cleanMetadata(value, limit) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
