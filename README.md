# pi-open-code-review

在 pi 中运行 Alibaba [OpenCodeReview](https://github.com/alibaba/open-code-review) 的原生 `ocr review`。目标是用当前会话或命令指定的 pi 模型，而不修改 OCR 的全局 provider 配置。

**可行性验证通过，尚未正式发布。** 实现和复现脚本在 [`spike/native-model-bridge`](https://github.com/Meowooh/pi-open-code-review/tree/spike/native-model-bridge)，`main` 暂不包含可安装的扩展。

在 pi **1.6.0**、OCR **1.14.2** 中，用不同于主会话的模型完成了 `file_read` → `code_comment` → OCR 复核，准确定位 `pricing.py:3` 的金额计算错误；主会话模型前后不变。使用本地 fixture 也独立验证了继承当前模型及 JSON 别名两条路径。

- [验证记录与已知限制](https://github.com/Meowooh/pi-open-code-review/blob/94ba01d788985aa1418dceaeec12b75a6fb9fba7/VALIDATION.md)
- [试用命令](https://github.com/Meowooh/pi-open-code-review/blob/spike/native-model-bridge/README.md#试用不改全局配置) · [验证任务 #1](https://github.com/Meowooh/pi-open-code-review/issues/1)

```sh
git switch spike/native-model-bridge
npm ci --ignore-scripts
npm run smoke   # 临时仓库 + 本地 fixture，无需真实模型凭据
```
