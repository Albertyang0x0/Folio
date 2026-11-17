# macOS 打包与应用内更新

运行 `./build_macos.sh` 构建本机测试包。构建物包括 `dist/Folio.app`、`dist/Folio-macOS-<架构>.zip` 和带版本号的 DMG。DMG 内提供 Applications 快捷方式，供首次安装。`FOLIO_DIST_DIR` 可以指定另一个输出目录，方便保留旧版做升级测试。

## 打包配置

| 环境变量 | 用途 |
| --- | --- |
| `FOLIO_VERSION` | 用户看到的版本号，例如 `0.2.0` |
| `FOLIO_BUILD_NUMBER` | Sparkle 用于比较版本的递增整数，例如 `200` |
| `FOLIO_UPDATE_FEED_URL` | Sparkle 更新源。公开构建使用 HTTPS，本机测试可使用 `http://127.0.0.1:端口/appcast.xml` |
| `FOLIO_UPDATE_PUBLIC_KEY` | 从 Sparkle 工具取得的 EdDSA 公钥。与更新源一同配置 |
| `FOLIO_SIGN_IDENTITY` | 钥匙串中的 Developer ID Application 签名身份 |
| `FOLIO_NOTARY_PROFILE` | 由 `xcrun notarytool store-credentials` 创建的钥匙串凭据配置 |

构建会验证应用签名。配置了公证凭据时，构建会等待 Apple 接受公证、附加凭票，再生成最终 ZIP。

## 生成更新源

先运行 `./scripts/fetch_sparkle.sh`，由该脚本下载并校验 Sparkle。用同一套密钥签署同一条发布渠道的后续更新。

```bash
sparkle_dir=$(./scripts/fetch_sparkle.sh)
"$sparkle_dir/bin/generate_keys" --account folio-release
export FOLIO_UPDATE_PUBLIC_KEY=$("$sparkle_dir/bin/generate_keys" --account folio-release -p)
```

配置更新源 URL 和构建号后打包。将 ZIP 以带版本号的文件名放入发布目录，再生成签名的 `appcast.xml`：

```bash
"$sparkle_dir/bin/generate_appcast" \
  --account folio-release \
  --download-url-prefix "$FOLIO_UPDATE_DOWNLOAD_PREFIX" \
  path/to/update-archives
```

将生成的 appcast 和归档放到对应的 URL。应用菜单「检查更新…」会读取该 appcast。Sparkle 会在解包前校验更新，并校验 appcast 签名。密钥私钥由 Sparkle 保存在钥匙串中。 [Sparkle 发布文档](https://sparkle-project.org/documentation/publishing/)

## 本机验证

为测试渠道生成独立的 Sparkle 密钥，用同一个回环地址和公钥分别构建较低和较高构建号。准备好较新包和签名 appcast 后，可以用 Python 在本机提供更新文件。

```bash
python3 -m http.server 17982 --bind 127.0.0.1 --directory path/to/update-archives
```

解压旧包到可写目录，打开 Folio 并从菜单检查更新。确认应用下载并安装新版，重新打开后版本号递增，原有论文与阅读记录可正常打开。测试渠道的密钥和回环地址仅用于本机验证。
