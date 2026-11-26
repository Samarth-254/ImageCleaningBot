import sharp from 'sharp';
import { config } from '../config.js';

const kieExhaustedUntilByKey = new Map();

export function resetKieCircuitBreaker() {
  kieExhaustedUntilByKey.clear();
}

export function isKieCreditOrQuotaError(err) {
  const status = Number(err?.status || err?.code || 0);
  if (status === 401 || status === 402 || status === 429) return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('credit') ||
    msg.includes('balance') ||
    msg.includes('insufficient') ||
    msg.includes('quota') ||
    msg.includes('402') ||
    msg.includes('429')
  );
}

/**
 * Swappable image editing adapter.
 * Signature: editImage({ imageBuffer, instruction }) -> { imageBuffer, latencyMs, meta }
 */
export async function editImage({ imageBuffer, instruction }) {
  const provider = config.editProvider;
  if (provider === 'mock') {
    return editImageMock({ imageBuffer, instruction });
  }
  if (provider === 'kie') {
    const keys = config.kieApiKeys?.length ? config.kieApiKeys : config.kieApiKey ? [config.kieApiKey] : [];
    const now = Date.now();
    let lastErr = null;

    for (let idx = 0; idx < keys.length; idx += 1) {
      const apiKey = keys[idx];
      const until = kieExhaustedUntilByKey.get(apiKey) || 0;
      if (now < until) continue;

      try {
        const res = await editImageKie({ imageBuffer, instruction, apiKey });
        console.log(`[Editor] provider=kie key=#${idx + 1} model=${res.meta?.model} latencyMs=${res.latencyMs}`);
        return {
          ...res,
          meta: { ...res.meta, keyIndex: idx + 1 },
        };
      } catch (err) {
        lastErr = err;
        if (isKieCreditOrQuotaError(err)) {
          kieExhaustedUntilByKey.set(apiKey, Date.now() + 10 * 60 * 1000);
          console.warn(`[Editor] Kie.ai key #${idx + 1} credit/quota issue; trying next key/fallback:`, err.message);
          continue;
        }
        throw err;
      }
    }

    if (config.editFallbackProvider) {
      const fb = await runProvider(config.editFallbackProvider, { imageBuffer, instruction });
      return {
        ...fb,
        meta: {
          ...fb.meta,
          fallbackFrom: 'kie',
          fallbackReason: lastErr ? lastErr.message : 'all_kie_keys_exhausted',
        },
      };
    }
    throw lastErr || new Error('All Kie.ai API keys are exhausted or missing');
  }
  return runProvider(provider, { imageBuffer, instruction });
}

async function runProvider(provider, { imageBuffer, instruction }) {
  if (provider === 'mock') {
    return editImageMock({ imageBuffer, instruction });
  }
  if (provider === 'magichour' || (provider === 'qwen_http' && config.editApiUrl.includes('magichour.ai'))) {
    return editImageMagicHour({ imageBuffer, instruction });
  }
  if (provider === 'qwen_http') {
    return editImageQwenHttp({ imageBuffer, instruction });
  }
  throw new Error(`Unsupported EDIT_PROVIDER: ${provider}`);
}

