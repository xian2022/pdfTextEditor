// 用现代 fontkit 生成合法的字体子集，并补写 cmap 表
// （pdf-lib 内置的旧版 fontkit 对部分中文字体（霞鹜文楷/思源宋体等）
//   生成的子集字形数据损坏，导致 Chrome/PDFium 渲染缺失；
//   现代 fontkit 的子集数据正确，但不带 cmap，这里补上以便嵌入）

import * as fontkit from 'fontkit';

const u16 = (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
const u32 = (v) => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function pad4(u8) {
  const rem = u8.length % 4;
  if (rem === 0) return u8;
  return concat(u8, new Uint8Array(4 - rem));
}

function checksum(u8) {
  let sum = 0;
  for (let i = 0; i < u8.length; i += 4) {
    sum = (sum + ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3])) >>> 0;
  }
  return sum >>> 0;
}

/** 构建 format 4 cmap 子表（每字符一段，idDelta 直接映射） */
function buildFormat4(codeToGid) {
  const entries = [...codeToGid.entries()]
    .filter(([c]) => c <= 0xffff)
    .sort((a, b) => a[0] - b[0]);
  const segCount = entries.length + 1;
  const endCodes = entries.map((e) => e[0]).concat([0xffff]);
  const startCodes = entries.map((e) => e[0]).concat([0xffff]);
  const idDeltas = entries.map(([c, g]) => (((g - c) % 65536) + 65536) % 65536).concat([1]);
  const pow = Math.floor(Math.log2(segCount));
  const searchRange = Math.pow(2, pow) * 2;
  const parts = [];
  parts.push(u16(4)); // format
  parts.push(u16(16 + segCount * 8)); // length
  parts.push(u16(0)); // language
  parts.push(u16(segCount * 2)); // segCountX2
  parts.push(u16(searchRange));
  parts.push(u16(pow));
  parts.push(u16(segCount * 2 - searchRange));
  for (const e of endCodes) parts.push(u16(e));
  parts.push(u16(0)); // reservedPad
  for (const s of startCodes) parts.push(u16(s));
  for (const d of idDeltas) parts.push(u16(d));
  for (let i = 0; i < segCount; i++) parts.push(u16(0)); // idRangeOffset
  return concat(...parts);
}

function buildCmapTable(codeToGid) {
  const subtable = buildFormat4(codeToGid);
  return concat(
    u16(0), // version
    u16(1), // numTables
    u16(3), // platformID (Windows)
    u16(1), // encodingID (Unicode BMP)
    u32(12), // subtable offset
    subtable
  );
}

/** 构建最小 format 0 name 表（旧版 fontkit 读取 name 表必需） */
function buildNameTable(family) {
  const names = [
    [3, 1, 0x409, 1, family], // Windows family
    [3, 1, 0x409, 2, 'Regular'], // subfamily
    [3, 1, 0x409, 4, family], // full name
  ];
  const strings = [];
  const records = [];
  for (const [plat, enc, lang, id, str] of names) {
    const encoded = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      encoded.push(c >> 8, c & 0xff);
    }
    records.push({ plat, enc, lang, id, bytes: encoded });
  }
  const count = records.length;
  const stringOffset = 6 + 12 * count;
  const parts = [u16(0), u16(count), u16(stringOffset)];
  let off = 0;
  for (const r of records) {
    parts.push(u16(r.plat), u16(r.enc), u16(r.lang), u16(r.id), u16(r.bytes.length), u16(off));
    off += r.bytes.length;
  }
  for (const r of records) parts.push(new Uint8Array(r.bytes));
  return concat(...parts);
}

/** 最小 post 表（format 3.0，无字形名） */
function buildPostTable() {
  const parts = [];
  parts.push(u32(0x00030000)); // version 3.0
  parts.push(u32(0)); // italicAngle
  parts.push(u16(0xff9c)); // underlinePosition (-100)
  parts.push(u16(0)); // underlineThickness
  parts.push(u32(0)); // isFixedPitch
  parts.push(u32(0)); // minMemType42
  parts.push(u32(0)); // maxMemType42
  parts.push(u32(0)); // minMemType1
  parts.push(u32(0)); // maxMemType1
  return concat(...parts);
}

