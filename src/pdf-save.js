import { PDFDocument, PDFName, PDFRef, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createSafeSubset } from './font-subset.js';
import { tokenize, findTextRuns, markRunsInRect, serializeOps } from './text-removal.js';

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};
const encode = (str) => {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr;
};
async function inflate(bytes) {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}

/**
 * 真正删除页面内容流中指定矩形区域内的文字绘制指令（保留背景）
 * @returns {boolean} 是否成功删除至少一条文字
 */
async function removeTextFromPage(pdfDoc, page, rect, expectGlyphs) {
  let any = false;
  const contents = page.node.Contents();
  const arr = contents && contents.asArray ? contents.asArray() : contents ? [contents] : [];
  const parts = [];
  for (const item of arr) {
    const obj = item instanceof PDFRef ? pdfDoc.context.lookup(item) : item;
    const raw = obj && obj.getContents ? new Uint8Array(obj.getContents()) : null;
    if (!raw) continue;
    const dec = await inflate(raw);
    const str = latin1(dec);
    const ops = tokenize(str);
    const runs = findTextRuns(ops);
    const res = markRunsInRect(runs, rect, expectGlyphs);
    if (res && res.marked.size > 0) {
      parts.push(serializeOps(ops, res.marked));
      any = true;
    } else {
      parts.push(str);
    }
  }
  if (any && parts.length) {
    const merged = parts.join('\n');
    page.node.set(PDFName.of('Contents'), pdfDoc.context.stream(encode(merged)));
  }
  // 表单 XObject（页面资源里嵌套的内容流）
  try {
    const res = page.node.Resources();
    let xobj = res && res.lookup(PDFName.of('XObject'));
    if (xobj instanceof PDFRef) xobj = pdfDoc.context.lookup(xobj);
    if (xobj && typeof xobj.keys === 'function') {
      for (const key of xobj.keys()) {
        const val = xobj.lookup(key);
        const obj = val instanceof PDFRef ? pdfDoc.context.lookup(val) : val;
        const subtype = obj && obj.dict && obj.dict.get ? String(obj.dict.get(PDFName.of('Subtype'))) : '';
        if (subtype !== '/Form') continue;
        const raw = obj.getContents ? new Uint8Array(obj.getContents()) : null;
        if (!raw) continue;
        const dec = await inflate(raw);
        const ops = tokenize(latin1(dec));
        const runs = findTextRuns(ops);
        const r2 = markRunsInRect(runs, rect, expectGlyphs);
        if (r2 && r2.marked.size > 0) {
          xobj.set(key, pdfDoc.context.stream(encode(serializeOps(ops, r2.marked))));
          any = true;
        }
      }
    }
  } catch (err) {
    console.warn('XObject 文字删除处理失败', err);
  }
  return any;
}

/**
 * 仅删除指定页面的原文文字（不绘制任何标注），返回新 PDF 字节
 * 供编辑器界面实时重绘页面使用（所见即所得：原文创建文本框后立即从画面消失）
 */
