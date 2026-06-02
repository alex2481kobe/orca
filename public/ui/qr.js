// QR code SVG generation (pure, no DOM/shell state). Extracted from app.js.
// qrSvgForText memoizes the last result; computeQrSvgForText builds the matrix.

let _qrCache = { text: null, svg: '' };
export function qrSvgForText(text) {
  // The phone URL rarely changes; memoize so we don't rebuild ~1000 <rect>s on
  // every 3s render.
  const key = String(text || '');
  if (_qrCache.text === key) return _qrCache.svg;
  const svg = computeQrSvgForText(key);
  _qrCache = { text: key, svg };
  return svg;
}

function computeQrSvgForText(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text || '')));
  const size = 33;
  const dataCodewords = 80;
  const ecCodewords = 20;
  if (!bytes.length || bytes.length > 74) {
    return '<div class="qr-fallback">QR unavailable<br><span>Use copy link</span></div>';
  }

  const bitBuffer = [];
  const appendBits = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bitBuffer.push((value >>> i) & 1);
  };
  appendBits(0x4, 4);
  appendBits(bytes.length, 8);
  bytes.forEach((byte) => appendBits(byte, 8));
  for (let i = 0; i < 4 && bitBuffer.length < dataCodewords * 8; i += 1) bitBuffer.push(0);
  while (bitBuffer.length % 8) bitBuffer.push(0);
  const data = [];
  for (let i = 0; i < bitBuffer.length; i += 8) {
    data.push(bitBuffer.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0; data.length < dataCodewords; pad += 1) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  const exp = new Array(512);
  const log = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < exp.length; i += 1) exp[i] = exp[i - 255];
  const gfMul = (a, b) => (!a || !b ? 0 : exp[log[a] + log[b]]);
  let gen = [1];
  for (let i = 0; i < ecCodewords; i += 1) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((coef, index) => {
      next[index] ^= coef;
      next[index + 1] ^= gfMul(coef, exp[i]);
    });
    gen = next;
  }
  const work = data.concat(new Array(ecCodewords).fill(0));
  for (let i = 0; i < data.length; i += 1) {
    const coef = work[i];
    if (!coef) continue;
    gen.forEach((value, index) => {
      work[i + index] ^= gfMul(value, coef);
    });
  }
  const codewords = data.concat(work.slice(data.length));
  const dataBits = [];
  codewords.forEach((byte) => {
    for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >>> i) & 1);
  });

  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const setModule = (mx, my, dark, reserve = true) => {
    if (mx < 0 || my < 0 || mx >= size || my >= size) return;
    modules[my][mx] = Boolean(dark);
    if (reserve) reserved[my][mx] = true;
  };
  const drawFinder = (fx, fy) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const xx = fx + dx;
        const yy = fy + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const inPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const dark = inPattern && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setModule(xx, yy, dark);
      }
    }
  };
  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const max = Math.max(Math.abs(dx), Math.abs(dy));
        setModule(cx + dx, cy + dy, max === 2 || max === 0);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);
  drawAlignment(26, 26);
  for (let i = 8; i < size - 8; i += 1) {
    setModule(i, 6, i % 2 === 0);
    setModule(6, i, i % 2 === 0);
  }
  setModule(8, 25, true);
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setModule(8, i, false);
      setModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setModule(size - 1 - i, 8, false);
    setModule(8, size - 1 - i, false);
  }

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const yPos = upward ? size - 1 - vert : vert;
      for (let col = 0; col < 2; col += 1) {
        const xPos = right - col;
        if (reserved[yPos][xPos]) continue;
        let dark = bitIndex < dataBits.length ? Boolean(dataBits[bitIndex]) : false;
        bitIndex += 1;
        if ((xPos + yPos) % 2 === 0) dark = !dark;
        modules[yPos][xPos] = dark;
      }
    }
    upward = !upward;
  }

  let formatData = (1 << 3); // Error correction L, mask 0.
  let rem = formatData;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ (((rem >>> 9) & 1) ? 0x537 : 0);
  }
  const formatBits = ((formatData << 10) | (rem & 0x3ff)) ^ 0x5412;
  const formatBit = (i) => ((formatBits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) setModule(8, i, formatBit(i));
  setModule(8, 7, formatBit(6));
  setModule(8, 8, formatBit(7));
  setModule(7, 8, formatBit(8));
  for (let i = 9; i < 15; i += 1) setModule(14 - i, 8, formatBit(i));
  for (let i = 0; i < 8; i += 1) setModule(size - 1 - i, 8, formatBit(i));
  for (let i = 8; i < 15; i += 1) setModule(8, size - 15 + i, formatBit(i));
  setModule(8, size - 8, true);

  const cells = [];
  modules.forEach((row, yPos) => {
    row.forEach((dark, xPos) => {
      if (dark) cells.push(`<rect x="${xPos + 4}" y="${yPos + 4}" width="1" height="1"/>`);
    });
  });
  return `<svg class="qr-code" viewBox="0 0 ${size + 8} ${size + 8}" role="img" aria-label="QR code for phone URL"><rect width="${size + 8}" height="${size + 8}" fill="#f5f1e8"/>${cells.join('')}</svg>`;
}
