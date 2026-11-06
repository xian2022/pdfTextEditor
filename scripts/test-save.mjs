// 验证 PDF 导出管线：生成源 PDF -> 模拟编辑器标注（含中文、遮盖、换行）-> 重新加载校验
// 运行：npm test
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildPdf } from '../src/pdf-save.js';

const fontPath = new URL('../public/fonts/builtin-font.ttf', import.meta.url);
const fontBytes = readFileSync(fontPath);

// 1) 生成一个带真实中文内容的源 PDF（两页）
const src = await PDFDocument.create();
src.registerFontkit(fontkit);
const srcFont = await src.embedFont(fontBytes, { subset: true });
const p1 = src.addPage([595.28, 841.89]);
const p2 = src.addPage([595.28, 841.89]);
p1.drawText('这是原始内容，将被文本框覆盖。', { x: 60, y: 780, size: 14, font: srcFont });
p2.drawText('第二页原始内容。', { x: 60, y: 780, size: 14, font: srcFont });
const srcBytes = await src.save();
writeFileSync('test-input.pdf', srcBytes);
console.log('[test] 已生成源 PDF: test-input.pdf (%d bytes)', srcBytes.length);

// 2) 模拟编辑器产生的标注（屏幕像素已按 RENDER_SCALE=1.5 换算为 pt）
// 覆盖：中文多行、遮盖、颜色、内置字体与扩展字体两条路径
const extraFonts = new Map([['font_extra', { bytes: fontBytes }]]);
const out = await buildPdf(
  srcBytes,
  [
    {
      pageIndex: 0,
      x: 60, y: 120, w: 270, h: 50,
      text: '第一行：中文替换文本\n第二行：Hello, PDF!',
      fontSize: 14, whiteout: true, bgColor: '#ffffff', color: '#cc0000', fontId: '__default__',
    },
    {
      pageIndex: 1,
      x: 100, y: 200, w: 200, h: 30,
      text: '第二页新增标注（扩展字体）',
      fontSize: 12, whiteout: false, color: '#0000cc', fontId: 'font_extra',
    },
    {
      pageIndex: 1,
      x: 100, y: 300, w: 200, h: 30,
      text: '', // 空文本：仅执行遮盖（模拟删除原文）
      fontSize: 12, whiteout: true, bgColor: '#ffffff', color: '#000000', fontId: '__default__',
    },
    {
      pageIndex: 1,
      x: 100, y: 100, w: 240, h: 30,
      text: '粗斜下划线',
      fontSize: 14, whiteout: false, color: '#000000', fontId: '__default__',
      bold: true, italic: true, underline: true,
    },
  ],
  fontBytes,
  extraFonts
);
writeFileSync('test-output.pdf', out);
console.log('[test] 已生成输出 PDF: test-output.pdf (%d bytes)', out.length);

// 3) 重新加载校验结构与内容
const reloaded = await PDFDocument.load(out);
if (reloaded.getPages().length !== 2) throw new Error('页数不符');
if (out.length <= srcBytes.length) throw new Error('输出未包含新增内容');

// 检查是否嵌入了字体子集（遍历对象查找 Type0 复合字体与 CIDFontType0C 内嵌 CFF 程序）
const subtypes = new Set();
reloaded.context.enumerateIndirectObjects().forEach(([, obj]) => {
  const dict = obj?.dict && typeof obj.dict.get === 'function' ? obj.dict : obj;
  if (dict && typeof dict.get === 'function') {
    const s = dict.get(PDFName.of('Subtype'))?.toString();
    if (s) subtypes.add(s);
  }
});
console.log('[test] 字体对象 subtypes: %s', [...subtypes].join(', '));
if (
  !subtypes.has('/Type0') ||
  (!subtypes.has('/CIDFontType0C') && !subtypes.has('/CIDFontType2'))
) {
  throw new Error('未找到嵌入的中文字体');
}

console.log('[test] 全部校验通过 ✔');
