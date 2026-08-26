// Shared validation for the small images the app stores as data URIs — the
// authorised-signatory mark on User, and the company logo on Company. Both are
// handed to PDFKit's image(), which only understands PNG and JPEG, so anything
// else is rejected here rather than at document-generation time where it would
// break the download instead.
const DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// `label` names the field in any error the caller surfaces; `maxBytes` caps the
// decoded size.
export const parseImageDataUrl = (value, { label = 'Image', maxBytes = 400 * 1024 } = {}) => {
  const match = DATA_URI.exec(String(value || '').trim());
  if (!match) {
    return { error: `${label} must be a PNG or JPEG image` };
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    return { error: `${label} is empty or corrupt` };
  }
  if (buffer.length > maxBytes) {
    return { error: `${label} must be under ${Math.round(maxBytes / 1024)}KB` };
  }

  // Confirm the bytes match the declared type — the header is not something a
  // caller can fake by relabelling the MIME prefix.
  const isPng = buffer.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff;
  if (!(isPng || isJpeg)) {
    return { error: `${label} is not a valid PNG or JPEG` };
  }

  return { dataUrl: `data:image/${match[1]};base64,${match[2]}` };
};
