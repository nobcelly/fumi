// Prepares a letter photo for the on-device model. Small models read small
// text better from a closer crop, so a tall page is read as two halves, cut
// along an empty line of paper so no printed line is split.

const MAX_SIDE = 2000;

const toJpeg = (canvas: OffscreenCanvas) => canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });

// Darkness of each pixel row, from a small copy of the image.
const rowInk = (bmp: ImageBitmap, width: number, height: number): number[] => {
  const w = 200;
  const h = Math.max(1, Math.round((height / width) * w));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0, w, h);
  const { data } = g.getImageData(0, 0, w, h);
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    let ink = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      ink += 255 - (data[i]! * 0.3 + data[i + 1]! * 0.59 + data[i + 2]! * 0.11);
    }
    rows.push(ink);
  }
  return rows;
};

// The emptiest band of rows in the middle part of the page, as a fraction.
export const findCut = (rows: number[]): number => {
  const from = Math.floor(rows.length * 0.38);
  const to = Math.ceil(rows.length * 0.62);
  let best = Math.round(rows.length / 2);
  let bestInk = Infinity;
  for (let y = from; y < to; y++) {
    // smooth over a few rows so a single blank pixel row between letters does not win
    const ink = (rows[y - 2] ?? 0) + (rows[y - 1] ?? 0) + rows[y]! + (rows[y + 1] ?? 0) + (rows[y + 2] ?? 0);
    if (ink < bestInk) {
      bestInk = ink;
      best = y;
    }
  }
  return best / rows.length;
};

export const tilesFor = async (photo: Blob): Promise<Blob[]> => {
  const bmp = await createImageBitmap(photo);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const draw = (y0: number, y1: number) => {
    const c = new OffscreenCanvas(width, Math.round(y1 - y0));
    c.getContext('2d')!.drawImage(bmp, 0, -y0, width, height);
    return toJpeg(c);
  };
  // a page in landscape, or a short slip: one piece is enough
  if (height < width * 1.15) return [await draw(0, height)];
  const cut = findCut(rowInk(bmp, width, height)) * height;
  const overlap = height * 0.015;
  return [await draw(0, cut + overlap), await draw(cut - overlap, height)];
};

// The bottom of the page, where the sender's office and phone number usually
// are, as its own image for a second look.
export const bottomStrip = async (photo: Blob, from = 0.7): Promise<Blob> => {
  const bmp = await createImageBitmap(photo);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const top = Math.round(height * from);
  const c = new OffscreenCanvas(width, height - top);
  c.getContext('2d')!.drawImage(bmp, 0, -top, width, height);
  return toJpeg(c);
};

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

// How alike two lines are (0..1), by shared character pairs.
const likeness = (a: string, b: string): number => {
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const px = pairs(x);
  let shared = 0;
  for (const [k, n] of pairs(y)) shared += Math.min(n, px.get(k) ?? 0);
  return (2 * shared) / (x.length - 1 + (y.length - 1));
};

// Joins the text of two pieces, dropping the lines both of them read.
export const joinPieces = (top: string, bottom: string): string => {
  const a = top.split('\n').filter((l) => l.trim());
  const b = bottom.split('\n').filter((l) => l.trim());
  let overlap = 0;
  for (let k = Math.min(a.length, b.length, 8); k > 0; k--) {
    const tail = a.slice(-k);
    if (tail.every((l, i) => likeness(l, b[i]!) > 0.75)) {
      overlap = k;
      break;
    }
  }
  return [...a, ...b.slice(overlap)].join('\n');
};

// Adds the lines of a second look that the first reading did not have.
export const appendNew = (text: string, extra: string): string => {
  const have = text.split('\n').filter((l) => l.trim());
  const recent = have.slice(-15);
  const added = extra
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => !recent.some((r) => likeness(r, l) > 0.75));
  return [...have, ...added].join('\n');
};