export async function deleteTextOnly(sourceBytes, pageIndex, deletions) {
  const pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  if (!page) return null;
  for (const ann of deletions) {
    const { height } = page.getSize();
    const rect = {
      x0: ann.x - 2,
      x1: ann.x + ann.w + 2,
      y0: height - ann.y - ann.h - 2,
      y1: height - ann.y + 2,
    };
    const expect = String(ann.origText || '').length || -1;
    try {
      await removeTextFromPage(pdfDoc, page, rect, expect);
    } catch (err) {
      console.warn('界面重绘删除失败', err);
    }
  }
  return pdfDoc.save();
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * 纯函数：把标注写进 PDF。
 * @param {Uint8Array} sourceBytes 原始 PDF 字节
 * @param {Array} annotations [{ pageIndex, x, y, w, h, text, fontSize, whiteout, color, fontId }]
 *   x/y/w/h 单位是 PDF point（1/72 英寸），y 为距页面顶部距离
 * @param {Uint8Array|ArrayBuffer} defaultFontBytes 内置字体（Noto Sans CJK SC）
 * @param {Map} [extraFonts] fontId -> { bytes } 用户扩展字体
 */
export async function buildPdf(sourceBytes, annotations, defaultFontBytes, extraFonts) {
  const pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });

  // ---- 第一步：真正删除原文（解析内容流移除文字绘制指令，背景保留） ----
  const deletedBoxIds = new Set();
  const removalTargets = annotations.filter((a) => a.deleteOriginal);
  if (removalTargets.length) {
    const pages = pdfDoc.getPages();
    for (const ann of removalTargets) {
      const page = pages[ann.pageIndex];
      if (!page) continue;
      const { height } = page.getSize();
      // 矩形外扩 2pt 余量，避免浮点精度导致的边界误判
      const rect = {
        x0: ann.x - 2,
        x1: ann.x + ann.w + 2,
        y0: height - ann.y - ann.h - 2,
        y1: height - ann.y + 2,
      };
      const expect = String(ann.origText || '').length || -1;
      try {
        const ok = await removeTextFromPage(pdfDoc, page, rect, expect);
        if (ok) deletedBoxIds.add(ann.boxId);
      } catch (err) {
        console.warn('原文删除失败，回退遮盖', err);
      }
    }
  }

  pdfDoc.registerFontkit(fontkit);

  // ---- 字体子集：用现代 fontkit 生成合法子集（含 cmap），避免旧版子集在 Chrome 渲染缺失 ----
  const charsByFont = new Map();
  for (const ann of annotations) {
    const text = ann.text || '';
    if (!text.trim()) continue;
    let set = charsByFont.get(ann.fontId);
    if (!set) {
      set = new Set();
      charsByFont.set(ann.fontId, set);
    }
    for (const ch of text) set.add(ch);
  }
  const subsetCache = new Map();
  for (const [fontId, set] of charsByFont) {
    const bytes = fontId === '__default__' ? defaultFontBytes : extraFonts?.get(fontId)?.bytes;
    if (!bytes) continue;
    try {
      subsetCache.set(fontId, createSafeSubset(bytes, [...set].join('')));
    } catch (err) {
      console.warn('字体子集生成失败，回退内置子集路径', fontId, err);
    }
  }

  const embedded = new Map();
  const getFont = async (fontId) => {
    if (!embedded.has(fontId)) {
      const subBytes = subsetCache.get(fontId);
      if (subBytes) {
        // customName 让 pdf-lib 跳过字体名解析（旧版 fontkit 解析子集 name 表会崩溃）
        const name = 'F' + String(fontId || 'x').replace(/[^A-Za-z0-9]/g, '_');
        embedded.set(fontId, await pdfDoc.embedFont(subBytes, { subset: false, customName: name }));
      } else {
        const bytes = (fontId && extraFonts?.get(fontId)?.bytes) || defaultFontBytes;
        embedded.set(fontId, await pdfDoc.embedFont(bytes, { subset: true }));
      }
    }
    return embedded.get(fontId);
  };
  const docPages = pdfDoc.getPages();

  for (const ann of annotations) {
    const page = docPages[ann.pageIndex];
    if (!page) continue;
    const { height } = page.getSize();
    // 页面坐标：pdf-lib 原点在左下角，标注的 y 是距顶部距离
    const rectTop = height - ann.y - ann.h;

    // 原文遮盖标注：原文已成功删除则整个跳过（背景原样保留）
    if (ann.deleteOriginal) {
      if (deletedBoxIds.has(ann.boxId)) continue;
    }

    const deleted = ann.boxId != null && deletedBoxIds.has(ann.boxId);
    if (ann.whiteout && ann.bgColor && ann.w > 0 && ann.h > 0) {
      // 原文已删除且文本框未移动：跳过填充，避免覆盖照片/彩色背景
      if (deleted && ann.skipWhiteoutIfDeleted) {
        // 不填充
      } else {
        page.drawRectangle({
          x: ann.x, y: rectTop,
          width: ann.w, height: ann.h,
          color: hexToRgb(ann.bgColor),
        });
      }
    }
    const text = ann.text || '';
    if (!text.trim()) continue; // 空文本仅做遮盖（例如删除原文）
    const font = await getFont(ann.fontId);
    const color = hexToRgb(ann.color);
    const lines = text.split('\n');
    const lineHeight = ann.fontSize * 1.25;
    // 字体 ascender 约 0.88em，用它近似首行基线
    const baseline = height - ann.y - ann.fontSize * 0.88;
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const y = baseline - i * lineHeight;
      const drawOpts = { x: ann.x, y, size: ann.fontSize, font, color };
      if (ann.italic) drawOpts.ySkew = degrees(13); // 伪斜体：基线水平、字形顶部右倾（x' = x + tan·y）
      if (ann.bold) {
        // 伪粗体：轻微水平偏移叠画两次
        page.drawText(line, { ...drawOpts, x: ann.x + ann.fontSize * 0.04 });
        page.drawText(line, drawOpts);
      } else {
        page.drawText(line, drawOpts);
      }
      if (ann.underline) {
        const w = font.widthOfTextAtSize(line, ann.fontSize);
        const uy = y - ann.fontSize * 0.16;
        page.drawLine({
          start: { x: ann.x, y: uy },
          end: { x: ann.x + w, y: uy },
          thickness: Math.max(0.6, ann.fontSize * 0.06),
          color,
        });
      }
    });
  }
  return pdfDoc.save();
}

let fontBytesPromise = null;

/** 获取内置字体字节（网页与 Electron 都通过 fetch 相对路径获取） */
export function loadFontBytes() {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch(`${import.meta.env.BASE_URL}fonts/builtin-font.ttf`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            `字体资源加载失败（HTTP ${res.status}）。请先执行 npm run fetch:font 再重新构建。`
          );
        }
        return res.arrayBuffer();
      })
      .then((buf) => new Uint8Array(buf));
  }
  return fontBytesPromise;
}

/** 提前后台预载字体，避免首次保存时等待下载 */
export function preloadFont() {
  loadFontBytes().catch(() => {});
}

/** 浏览器/Electron 渲染进程入口：加载内置字体后调用 buildPdf */
export async function savePdf(sourceBytes, annotations, extraFonts) {
  return buildPdf(sourceBytes, annotations, await loadFontBytes(), extraFonts);
}
