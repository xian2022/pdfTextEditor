import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

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
  pdfDoc.registerFontkit(fontkit);
  const embedded = new Map();
  const getFont = async (fontId) => {
    if (!embedded.has(fontId)) {
      const bytes = (fontId && extraFonts?.get(fontId)?.bytes) || defaultFontBytes;
      embedded.set(fontId, await pdfDoc.embedFont(bytes, { subset: true }));
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
    if (ann.whiteout && ann.bgColor && ann.w > 0 && ann.h > 0) {
      // 遮盖块颜色 = 文本框底色（默认白）
      page.drawRectangle({
        x: ann.x, y: rectTop,
        width: ann.w, height: ann.h,
        color: hexToRgb(ann.bgColor),
      });
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
