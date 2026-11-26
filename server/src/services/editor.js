import sharp from 'sharp';
import { config } from '../config.js';

/**
 * Swappable image editing adapter.
 * Signature: editImage({ imageBuffer, instruction }) -> { imageBuffer, latencyMs, meta }
 */
export async function editImage({ imageBuffer, instruction }) {
  const provider = config.editProvider;
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
