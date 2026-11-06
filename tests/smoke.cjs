// SPDX-License-Identifier: GPL-2.0-only
// Targeted firmware acceptance checks. Uses existing binaries, never compiles them.
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
require("../site/elf.js");
require("../site/lcd.js");
const { Machine } = require("../site/machine.js");
function symbols(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    map = new Map();
  const off = v.getUint32(32, true),
    size = v.getUint16(46, true),
    count = v.getUint16(48, true);
  for (let i = 0; i < count; i++) {
    const h = off + i * size;
    if (v.getUint32(h + 4, true) !== 2) continue;
    const start = v.getUint32(h + 16, true),
      len = v.getUint32(h + 20, true),
      link = v.getUint32(h + 24, true),
      entry = v.getUint32(h + 36, true);
    const str = v.getUint32(off + link * size + 16, true);
    for (let p = start; p < start + len; p += entry) {
      const n = str + v.getUint32(p, true);
      let e = n;
      while (bytes[e]) e++;
      const name = bytes.subarray(n, e).toString();
      if (name) map.set(name, v.getUint32(p + 4, true));
    }
  }
  return map;
}
(async () => {
  const [lcdPath, templatePath] = process.argv.slice(2);
  assert(
    lcdPath && templatePath,
    "Usage: node tests/smoke.cjs <BSP HAL LCD AXF> <template ELF>",
  );
  const u = await require("../site/vendor/unicorn_arm.js")();
  assert.throws(() => global.parseELF(new Uint8Array(60)), /ELF/);
  const lcdBytes = fs.readFileSync(lcdPath),
    m = new Machine(u, lcdBytes);
  m.step(1200);
  assert.equal(m.lcd.writes, 84096);
  assert.equal(m.lcd.pixels.filter((p) => p === 65535).length, 566);
  const frameHash = crypto
    .createHash("sha256")
    .update(m.lcd.rgba())
    .digest("hex");
  assert.equal(
    frameHash,
    "d17eb71de34d373670b9d1ba100a7a6d0510744bdd165b3b2ab7e18ba62f44bb",
  );
  console.log("PASS BSP real firmware LCD:", {
    writes: m.lcd.writes,
    whitePixels: 566,
    frameHash,
    unknown: [...m.unknown.values()],
  });
  assert.equal(m.unknown.size, 0);
  m.close();
  const bytes = fs.readFileSync(templatePath),
    s = symbols(bytes),
    t = new Machine(u, bytes);
  const address = (name) => {
    assert(s.has(name), "ELF symbol missing: " + name);
    return s.get(name);
  };
  const key = () => t.e.mem_read(address("key_val"), 1)[0];
  t.step(1000);
  assert.equal(t.lcd.writes, 76800);
  assert.equal(key(), 0);
  assert(t.readWord(address("uwTick")) > 900);
  t.keys[0] = true;
  t.step(30);
  assert.equal(key(), 1);
  t.keys[0] = false;
  t.step(30);
  assert.equal(key(), 0);
  t.adc = [0.825, 2.475];
  t.step(40);
  assert.equal(t.readWord(address("dma_buff")), 1024);
  assert.equal(t.readWord(address("dma_buff") + 120), 3071);
  const buf = Uint8Array.from(t.e.mem_read(address("adc_value"), 8));
  const floats = new DataView(buf.buffer);
  assert(Number.isFinite(floats.getFloat32(0, true)));
  assert(floats.getFloat32(1 * 4, true) > floats.getFloat32(0, true));
  assert.equal(t.readWord(address("tim_ic_val")), 1000);
  t.frequency = 2000;
  t.step(100);
  assert.equal(t.readWord(address("tim_ic_val")), 2000);
  t.rx.push(...Buffer.from("ct117e-test\r\n"));
  t.step(100);
  assert.match(t.serial, /ringbuffer data: ct117e-test/);
  console.log("PASS template:", {
    keyPressRelease: true,
    adc: [floats.getFloat32(0, true), floats.getFloat32(4, true)],
    capture: t.readWord(address("tim_ic_val")),
    pwm: [t.pwm(0x40012c00, 1), t.pwm(0x40000000, 2)],
    ms: t.ms,
    unknown: [...t.unknown.values()],
  });
  assert.equal(t.unknown.size, 0);
  t.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
