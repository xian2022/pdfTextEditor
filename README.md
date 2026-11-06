# PDF 文本编辑器

一个轻量的 PDF 文本编辑器：**同一份代码**既能在浏览器网页里运行，也能打包成 Windows / macOS / Linux 桌面程序。

打开 PDF → 浏览 / 编辑两种模式 → 修改原文或添加新文本 → 导出新的 PDF 文件。

## 功能

- 打开本地 PDF（文件选择框或直接拖入窗口），多页浏览；加密 PDF 会弹窗要求输入密码
- **浏览模式**：纯查看页面（工具栏只显示打开/编辑/导出）
- **编辑模式**（Word 风格工具栏）：
  - **单击**页面上任意原文文字 → 选中（显示虚线可编辑框，直接拖动即可移动）；**双击**进入编辑（自动保留原字号、颜色，竖排文字合并为一个多行框，表格数值按列拆分）
  - **双击空白处**新建文本框（直接进入编辑）；**单击其他空白处**提交预览（不退出编辑模式）
  - 选中后拖动框身移动、右下角手柄调整大小、点右上角 ✕ 或按 Delete/Backspace 删除
  - **格式工具**：粗体（B）、斜体（I）、下划线（U）、字号、字体、颜色、底色（可选无色）；Ctrl/Cmd+C 复制、Ctrl/Cmd+V 粘贴
  - **撤销/重做**：工具栏按钮或 Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（覆盖添加、删除、移动、缩放、文字与样式修改）
  - **临时保存**：编辑过程自动暂存（localStorage），刷新/重启后自动恢复上次未完成的编辑；点「导出 PDF」下载最终文件后清除暂存
  - 文本框内容超出框宽时自动撑宽（长文本如税号不会在框内折行）；清空内容且保留底色 = 只遮盖该处原文
- **字体扩展**：
  - 内置字体随构建配置：`npm run fetch:font /路径/到/你的字体.ttf` 使用本地字体，否则自动下载开源霞鹜文楷（OFL 协议可商用）
  - **内置字体必须是静态 .ttf（TrueType）**：OTF/CFF 字体经 pdf-lib 子集嵌入后，Chrome/Edge 的 PDF 阅读器无法显示中文（编辑器内正常，但导出的 PDF 在 Chrome 中文字不可见）
  - 网页版 / 桌面版通用：点击「导入字体」选择字体文件即时加载（推荐 TTF，理由同上）
  - 桌面版：点击「字体目录」按钮打开本地字体目录，把字体文件放进去即可扩展（目录位于系统用户数据目录下的 `fonts/` 文件夹）
  - 支持格式：**TTF**（推荐）、OTF、WOFF / WOFF2
- 导出时按所选字体嵌入**字体子集**（只含用到的字形，输出体积小），支持任意文字颜色

## 快速开始

```bash
npm install

# 网页开发模式（http://localhost:5173）
npm run dev

# 构建网页版产物（dist/）
npm run build

# 本地预览构建产物
npm run preview

# 运行桌面版（Electron）
npm run electron

# 打包桌面安装包（输出到 release/）
npm run dist
```

首次构建会自动下载中文字体（约 17MB）到 `public/fonts/`（已 gitignore，不会提交进仓库）。

## 测试

```bash
npm test
```

生成 `test-input.pdf` 与 `test-output.pdf`，验证「生成源 PDF → 写入标注（中文、多行、遮盖、颜色、内置/扩展字体、空文本删除）」→ 重新加载校验整条导出管线。

## GitHub Actions 打包

仓库已包含两个工作流：

1. **Build Desktop**（`.github/workflows/build-desktop.yml`）：打 tag（如 `v1.0.0`）或手动触发，在 Windows / macOS / Linux 三平台上并行构建安装包并上传为 artifacts；打 tag 时还会自动创建 GitHub Release 并附带安装包。
   - Windows: NSIS 安装包 + 便携 zip
   - macOS: DMG + zip（未签名，见下方说明）
   - Linux: AppImage + deb
2. **Deploy Web**（`.github/workflows/deploy-pages.yml`）：推送到 `main` 分支时自动构建并部署网页版到 GitHub Pages（需在仓库 Settings → Pages 中选择 GitHub Actions 作为来源）。

## 常见问题

- **PDF 打不开**：失败原因会显示在工具栏下方的红色提示条里。常见原因：文件加密（会弹密码框）、文件损坏、文件过大。拖入文件没反应时，请确认是 `.pdf` 文件。
- **页面上点不到文字**：说明该 PDF 是扫描件 / 图片型 PDF，本身没有文字层，无法编辑原文（仍可添加新文本框）。文字层检测在进入编辑模式时进行，会提示「没有检测到可编辑的文字层」。
- **原文修改后的字体**：导出时原文被白色遮盖块覆盖、用所选字体重新绘制，字号与颜色自动匹配原文。若原文用了未嵌入 PDF 的专有字体，字体外观无法 100% 还原；可在「字体目录」放入同名字体文件实现自动匹配。
- **原文与印章/底纹重叠**：「遮盖+重写」会盖住重叠部分的印章或底纹，这是该编辑方式的固有限制；对单个文本框取消勾选「遮盖原内容」可避免遮盖（但原文会残留在下层）。

## 目录结构

```
├── index.html               # 页面骨架
├── src/
│   ├── main.js              # 编辑器交互：pdf.js 渲染、文字层、文本框增删移缩放
│   ├── fonts.js             # 字体扩展：解析 TTF/OTF/WOFF 并注册预览字体
│   ├── pdf-save.js          # pdf-lib 导出：遮盖矩形 + 字体子集 + 颜色写入文本
│   └── style.css
├── electron/
│   ├── main.cjs             # 桌面壳：窗口、app:// 协议、保存对话框、字体目录 IPC
│   └── preload.cjs
├── scripts/
│   ├── fetch-font.mjs       # 下载内置中文字体（构建前自动执行）
│   └── test-save.mjs        # 导出管线验证（npm test）
└── .github/workflows/       # CI：桌面打包 + 网页部署
```

## 实现原理与限制

- 编辑方式是「叠加」而非「改写」：原 PDF 内容不会被修改或提取，新文本以嵌入字体子集的形式画在原页面上方；「遮盖原内容」会在文本框区域先画白色矩形。因此**原始文字依然存在于文件中**（可被选中/搜索），如需彻底抹除原文请使用专业工具。
- 旋转了 90°/270° 的页面：文本框位置映射可能不准确（导出前会弹窗提醒），旋转的文本行不会被识别为可编辑原文。
- 加密 PDF 需要密码才能打开。
- 导出的 PDF 中新增文本不是「可编辑文本域」，而是固定文字。
- macOS 安装包使用临时签名（ad-hoc，无 Apple 开发者证书）：下载后首次打开请**右键 → 打开**；若提示"已损坏"，在终端执行 `xattr -cr /Applications/PDFTextEditor.app` 即可（正式分发需配置 Apple 证书与公证）。
- 发布前请把 `package.json` 里的 `author` 改成你自己的名字和邮箱（Linux deb 包需要）。

## 技术栈

[Vite](https://vitejs.dev) + [pdf.js](https://mozilla.github.io/pdf.js)（渲染与文字提取）+ [pdf-lib](https://pdf-lib.js.org)（写入）+ [Electron](https://www.electronjs.org) + [electron-builder](https://www.electron.build)（打包）
