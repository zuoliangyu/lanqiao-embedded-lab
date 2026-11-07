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
  const inRange = (address, size) =>
    (address >= 0x08000000 && address + size <= 0x08020000) ||
    (address >= 0x20000000 && address + size <= 0x20008000) ||
    (address >= 0x10000000 && address + size <= 0x10002800);
  // Intel HEX：Keil 提交给评测的就是这种文件。
  function parseHex(bytes) {
    const fail = (msg) => {
      throw new Error("HEX：" + msg);
    };
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/),
      chunks = [];
    let upper = 0,
      entry = 0,
      ended = false;
    for (const [n, raw] of lines.entries()) {
      const line = raw.trim();
      if (!line) continue;
      if (!/^:[0-9A-Fa-f]+$/.test(line) || line.length < 11 || line.length % 2 === 0)
        fail("第 " + (n + 1) + " 行格式无效。");
      const rec = new Uint8Array((line.length - 1) / 2);
      for (let i = 0; i < rec.length; i++) rec[i] = parseInt(line.substr(1 + i * 2, 2), 16);
      if (rec.reduce((s, b) => s + b, 0) & 255)
        fail("第 " + (n + 1) + " 行校验和错误。");
      const count = rec[0],
        offset = (rec[1] << 8) | rec[2],
        type = rec[3],
        data = rec.subarray(4, 4 + count);
      if (data.length !== count) fail("第 " + (n + 1) + " 行长度不符。");
      if (type === 0) chunks.push({ address: (upper + offset) >>> 0, data });
      else if (type === 1) {
        ended = true;
        break;
      } else if (type === 2) upper = ((data[0] << 8) | data[1]) << 4;
      else if (type === 4) upper = (((data[0] << 8) | data[1]) << 16) >>> 0;
      else if (type === 5) entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    }
    if (!ended) fail("缺少结束记录。");
    chunks.sort((a, b) => a.address - b.address);
    const segments = [];
    for (const c of chunks) {
      const last = segments[segments.length - 1];
      if (last && last.address + last.length === c.address) {
        last.parts.push(c.data);
        last.length += c.data.length;
      } else segments.push({ address: c.address, parts: [c.data], length: c.data.length });
    }
    const out = segments.map((s) => {
      if (!inRange(s.address, s.length)) fail("数据地址超出 STM32G431RB 的内存范围。");
      const data = new Uint8Array(s.length);
      let p = 0;
      for (const part of s.parts) {
        data.set(part, p);
        p += part.length;
      }
      return { address: s.address, data, memsize: s.length };
    });
    if (!out.some((s) => s.address === 0x08000000 && s.data.length >= 8))
      fail("未找到 0x08000000 处的启动向量表；暂不支持 bootloader 偏移。");
    return { segments: out, entry, size: bytes.length, format: "hex" };
  }
  function parseFirmware(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let i = 0;
    while (i < bytes.length && (bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf || bytes[i] <= 32)) i++;
    if (bytes[i] === 0x3a) return parseHex(bytes);
    if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45)
      return { ...parseELF(bytes), format: "elf" };
    throw new Error("请选择 ELF、AXF 或 HEX 固件文件。");
  }
  root.parseELF = parseELF;
  root.parseHex = parseHex;
  root.parseFirmware = parseFirmware;
  if (typeof module !== "undefined") module.exports = { parseELF, parseHex, parseFirmware };
})(globalThis);
