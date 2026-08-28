// Thread Art — upload intake + readable-file validation (T1).
//
// DOM-free logic; main.js owns the wiring. A file "validates" when it claims
// to be a JPG/PNG/WebP AND the browser can actually decode it — this catches
// corrupted files and text files renamed to .jpg without crashing the page.
//
// Decode intentionally uses an <img> element (EXIF-correct dimensions, works
// everywhere). T2 replaces ingestion with the EXIF-safe createImageBitmap
// pipeline (decode → downscale → circle crop → normalize → Float32Array).

export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_BYTES = 100 * 1024 * 1024; // 100 MB guard

const ACCEPTED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function fail(reason, message) {
  return { ok: false, reason, message };
}

function hasImageExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return ACCEPTED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function looksLikeImage(file) {
  return (
    ACCEPTED_MIME_TYPES.includes(file.type) || hasImageExtension(file.name || "")
  );
}

// Returns the first image-looking file from a FileList-like collection,
// or null when nothing in it plausibly is an image.
export function pickImageFile(list) {
  if (!list || typeof list.length !== "number") return null;
  for (let i = 0; i < list.length; i += 1) {
    const file = list[i];
    if (file && looksLikeImage(file)) return file;
  }
  return null;
}

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
      resolve(image); // keep the object URL alive; it is reused for the thumbnail
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("browser could not decode the file"));
    };
    image.src = url;
  });
}

// Validates that a chosen file is a readable raster image. Never throws:
// resolves { ok: true, name, width, height, url } on success, or
// { ok: false, reason, message } with a user-ready message on failure.
export async function readImageFile(file) {
  if (!file) return fail("missing", "No file was provided.");

  if (file.size === 0) {
    return fail("empty", "The file has nothing in it — try exporting the image again.");
  }
  if (!looksLikeImage(file)) {
    return fail(
      "unsupported",
      "Thread Art weaves JPG, PNG and WebP images. Try a photo in one of those formats."
    );
  }
  if (file.size > MAX_BYTES) {
    return fail(
      "too-large",
      "This image is over 100 MB. Try a smaller export — the weaver works at a low internal resolution anyway."
    );
  }

  try {
    const image = await decodeWithImageElement(file);
    return {
      ok: true,
      name: file.name || "Pasted image",
      width: image.naturalWidth,
      height: image.naturalHeight,
      url: image.src,
    };
  } catch (error) {
    return fail(
      "unreadable",
      "It looks like an image, but the browser can’t decode it — the file may be corrupted or mislabeled."
    );
  }
}

// Release the thumbnail object URL once the result is no longer shown.
export function releaseImage(result) {
  if (result && result.ok && result.url) URL.revokeObjectURL(result.url);
}
