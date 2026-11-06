/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  function parseELF(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fail = (msg) => {
      throw new Error("ELF：" + msg);
    };
    if (bytes.length < 52 || view.getUint32(0, false) !== 0x7f454c46)
      fail("请选择 ELF 或 AXF 可执行文件。");
    if (bytes[4] !== 1 || bytes[5] !== 1 || view.getUint16(18, true) !== 40)
      fail("仅支持 32 位小端 ARM 程序。");
    if (view.getUint16(16, true) !== 2)
      fail("需要已链接的可执行文件，不支持目标文件或动态库。");
    const phoff = view.getUint32(28, true),
      entsz = view.getUint16(42, true),
      count = view.getUint16(44, true);
    if (entsz < 32 || count > 128 || phoff + entsz * count > bytes.length)
      fail("程序头损坏。");
    const segments = [];
    for (let i = 0; i < count; i++) {
      const p = phoff + entsz * i;
      if (view.getUint32(p, true) !== 1) continue;
      const off = view.getUint32(p + 4, true),
        va = view.getUint32(p + 8, true),
        pa = view.getUint32(p + 12, true);
      const size = view.getUint32(p + 16, true),
        memsize = view.getUint32(p + 20, true);
      if (off + size > bytes.length || size > memsize) fail("段边界无效。");
      const address = pa || va;
      if (
        size &&
        !(
          (address >= 0x08000000 && address + size <= 0x08020000) ||
          (address >= 0x20000000 && address + size <= 0x20008000) ||
          (address >= 0x10000000 && address + size <= 0x10002800)
        )
      )
        fail("段地址超出 STM32G431RB 的内存范围。");
      if (size)
        segments.push({ address, data: bytes.slice(off, off + size), memsize });
    }
    if (!segments.some((s) => s.address === 0x08000000 && s.data.length >= 8))
      fail("未找到 0x08000000 处的启动向量表；暂不支持 bootloader 偏移。");
    return { segments, entry: view.getUint32(24, true), size: bytes.length };
  }
  root.parseELF = parseELF;
  if (typeof module !== "undefined") module.exports = { parseELF };
})(globalThis);
