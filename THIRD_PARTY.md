# 第三方组件

## Unicorn.js ARM

- 本地文件：`site/vendor/unicorn_arm.js`，未修改。
- npm 包：`@alexaltea/unicorn-js@2.1.4`，来自 npm 官方 registry。
- 包的 npm SHA-1：`2c7e486443acfc9ecd286d5d30d01197b1609fa9`。
- 发布包：https://registry.npmjs.org/@alexaltea/unicorn-js/-/unicorn-js-2.1.4.tgz
- JavaScript 绑定与构建源码：https://github.com/AlexAltea/unicorn.js
- 上游 CPU 内核源码：https://github.com/unicorn-engine/unicorn
- 许可：GPL-2.0，全文随本项目 `LICENSE` 提供。
- 作者：Alexandro Sanchez Bach；Unicorn 由 Nguyen Anh Quynh、Dang Hoang Vu 等贡献者开发。

本项目使用已经发布的自包含 ARM JS/WASM 文件，没有在本机重新构建它。已根据 npm 发布元数据的 `gitHead` 和该提交的 `unicorn` 子模块指针附上对应源码：

- 绑定与构建脚本：`site/vendor/source/unicorn-js-560284c.tar.gz`，提交 `560284c59c11c8d6c94d537f4354339f069ddcdf`。
- CPU 内核：`site/vendor/source/unicorn-8028ec4.tar.gz`，提交 `8028ec436f2d9376525352dd38ed9ed6b9f6be10`。
- 构建方法见绑定源码中的 `README.md` 与 `build.py`；将 CPU 内核源码放入其 `unicorn/` 目录，并准备上游要求的 Emscripten / CMake / Python 工具链。

SHA-256：

```text
13b0852dc0d9bdac7f25728913d57a496feee29b607388ac47d7e3344dec8422  unicorn_arm.js
9d2a2003f0307d0fc239af439654564fe6ef17b67f7c5a39b45fad4c69d6aec2  unicorn-8028ec4.tar.gz
3aa850b1202d7b1993b6ef3c217f4c5d5d9aa57efefb5114098ff3502c4d7bdb  unicorn-js-560284c.tar.gz
```

项目没有复制其他模拟器的实现，也没有打包用户 BSP、课程资源、字体数组或个人固件。用户固件仅作为本机验收输入。
