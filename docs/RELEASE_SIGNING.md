# Windows 发布签名与 updater 签名

本文说明如何产出**带 Authenticode 签名**的安装包和**带签名的 updater 清单**，以及如何在干净
Windows VM 上重新执行安装 / 卸载 / 离线渲染验收。

> 当前状态：签名构建、updater 清单、SBOM、日志聚合和干净 runner 发布 workflow 已就绪。仓库里没有证书和私钥，
> 因此真实签名发布仍需在 GitHub Secrets 中配置凭据后才能执行。
> 具体缺口见文末「当前缺口」。

## 1. 需要准备什么

| 项目 | 用途 | 来源 |
|---|---|---|
| 代码签名证书（OV/EV） | 给 EXE、sidecar、NSIS 安装包做 Authenticode 签名 | 商业 CA（DigiCert / Sectigo / 沃通等），或以 `.pfx` 形式导出 |
| 时间戳服务 URL | 保证证书过期后签名仍然有效 | 默认 `http://timestamp.digicert.com` |
| updater 密钥对 | 给 updater 产物（`*.sig`）签名 | `npx tauri signer generate -w <path>` |
| signtool.exe | 实际执行签名 | Windows SDK（Signing Tools） |

证书与私钥**不要**进仓库。CI 里用 Secrets，本机用环境变量或系统证书存储。

## 2. 环境变量

签名（二选一）：

```text
KNOWMOTION_SIGN_PFX=D:\secrets\knowmotion.pfx
KNOWMOTION_SIGN_PFX_PASSWORD=***
```

或使用证书存储里的指纹（CI 先 `Import-PfxCertificate`）：

```text
KNOWMOTION_SIGN_THUMBPRINT=ABCDEF0123456789...
```

updater：

```text
TAURI_SIGNING_PRIVATE_KEY=<私钥内容，或其文件路径>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=***
```

其它可选项：

```text
KNOWMOTION_SIGN_TIMESTAMP_URL=http://timestamp.digicert.com
KNOWMOTION_SIGN_REQUIRED=1   # 置 1 后，缺少证书会让构建直接失败，而不是静默产出未签名包
```

## 3. 构建

```bash
npm run desktop:build:signed
```

该脚本会：

1. 校验证书与 updater 私钥齐备；
2. 合并 `scripts/release/tauri.signing.conf.json` 执行 `tauri build`：
   - `bundle.windows.signCommand` 逐个调用 `scripts/release/sign-windows.ps1`；
   - `bundle.createUpdaterArtifacts: true` 生成签名 updater 产物；
3. 重新验签每个产物（含时间戳）并写出 `src-tauri/target/release/signed-release.json`（含 SHA-256）。

GitHub Actions 使用 `.github/workflows/release.yml` 自动完成：

```text
质量门禁
→ CycloneDX Rust + npm SBOM
→ Authenticode + RFC3161 时间戳签名
→ signed updater artifacts
→ 签名后干净 runner 安装/离线渲染/卸载 smoke
→ latest.json
→ 日志与哈希清单聚合
→ GitHub Release
```

单独验签：

```bash
npm run desktop:verify:signature
```

`sign-windows.ps1` 的行为约定：

- 有证书 → 用 SHA-256 + RFC3161 时间戳签名，签完立刻 `Get-AuthenticodeSignature` 复验；
- 无证书且 `KNOWMOTION_SIGN_REQUIRED=1` → 抛错，构建失败；
- 无证书且未设置该变量 → 警告并跳过（本地开发构建不受影响）。

## 4. 干净 VM 验收

带签名要求重跑安装 smoke：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-vm/run-install-smoke.ps1 `
  -InstallerPath "src-tauri\target\release\bundle\nsis\KnowMotion AI Studio_0.1.0_x64-setup.exe" `
  -RequireSignature `
  -ExpectedSignerThumbprint $env:KNOWMOTION_SIGN_THUMBPRINT `
  -EnforceOffline
```

脚本会校验：签名状态与签名者指纹 → 静默安装 → 20 个 runtime 文件哈希 → 安装目录内固定运行时
离线渲染 1.5 秒 H.264 → 启动并检查 `Desktop services initialized` → 静默卸载并确认关键文件移除。

## 5. updater（签名清单）

`createUpdaterArtifacts` 生成的 `*.sig` 即 updater 签名清单的一部分。要真正推送更新，还需要：

1. 托管 `latest.json`（Tauri updater 静态清单）与安装包；
2. 在应用内接入 `tauri-plugin-updater`（Rust + JS）并配置 `plugins.updater.pubkey` 与 `endpoints`；
3. 用同一把私钥在 CI 中签名，发布前校验公钥与私钥匹配。

CI 会生成静态 updater 清单 `release-evidence/artifacts/latest.json`，其中 URL 指向同一
GitHub Release 的 NSIS 安装包，`signature` 取自 Tauri 生成的 `*.sig`。应用内是否启用自动检查更新
仍需发布方配置 updater endpoint 和公钥；未配置时不会显示假的“已自动更新”状态。

## 6. SBOM、诊断与证据

```powershell
./scripts/release/generate-sbom.ps1
./scripts/release/aggregate-release.ps1
```

`generate-sbom.ps1` 生成并验证 `rust.cdx.json` 与 `npm.cdx.json`。`aggregate-release.ps1`
把安装包、updater 签名、SBOM、E2E 结果和 release 报告复制到 `release-evidence/artifacts`，
并生成包含 SHA-256 的 `release-manifest.json`。完整构建/VM 日志通过 PowerShell transcript
保留在 `release-evidence/ci`。

应用内“模型与连接 → 导出诊断”会生成脱敏 ZIP，包含运行版本、SQLite `quick_check`、
本地运行时状态和递归脱敏日志；不包含项目媒体、Provider 密钥或项目 JSON。

## 7. 当前缺口

| 缺口 | 影响 | 解封条件 |
|---|---|---|
| 无代码签名证书 | 无法产出签名安装包，SmartScreen 仍会警告 | 提供 `.pfx` + 密码，或把证书导入证书存储并给出指纹 |
| 无 updater 私钥 | 无法产出签名 updater 产物 | `npx tauri signer generate -w <path>` 后把私钥放进 CI Secret |
| 无干净 Windows VM / Sandbox | 无法重跑“签名后”的安装 / 卸载 / 离线渲染验收 | 提供干净 VM（或启用 Windows Sandbox），或由 CI 的 `windows-latest` 承担 |
