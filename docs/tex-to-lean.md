# 从 LaTeX 论文初稿导出 PDF

## 已实现

论文初稿页现在提供「导出 PDF」。服务端从当前账号的已验收运行读取目标定理和保存的 `template.tex` / `main.tex`，通过 `THEOREMOS_WEB_TEX_IMAGE` 指定的独立 TeX 镜像，在一次性隔离容器中使用 XeLaTeX 与 `latexmk` 编译并返回 PDF。源稿下载、目标切换、待审状态与 PDF 导出使用同一份稿件快照，正文固定为英文。

编译容器启用无网络、只读根文件系统、非 root 用户、禁用 shell escape、时间、并发和产物大小限制。失败响应会保留源稿下载，并在 TeX 日志提供位置时显示文件和行号。

在 Web 工作台的论文初稿页增加「导出 PDF」。点击后，服务端读取当前运行、目标定理和已保存的英文源稿，使用该稿件的 `template.tex` 和 `main.tex` 进行编译。PDF 对应同一版可下载的 LaTeX 源稿，待审稿继续显示待审状态。[现有 Lean 到 TeX 流程](lean-to-tex.md)

## Docker 编译环境

在 `apps/web/Dockerfile` 中增加专用的 TeX 构建目标，由 Web 工作台通过现有 Docker 调用方式按需启动。镜像预装 TeX Live、XeLaTeX、`latexmk` 和 AMS 数学宏包，使用英文 `article` 模板。本地 Compose 和部署配置都指定编译镜像版本。[Web Dockerfile](../apps/web/Dockerfile)

每次导出启动一次性容器，只传入两份 TeX 文件。容器以非 root 用户运行，禁用网络和 shell escape，使用只读根文件系统和限额临时目录。Web 限制编译时间、并发数和产物大小，并在请求结束或超时后清理容器和临时文件。[现有 Docker 调用](../apps/web/runner.ts#L271)

## 导出流程

1. 复用源稿下载的访问检查，确认运行归属、独立验收结果、目标定理和原 Lean 证明的摘要，再读取当前可导出的英文稿件快照。
2. 将两个文件写到同一临时目录，以 `template.tex` 为入口，让 `latexmk` 调用 XeLaTeX 并按需重复编译，解析定理、公式等交叉引用。[latexmk 手册](https://manpages.debian.org/bookworm/latexmk/latexmk.1.en.html)
3. 编译成功并产出 PDF 后，以 `application/pdf` 返回附件。编译报错、超时或缺少产物时，页面显示失败原因，能定位时一并显示文件和行号。作者仍可下载源稿排查。浏览器预览可沿用同一编译流程。

## 验收

- 用当前模板编译一份带公式和交叉引用的英文样稿，确认定理编号和公式引用正常显示。
- 用语法错误的正文和会超时的编译任务验证错误反馈、容器清理和重试。确认源稿 ZIP 在编译失败后仍可下载。
- 验证不同目标导出各自的英文稿件，已有稿件可以直接导出，其他账号无法通过 PDF 入口读取该运行。
