阅屿 · Folio 便携版
===================

使用方法
1. 请先完整解压 ZIP，不要直接在压缩包预览窗口中运行。
2. 双击 Folio.exe。
3. 首次使用时，在设置中填写自己的 DeepSeek API Key。

数据与备份
- 所有论文、译文缓存、阅读记录、笔记、设置和诊断日志都保存在 data 文件夹。
- 迁移到另一台 Windows 电脑时，请复制整个 Folio 文件夹。
- 升级时先备份 data 文件夹，再用新版程序文件替换旧版；不要覆盖或删除 data。
- 存储管理页面会显示各类数据占用和实际数据路径。

退出与故障排查
- 直接关闭 Folio 窗口即可退出，本机后台服务会一并关闭。
- 同一时间只能运行一个 Folio。
- 无法启动时请查看 data\logs\folio.log。
- 程序只监听 127.0.0.1，不会把 PDF 上传到公共服务器；翻译正文会按设置调用 DeepSeek API。

系统要求
- Windows 10/11 x64。
- 需要 Microsoft Edge WebView2 Runtime。Windows 11 和大多数 Windows 10 已自带；若提示缺失，请从微软官网安装 Evergreen WebView2 Runtime。

开源许可
- 阅屿 · Folio 采用 MIT License，完整条款见同目录 LICENSE.txt。
