<!-- <p align="center">
<img src="./icon.png" style="width:100px;" />
</p> -->

<h1 align="center">
Unify Chat Provider
</h1>

<p align="center">
使用 Language Model API，将多个大语言模型 API 提供商集成到 VS Code 的 GitHub Copilot Chat 中。
</p>

<!-- <br>
<p align="center">
<a href="https://unocss.dev/">Documentation</a> |
<a href="https://unocss.dev/play/">Playground</a>
</p>
<br> -->

<br>
<p align="center">
<a href="./README.md">English</a> |
<span>简体中文</span>
</p>

## 简介

待补充...

## 贡献

- Build: `npm run compile`
- Watch: `npm run watch`
- Interactive release: `npm run release`

## 路线图

- The `nativeTool` should include a configuration option within `ModelConfig`. In addition to `Default`, `Enable`, and `Disable`, add an `Auto` option that automatically selects the appropriate setting based on the model family. Also, include native tool implementations for various models to force a specific choice. Remove the related `Features`. Add the `Anthropic WebFetchTool` and ensure that citation content is handled correctly (it may not be displayed directly).
- The current Features use “Feature” as the key and should also use conditions to determine which Features should be enabled. In addition to boolean values, other types of data are also supported. So user can override the support of a Feature in the configuration.
- Precise thinking contents to reduce the amount of network data (OpenAIConciseReasoning and Anthropic thinking).
- Support monitoring of balance usage.
- Embedded functionality similar to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
- Context Indicator, official related issue：https://github.com/microsoft/vscode/issues/277871, https://github.com/microsoft/vscode/issues/277414

## 许可证

[MIT @ SmallMain](./LICENSE)
