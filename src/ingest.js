// Thread Art — image ingestion pipeline (T2).
//
// Pipeline (committed RQ4 decision, docs/ultron/research/rq4-contrast-normalization.md):
//   decode (EXIF-safe, imageOrientation 'from-image') → downscale to ~600 px
//   working resolution (resizeQuality / imageSmoothingQuality 'high') → circular
//   crop → conditional 2nd→98th percentile stretch over IN-CIRCLE pixels only →
//   Float32Array emit for the engine (T3/T4).
//
// Stretch is skipped bit-exactly when p98−p2 ≥ 200 (input already has range),
// and skipped as a flat/noise guard when p98−p2 < 24. No blur in the default
// pipeline; if T8 QA ever shows artifacting on grainy phone photos, the flagged
// follow-up is an optional deterministic 3×3 box blur here (NOT default).
//
// Emitted module output (what the weaving engine consumes):
//   {
//     greyscale:   Float32Array(diameter²) — Rec.709 luma, 0 = black … 1 = white,
//                  normalized per RQ4; pixels outside the circle are 1 (white,
//                  i.e. no thread). Row-major, row length = diameter.
//     diameter:    int — circle diameter in working pixels.
//     cropOffset:  {x, y} — top-left of the circle's bounding box in working px.
//     working:     {width, height} — working-resolution image dims.
//     normalization: {applied, p2, p98, range} — RQ4 decision record (T8 log).
//   }
//
// The pure helpers (lumaByte, normalizeContrast, circleSample) touch no DOM
// globals at module scope, so this module imports cleanly under Node for unit
// checks; only the decode/prepare/emit helpers need a browser.

export const WORKING_MAX = 600; // internal working resolution (plan: 500–700 px)

// Normalization thresholds (RQ4; constants, tuning flagged for T8 evidence).
export const P_LO = 0.02;
export const P_HI = 0.98;
export const FLAT_RANGE = 24; // below: near-constant — stretching only amplifies noise
export const GOOD_RANGE = 200; // at/above: already good contrast — bit-exact passthrough

// ------------------------------------------------------------- pure helpers

// Rec.709 luma of one RGBA pixel as a 0–255 byte, alpha composited over white
// (thread art is dark thread on a light ground: transparent becomes white).
export function lumaByte(r, g, b, a) {
  const alpha = a / 255;
  const red = r * alpha + 255 * (1 - alpha);
  const green = g * alpha + 255 * (1 - alpha);
  const blue = b * alpha + 255 * (1 - alpha);
  return Math.round((2126 * red + 7152 * green + 722 * blue) / 10000);
}

// Conditional percentile contrast stretch (RQ4 reference implementation).
// gray: Uint8Array of IN-CIRCLE luma values, length N. Mutated in place when
// the stretch fires (integer histogram → single 256-entry LUT; deterministic).
// Returns {applied, p2, p98, range, lut} — lut is null when skipped.
export function normalizeContrast(gray, N) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) hist[gray[i]]++;

  const loCut = N * P_LO;
  const hiCut = N * P_HI;
  let acc = 0;
  let p2 = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loCut) {
      p2 = v;
      break;
    }
  }
  acc = 0;
  let p98 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiCut) {
      p98 = v;
      break;
    }
  }

  const range = p98 - p2;
  if (range < FLAT_RANGE || range >= GOOD_RANGE) {
    return { applied: false, p2, p98, range, lut: null };
  }

  const lut = new Uint8ClampedArray(256); // clamps to 0–255 automatically
  const scale = 255 / range;
  for (let v = 0; v < 256; v++) lut[v] = (v - p2) * scale;
  for (let i = 0; i < N; i++) gray[i] = lut[gray[i]];
  return { applied: true, p2, p98, range, lut };
}