async function editImageMock({ imageBuffer, instruction }) {
  const startedAt = Date.now();
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width || 800;
  const height = meta.height || 600;
  const badgeW = Math.min(220, Math.max(120, Math.round(width * 0.25)));
  const badgeH = Math.min(64, Math.max(36, Math.round(height * 0.08)));
  const fontSize = Math.round(badgeH * 0.55);

  const svgOverlay = Buffer.from(
    `<svg width="${badgeW}" height="${badgeH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${badgeW}" height="${badgeH}" rx="10" fill="rgba(7, 94, 84, 0.88)" stroke="#25D366" stroke-width="3"/>
      <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-weight="bold" font-size="${fontSize}">MOCK</text>
    </svg>`
  );

  const outputBuffer = await sharp(imageBuffer)
    .rotate()
    .composite([{ input: svgOverlay, top: 16, left: 16 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    imageBuffer: outputBuffer,
    latencyMs: Date.now() - startedAt,
    meta: {
      provider: 'mock',
      model: 'mock-sharp-overlay',
      instructionLength: instruction?.length || 0,
    },
  };
}

async function editImageKie({ imageBuffer, instruction, apiKey = config.kieApiKey }) {
  if (!apiKey) {
    const err = new Error('KIE_API_KEY is not configured');
    err.status = 401;
    throw err;
  }
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(config.editTimeoutMs, 60000);
  const jpegBuffer = await sharp(imageBuffer).rotate().jpeg({ quality: 92 }).toBuffer();

  // 1. Upload buffer to Kie.ai temporary file storage
  const form = new FormData();
  form.append('file', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'input.jpg');
  form.append('uploadPath', 'cardesk-inputs');
  form.append('fileName', `car-${Date.now()}.jpg`);

  const uploadResp = await fetch('https://kieai.redpandaai.co/api/file-stream-upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const uploadJson = await uploadResp.json().catch(() => ({}));
  const downloadUrl = uploadJson?.data?.downloadUrl;
  if (!uploadResp.ok || !downloadUrl) {
    const err = new Error(`Kie.ai upload failed (${uploadResp.status}): ${uploadJson?.msg || 'no downloadUrl'}`);
    err.status = uploadResp.status;
    throw err;
  }

  // 2. Create edit task
  const model = config.kieModelName || 'google/nano-banana-edit';
  const input =
    model.startsWith('qwen/')
      ? { prompt: instruction, image_url: downloadUrl, output_format: 'jpeg' }
      : { prompt: instruction, image_urls: [downloadUrl], output_format: 'jpeg' };

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });
  const createJson = await createResp.json().catch(() => ({}));
  const taskId = createJson?.data?.taskId;
  if (!createResp.ok || createJson?.code !== 200 || !taskId) {
    const err = new Error(
      `Kie.ai createTask failed (${createJson?.code || createResp.status}): ${createJson?.msg || 'unknown error'}`
    );
    err.status = createJson?.code || createResp.status;
    throw err;
  }

  // 3. Poll GET /api/v1/jobs/recordInfo?taskId=...
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const pollResp = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const pollJson = await pollResp.json().catch(() => ({}));
    const data = pollJson?.data || {};
    const state = String(data.state || '').toLowerCase();

    if (state === 'success') {
      let resultUrls = data.resultUrls;
      if (!resultUrls && typeof data.resultJson === 'string') {
        try {
          resultUrls = JSON.parse(data.resultJson)?.resultUrls;
        } catch {
          // ignore
        }
      }
      const outUrl = Array.isArray(resultUrls) ? resultUrls[0] : null;
      if (!outUrl) {
        throw new Error('Kie.ai task succeeded without resultUrls');
      }
      const imgResp = await fetch(outUrl);
      if (!imgResp.ok) {
        throw new Error(`Kie.ai output download failed (${imgResp.status})`);
      }
      const outBuffer = Buffer.from(await imgResp.arrayBuffer());
      return {
        imageBuffer: outBuffer,
        latencyMs: Date.now() - startedAt,
        meta: {
          provider: 'kie',
          model,
          taskId,
        },
      };
    }

    if (state === 'fail') {
      const err = new Error(`Kie.ai task failed: ${data.failMsg || 'unknown error'}`);
      err.status = Number(data.failCode || 500);
      throw err;
    }
  }

  throw new Error(`Kie.ai edit timed out after ${Date.now() - startedAt}ms`);
}

function pickAspectRatio(width, height) {
  if (!width || !height) return '4:3';
  const ratio = width / height;
  const candidates = [
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
  ];
  let best = '4:3';
  let bestDiff = Infinity;
  for (const [label, val] of candidates) {
    const diff = Math.abs(ratio - val);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = label;
    }
  }
  return best;
}

