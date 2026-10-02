---
name: release-zotero-mineru
description: Prepare version bumps and publish Zotero MinerU GitHub Releases. Use when asked to bump the plugin version, prepare a release, publish a version, or recover its failed release workflow.
---

# Zotero MinerU 版本发布

从仓库根目录执行。版本提升请求完成「准备」阶段；发布请求继续完成「发布」和「核验」。用户明确要求发布时，提交版本变更、推送发布分支和 tag 属于该请求范围。skill 本身不授权外部写操作。

## 准备

1. 确定目标版本和发布范围。用户未指定版本时，结合当前版本和已有版本更新判断；无法确定才询问。读取 [package.json](../../../package.json)、[runtime manifest](../../../runtime/release.json)、[Release workflow](../../../.github/workflows/release.yml) 和 [AGENTS.md](../../../AGENTS.md)。工具链版本、脚本和上传方式以这些文件为准。
2. 查看工作区、分支、remote 和待发布 commits。fetch 目标 remote，确认本地分支包含远端最新变更。保留用户的其他改动，明确哪些 commits 会随发布推送。检查目标 tag 和 GitHub Release 是否已存在；已存在时转到「恢复」，先确定其 commit 和发布状态。
3. 同步 `package.json.version` 与 `runtime/release.json.plugin.version`。manifest 的 plugin ID 必须匹配 `package.json.config.addonID`。仅插件版本提升时保留 runtime `release_id` 和依赖锁；runtime 组合发生变化时，按 [runtime/README.md](../../../runtime/README.md) 更新 manifest、locks 和 release ID。
4. 使用 package scripts 执行生产构建、lint 和 runtime installer 测试。运行 `uv run --no-project python scripts/write_release_checksums.py` 刷新 tracked `runtime/SHA256SUMS` 和构建产物的 XPI checksum，然后验证：

   ```sh
   sha256sum -c runtime/SHA256SUMS
   (cd .scaffold/build && sha256sum -c install-runtime.py.sha256 && sha256sum -c XPI-SHA256SUMS)
   git diff --check
   ```

   根据实际改动运行相关测试。运行 Zotero 集成测试前，按 AGENTS.md 配置只针对测试 profile 的清理命令，保护正在运行的用户会话。测试会重新生成 `.scaffold/build`；测试后重新生产构建，再刷新和验证 checksums。最后一次构建后，checksum 必须与当前产物一致。

准备完成条件：目标版本一致、相关检查通过、tracked checksum 已刷新、diff 只包含本次请求的改动。仅提升版本时报告变更和验证结果；提交、推送或打 tag 按用户要求执行。

## 发布

1. 确认准备条件满足，将发布相关改动提交为 Conventional Commit，例如 `chore(release): bump version to VERSION`。已有版本提交可直接使用。记录发布 commit SHA 和从目标版本得到的 `vVERSION` tag。
2. 推送目标发布分支，确认远端分支指向发布 commit。若该分支会触发 CI，找到**同一 SHA** 的 CI run，等待并检查结果。失败时先诊断修复；用户在当前任务中明确授权的检查豁免仍有效，最终报告必须列出该豁免。
3. 为已验证的发布 commit 创建 annotated tag 并推送。该仓库通过 tag push 调用 Release workflow；workflow 构建 XPI 和独立 installer，运行 scaffold release，再显式上传 installer 和 checksum。使用 workflow 发布，确保完整执行这些步骤。
4. 找到同时匹配 tag 和 SHA 的 Release run，记录 run ID 与 URL。用 `gh run watch` 等待结束并检查退出码；长命令遵循当前环境的持久化输出要求。持续更新用户，保留结果直到消费完毕。

发布阶段完成条件：远端 tag 指向预期 commit，匹配的 Release workflow 成功。推送 tag 或看到 Release 页面只是中间状态，继续核验实际附件。

## 核验

1. 用 `gh release view` 检查对应 tag 的 Release：正式版本应为非 draft、非 prerelease；预发布版本按用户指定的发布类型检查。从 manifest 和 scaffold 配置推导预期 XPI 名称，确认 XPI、`install-runtime.py`、`install-runtime.py.sha256` 均已上传。
2. 用 `gh release download` 将该 Release 附件下载到新临时目录，在该目录执行：

   ```sh
   sha256sum -c install-runtime.py.sha256
   uv run --no-project install-runtime.py --help
   ```

   使用 Python `zipfile` 读取下载的 XPI 内 `manifest.json`，断言版本等于目标版本、插件 ID 等于 `package.json.config.addonID`。独立 installer 的 SHA256 应与同一 commit 的本地生成产物一致；XPI 含 build timestamp，其本地构建和 CI 构建的整体哈希可能不同。

3. 确认同一发布 commit 的 CI 状态和本地工作区。最终给出 Release 链接、版本 commit、发布和 CI 结果，以及实际完成的附件验证。区分 installer 的外部替身测试、`--help` 检查和真实 runtime 安装；只报告实际执行的验证。

完成条件：Release 类型正确、所有预期附件可下载且核验通过、CI 结果明确。

## 恢复

- **tag 已存在**：比较远端 tag 与目标 commit。相同则继续观察已有 run/Release；不同则报告冲突并确定处理方案。移动或删除已推送 tag 需要用户明确授权。
- **workflow 失败**：读取失败步骤日志。瞬时外部故障可重试一次对应 run；重复失败或需要源码修改时，停止盲目重试，报告诊断与下一步。源码修复形成新 commit 后，重新确定发布版本和 tag。
- **Release 已部分发布**：按原 tag 的 commit 验证已有附件。若只缺 installer 附件，可从该 commit 的隔离 checkout 重新构建并补传到本次 Release，再执行完整附件核验。替换已经存在且不匹配的附件前，报告差异并取得针对替换的授权。
- **Release 已完整发布**：核验现有发布并报告结果，避免重复创建版本或覆盖附件。

任务状态和验证结果保留在 PR、CI 与对话中；仓库文档只记录当前发布机制。