// Sample the draggable circle from a working-resolution RGBA buffer.
// imageData: {data, width, height} (what CanvasRenderingContext2D.getImageData
// returns); cx, cy: circle center in working px; diameter: circle diameter.
// See the module header for the shape of the returned object.
export function circleSample(imageData, cx, cy, diameter) {
  const { data, width, height } = imageData;
  const d = diameter;
  const r = d / 2;
  // Integer top-left of the circle's bounding box, clamped inside the image.
  const x0 = Math.max(0, Math.min(width - d, Math.round(cx - r)));
  const y0 = Math.max(0, Math.min(height - d, Math.round(cy - r)));
  const ccx = cx - x0; // circle center relative to the box (may be fractional)
  const ccy = cy - y0;
  const r2 = r * r;

  const box = new Uint8Array(d * d); // luma of every pixel in the bounding box
  const inside = new Uint8Array(d * d); // 1 = pixel center inside the circle
  let count = 0;
  for (let y = 0; y < d; y++) {
    const dy = y + 0.5 - ccy;
    const row = (y0 + y) * width;
    for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - ccx;
      const i = y * d + x;
      const p = (row + x0 + x) * 4;
      box[i] = lumaByte(data[p], data[p + 1], data[p + 2], data[p + 3]);
      if (dx * dx + dy * dy <= r2) {
        inside[i] = 1;
        count++;
      }
    }
  }

  // RQ4: the histogram must see only the pixels the engine will actually weave.
  const circle = new Uint8Array(count);
  for (let i = 0, k = 0; i < box.length; i++) {
    if (inside[i]) circle[k++] = box[i];
  }
  const stats = normalizeContrast(circle, count);

  // Same raster order as the collection pass above, so values line up exactly.
  const greyscale = new Float32Array(d * d);
  for (let i = 0, k = 0; i < box.length; i++) {
    greyscale[i] = inside[i] ? circle[k++] / 255 : 1;
  }

  return {
    greyscale,
    diameter: d,
    cropOffset: { x: x0, y: y0 },
    working: { width, height },
    normalization: {
      applied: stats.applied,
      p2: stats.p2,
      p98: stats.p98,
      range: stats.range,
    },
  };
}

// ---------------------------------------------------------- browser helpers

// EXIF-safe <img> decode — the fallback path. Evergreen browsers apply EXIF
// orientation to <img> elements (and to drawImage of them) by default.
function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        URL.revokeObjectURL(url);
        reject(new Error("decoded image has no pixels"));
        return;
      }
      resolve(image); // caller draws it, then revokes via releaseImageElement()
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("browser could not decode the file"));
    };
    image.src = url;
  });
}

function releaseImageElement(image) {
  if (image instanceof HTMLImageElement) URL.revokeObjectURL(image.src);
}

function closeBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
}

// Decode the file EXIF-safe, downscale to ≤ WORKING_MAX on the long side with
// high-quality resampling, and draw the working image into targetCanvas
// (whose width/height are set to the working dims).
// Resolves {ok: true, width, height, sourceWidth, sourceHeight} (working and
// EXIF-oriented source dims) or {ok: false, reason: 'unreadable'}.
export async function prepareWorkingImage(file, targetCanvas) {
  const ctx = targetCanvas.getContext("2d");

  let drawable = null; // ImageBitmap | HTMLImageElement
  let sw = 0;
  let sh = 0;
  let usedImageElement = false;

  try {
    if (typeof createImageBitmap === "function") {
      // 'from-image' is the spec default, stated explicitly: EXIF orientation
      // is applied, so bitmap dims are the upright (displayed) dims.
      const full = await createImageBitmap(file, { imageOrientation: "from-image" });
      sw = full.width;
      sh = full.height;
      const scale = Math.min(1, WORKING_MAX / Math.max(sw, sh));
      const tw = Math.max(1, Math.round(sw * scale));
      const th = Math.max(1, Math.round(sh * scale));
      if (scale === 1) {
        drawable = full;
      } else {
        try {
          drawable = await createImageBitmap(full, {
            resizeWidth: tw,
            resizeHeight: th,
            resizeQuality: "high",
          });
          closeBitmap(full);
        } catch {
          // Resize options unsupported here: draw the full bitmap below with
          // imageSmoothingQuality 'high' instead (same pipeline, one step later).
          drawable = full;
        }
      }
    } else {
      throw new Error("createImageBitmap unavailable");
    }
  } catch {
    try {
      drawable = await decodeWithImageElement(file);
      usedImageElement = true;
      sw = drawable.naturalWidth;
      sh = drawable.naturalHeight;
    } catch {
      releaseImageElement(drawable);
      return { ok: false, reason: "unreadable" };
    }
  }

  const scale = Math.min(1, WORKING_MAX / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * scale));
  const th = Math.max(1, Math.round(sh * scale));

  targetCanvas.width = tw;
  targetCanvas.height = th;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, tw, th);
  ctx.drawImage(drawable, 0, 0, tw, th);

  if (usedImageElement) releaseImageElement(drawable);
  else closeBitmap(drawable);

  return { ok: true, width: tw, height: th, sourceWidth: sw, sourceHeight: sh };
}

// Build the engine input from the crop-stage canvas at the current circle
// position, and log the RQ4 decision {applied, p2, p98, range} to the console
// (dev instrumentation; T8 collects these fields as QA evidence).
// circle: {cx, cy, d} in working pixels (from the crop controller).
export function emitCropOutput(canvas, circle) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const output = circleSample(imageData, circle.cx, circle.cy, circle.d);

  console.log("[thread-art] normalization:", output.normalization);
  console.log("[thread-art] ingest output:", {
    diameter: output.diameter,
    cropOffset: output.cropOffset,
    working: output.working,
    pixels: output.greyscale.length,
  });
  return output;
}