async function editImageMagicHour({ imageBuffer, instruction }) {
  if (!config.editApiKey) {
    throw new Error('EDIT_API_KEY is not configured for Magic Hour');
  }
  const baseUrl = (config.editApiUrl || 'https://api.magichour.ai').replace(/\/+$/, '');
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(config.editTimeoutMs, 60000);

  const jpegBuffer = await sharp(imageBuffer).rotate().jpeg({ quality: 92 }).toBuffer();
  const meta = await sharp(jpegBuffer).metadata();
  const aspectRatio = pickAspectRatio(meta.width, meta.height);

  const authHeaders = {
    Authorization: `Bearer ${config.editApiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  // 1. Request presigned upload URL
  const uploadUrlResp = await fetch(`${baseUrl}/v1/files/upload-urls`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ items: [{ type: 'image', extension: 'jpg' }] }),
  });
  if (!uploadUrlResp.ok) {
    const errText = await uploadUrlResp.text().catch(() => '');
    throw new Error(`Magic Hour upload-urls failed (${uploadUrlResp.status}): ${errText.slice(0, 300)}`);
  }
  const uploadData = await uploadUrlResp.json();
  const item = uploadData?.items?.[0];
  if (!item?.upload_url || !item?.file_path) {
    throw new Error('Magic Hour upload-urls did not return upload_url and file_path');
  }

  // 2. PUT image bytes to presigned URL
  const putResp = await fetch(item.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: jpegBuffer,
  });
  if (!putResp.ok) {
    throw new Error(`Magic Hour file PUT failed (${putResp.status})`);
  }

  // 3. Create AI Image Editor project
  const model = config.editModelName || 'qwen-edit';
  const createResp = await fetch(`${baseUrl}/v1/ai-image-editor`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'CarDesk Repair',
      image_count: 1,
      model,
      aspect_ratio: aspectRatio,
      resolution: config.editResolution || '640px',
      assets: {
        image_file_paths: [item.file_path],
      },
      style: {
        prompt: instruction,
      },
    }),
  });
  if (!createResp.ok) {
    const errText = await createResp.text().catch(() => '');
    throw new Error(`Magic Hour ai-image-editor failed (${createResp.status}): ${errText.slice(0, 300)}`);
  }
  const project = await createResp.json();
  if (!project?.id) {
    throw new Error('Magic Hour ai-image-editor did not return project id');
  }

  // 4. Poll GET /v1/image-projects/{id}
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const pollResp = await fetch(`${baseUrl}/v1/image-projects/${project.id}`, {
      headers: {
        Authorization: `Bearer ${config.editApiKey}`,
        Accept: 'application/json',
      },
    });
    if (!pollResp.ok) {
      const errText = await pollResp.text().catch(() => '');
      throw new Error(`Magic Hour project poll failed (${pollResp.status}): ${errText.slice(0, 300)}`);
    }
    const details = await pollResp.json();
    if (details.status === 'complete') {
      const downloadUrl = details.downloads?.[0]?.url;
      if (!downloadUrl) {
        throw new Error('Magic Hour project completed without download URL');
      }
      const imgResp = await fetch(downloadUrl);
      if (!imgResp.ok) {
        throw new Error(`Magic Hour download failed (${imgResp.status})`);
      }
      const outBuffer = Buffer.from(await imgResp.arrayBuffer());
      return {
        imageBuffer: outBuffer,
        latencyMs: Date.now() - startedAt,
        meta: {
          provider: 'magichour',
          model,
          projectId: project.id,
        },
      };
    }
    if (details.status === 'error') {
      throw new Error(`Magic Hour edit error: ${details.error?.message || 'unknown error'}`);
    }
  }

  throw new Error(`Magic Hour edit timed out after ${Date.now() - startedAt}ms`);
}

async function editImageQwenHttp({ imageBuffer, instruction }) {
  if (!config.editApiUrl) {
    throw new Error('EDIT_API_URL is not configured for qwen_http provider');
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.editTimeoutMs);

  try {
    const pngBuffer = await sharp(imageBuffer).rotate().png().toBuffer();
    const formData = new FormData();
    formData.append('image', new Blob([pngBuffer], { type: 'image/png' }), 'input.png');
    formData.append('prompt', instruction);
    if (config.editModelName) {
      formData.append('model', config.editModelName);
    }

    const headers = {};
    if (config.editApiKey) {
      headers.Authorization = `Bearer ${config.editApiKey}`;
    }

    const response = await fetch(config.editApiUrl, {
      method: 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Qwen edit API failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    let outBuffer;

    if (contentType.startsWith('image/')) {
      const arr = await response.arrayBuffer();
      outBuffer = Buffer.from(arr);
    } else {
      const json = await response.json();
      const b64 = json?.data?.[0]?.b64_json || json?.image_base64 || json?.output?.image_base64;
      const url = json?.data?.[0]?.url || json?.image_url || json?.output?.url;
      if (b64) {
        outBuffer = Buffer.from(b64, 'base64');
      } else if (url) {
        const imgResp = await fetch(url, { signal: controller.signal });
        if (!imgResp.ok) {
          throw new Error(`Failed to fetch edited image from URL (${imgResp.status})`);
        }
        outBuffer = Buffer.from(await imgResp.arrayBuffer());
      } else {
        throw new Error('Qwen edit API returned JSON without image data or URL');
      }
    }

    return {
      imageBuffer: outBuffer,
      latencyMs: Date.now() - startedAt,
      meta: {
        provider: 'qwen_http',
        model: config.editModelName,
        contentType,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
