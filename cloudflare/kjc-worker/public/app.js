const form = document.getElementById("upload-form");
const button = document.getElementById("upload-button");
const progress = document.getElementById("progress");
const status = document.getElementById("status");
const dateInput = document.getElementById("date");

const localNow = new Date();
localNow.setMinutes(localNow.getMinutes() - localNow.getTimezoneOffset());
dateInput.value = localNow.toISOString().slice(0, 10);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const file = data.get("video");
  const token = String(data.get("token") || "");
  const api = window.location.origin;

  if (!(file instanceof File) || !file.size) return setStatus("Choose a video first.", "error");

  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  setStatus("Preparing upload…");

  let upload;
  try {
    upload = await apiJson(`${api}/api/uploads/create`, token, {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type || "video/mp4" }),
    });

    const parts = [];
    const partCount = Math.ceil(file.size / upload.partSize);

    for (let index = 0; index < partCount; index += 1) {
      const start = index * upload.partSize;
      const end = Math.min(start + upload.partSize, file.size);
      setStatus(`Sending part ${index + 1} of ${partCount}… Keep this page open.`);

      const part = await apiJson(
        `${api}/api/uploads/part?key=${encodeURIComponent(upload.key)}&uploadId=${encodeURIComponent(upload.uploadId)}&partNumber=${index + 1}`,
        token,
        { method: "PUT", body: file.slice(start, end) },
      );
      parts.push(part);
      progress.value = Math.round(((index + 1) / partCount) * 90);
    }

    setStatus("Assembling the transmission…");
    await apiJson(`${api}/api/uploads/complete`, token, {
      method: "POST",
      body: JSON.stringify({ key: upload.key, uploadId: upload.uploadId, parts }),
    });

    setStatus("Publishing…");
    const published = await apiJson(`${api}/api/publish`, token, {
      method: "POST",
      body: JSON.stringify({
        key: upload.key,
        number: String(data.get("number") || ""),
        location: String(data.get("location") || ""),
        date: String(data.get("date") || ""),
        note: String(data.get("note") || ""),
      }),
    });

    progress.value = 100;
    setStatus(`Transmission ${published.number} is live.`, "success");
    document.getElementById("video").value = "";
  } catch (error) {
    if (upload) {
      apiJson(`${api}/api/uploads/abort`, token, {
        method: "POST",
        body: JSON.stringify({ key: upload.key, uploadId: upload.uploadId }),
      }).catch(() => {});
    }
    setStatus(error instanceof Error ? error.message : "Upload failed.", "error");
  } finally {
    button.disabled = false;
  }
});

async function apiJson(url, token, options) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  if (typeof options.body === "string") headers.set("content-type", "application/json");

  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function setStatus(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}
