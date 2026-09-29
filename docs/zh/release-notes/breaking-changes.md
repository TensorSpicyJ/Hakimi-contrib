# 破坏性变更

## Unreleased

### 移除旧版 AITP Research Mode

**受影响对象：** 旧版 AITP adapter、Research Mode、`/research`、研究 REST/SDK/klient API、模型工具、Research Board、Research Manager、事件和 `theory-physics` plugin 均已移除。

**迁移：** 请将 AITP 独立安装为仅含 Skill 的 plugin，并通过 Hakimi 的常规 plugin 发现、系统提示词和 `Skill` 工具路径使用。Hakimi 不再提供 AITP CLI、账本 adapter、session hook、自动写入、特殊 plugin 处理或自定义 AITP 工具。请遵循 plugin 自身的 Skill 指令；需要安装归档时，使用 <https://github.com/bhjia-phys/AITP-Research-Protocol/releases/download/v1.1.0/aitp-1.1.0.zip>。