/** 最小 OS/2 表（version 4） */
function buildOs2Table() {
  const parts = [];
  parts.push(u16(4)); // version
  parts.push(u16(1000)); // xAvgCharWidth
  parts.push(u16(400)); // usWeightClass
  parts.push(u16(5)); // usWidthClass
  parts.push(u16(0)); // fsType
  parts.push(u16(0), u16(0), u16(0), u16(0)); // subscript/superscript sizes
  parts.push(u16(0)); // yStrikeoutSize
  parts.push(u16(0)); // yStrikeoutPosition
  parts.push(u16(0)); // sFamilyClass
  parts.push(new Uint8Array(10)); // panose
  parts.push(u32(0x80000000), u32(0), u32(0), u32(0)); // ulUnicodeRange
  parts.push(new Uint8Array([0x4e, 0x4f, 0x4e, 0x45])); // achVendID 'NONE'
  parts.push(u16(0x40)); // fsSelection REGULAR
  parts.push(u16(0x20)); // usFirstCharIndex
  parts.push(u16(0xffff)); // usLastCharIndex
  parts.push(u16(880)); // sTypoAscender
  parts.push(u16(0xf488)); // sTypoDescender (-1200? 用 -120 → 0xFF88)
  parts.push(u16(0)); // sTypoLineGap
  parts.push(u16(1000)); // usWinAscent
  parts.push(u16(200)); // usWinDescent
  parts.push(u32(1), u32(0)); // ulCodePageRange
  parts.push(u16(500)); // sxHeight
  parts.push(u16(700)); // sCapHeight
  parts.push(u16(0)); // usDefaultChar
  parts.push(u16(0x20)); // usBreakChar
  parts.push(u16(2)); // usMaxContext
  return concat(...parts);
}

/** 把 name/cmap 表插入 TTF：重建整个表目录，统一重算所有偏移 */
function spliceTables(ttf, additions) {
  const src = ttf;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const numTables = dv.getUint16(4);
  const existing = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(src[off], src[off + 1], src[off + 2], src[off + 3]);
    const dataOff = dv.getUint32(off + 8);
    const length = dv.getUint32(off + 12);
    existing.push({ tag, data: src.slice(dataOff, dataOff + length) });
  }
  const toAdd = additions.filter((a) => !existing.some((e) => e.tag === a.tag));
  if (!toAdd.length) return ttf;
  const all = existing.concat(toAdd.map((a) => ({ tag: a.tag, data: a.data })));
  const newNum = all.length;
  const pow = Math.floor(Math.log2(newNum));
  const searchRange = Math.pow(2, pow) * 16;
  const entrySelector = pow;
  const rangeShift = newNum * 16 - searchRange;

  const head = new Uint8Array(12);
  head.set(src.slice(0, 12));
  head[4] = newNum >> 8;
  head[5] = newNum & 0xff;
  head[6] = searchRange >> 8;
  head[7] = searchRange & 0xff;
  head[8] = entrySelector >> 8;
  head[9] = entrySelector & 0xff;
  head[10] = rangeShift >> 8;
  head[11] = rangeShift & 0xff;

  const entries = [];
  const dataParts = [];
  let off = 12 + newNum * 16; // 所有表数据紧随目录
  for (const t of all) {
    const padded = pad4(t.data);
    entries.push(
      concat(
        new Uint8Array([t.tag.charCodeAt(0), t.tag.charCodeAt(1), t.tag.charCodeAt(2), t.tag.charCodeAt(3)]),
        u32(checksum(padded)),
        u32(off),
        u32(t.data.length)
      )
    );
    dataParts.push(padded);
    off += padded.length;
  }
  return concat(head, ...entries, ...dataParts);
}

/**
 * 生成可安全嵌入的字体子集（含 cmap，PDFium 可渲染）
 * @param {Uint8Array} fontBytes 完整字体
 * @param {string} chars 需要的全部字符
 * @returns {Uint8Array} 子集字体字节
 */
export function createSafeSubset(fontBytes, chars) {
  const font = fontkit.create(new Uint8Array(fontBytes));
  const sub = font.createSubset();
  const codeToGid = new Map();
  let idx = 0;
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    if (codeToGid.has(code)) continue;
    const g = font.glyphForCodePoint(code);
    if (g) {
      sub.includeGlyph(g);
      codeToGid.set(code, ++idx); // fontkit 子集按 include 顺序重编号 1..N
    }
  }
  const subset = new Uint8Array(sub.encode());
  return spliceTables(subset, [
    { tag: 'cmap', data: buildCmapTable(codeToGid) },
    { tag: 'name', data: buildNameTable('PDFEditorFont') },
    { tag: 'post', data: buildPostTable() },
    { tag: 'OS/2', data: buildOs2Table() },
  ]);
}
