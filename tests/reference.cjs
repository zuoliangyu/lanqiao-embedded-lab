// SPDX-License-Identifier: GPL-2.0-only
// 用历届真题参考工程的现成固件做端到端验收，固件不随项目分发。
// 用法：node tests/reference.cjs --p17 <17届省赛.axf> --p16 <16届省赛.axf> --p15 <15届省赛.axf> --n13 <13届国赛.axf>
const fs = require("node:fs"),
  assert = require("node:assert/strict");
for (const f of ["elf", "lcd", "i2c", "timer"]) require("../site/" + f + ".js");
const { Machine } = require("../site/machine.js");
function symbols(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    map = new Map(),
    off = v.getUint32(32, true),
    size = v.getUint16(46, true),
    count = v.getUint16(48, true);
  for (let i = 0; i < count; i++) {
    const h = off + i * size;
    if (v.getUint32(h + 4, true) !== 2) continue;
    const start = v.getUint32(h + 16, true),
      len = v.getUint32(h + 20, true),
      link = v.getUint32(h + 24, true),
      entry = v.getUint32(h + 36, true),
      str = v.getUint32(off + link * size + 16, true);
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
function board(u, file, options) {
  const bytes = fs.readFileSync(file),
    sym = symbols(bytes),
    m = new Machine(u, bytes, options);
  const at = (name) => {
    assert(sym.has(name), "符号缺失：" + name);
    return sym.get(name);
  };
  m.u32 = (name, i = 0) => m.readWord(at(name) + i * 4);
  m.u8 = (name, i = 0) => m.e.mem_read(at(name) + i, 1)[0];
  m.f32 = (name, i = 0) => Buffer.from(m.e.mem_read(at(name) + i * 4, 4)).readFloatLE(0);
  m.press = (k, ms = 120) => {
    m.setKey(k, true);
    m.step(ms);
    m.setKey(k, false);
    m.step(250);
    while (m.keys[k]) m.step(10);
  };
  // 快速时序下 LCD 初始化与清屏约占 0.6 s 仿真时间，先等调度任务开始运行。
  m.warm = () => m.step(1500);
  m.out = (pin) => m.timers.pin(pin);
  // 点按后等待固件状态变化：快速时序下整屏刷新期间不扫键，单击判定可能需要数秒仿真时间。
  m.until = (fn, ms = 8000) => {
    for (let t = 0; t < ms && !fn(); t += 10) m.step(10);
    assert(fn(), "等待超时");
  };
  return m;
}
const scenarios = {
  // 17 届省赛：R39→PB4 测流量，PA1 输出 10 kHz PWM，手动模式下占空比 1%/s 平滑过渡。
  p17(u, file) {
    const m = board(u, file);
    m.signals.PB4.hz = 4000;
    m.warm();
    assert(Math.abs(m.u32("tim3_ic_val") - 4000) <= 40, "PB4 测频 " + m.u32("tim3_ic_val"));
    assert(Math.abs(m.f32("lcd_main_flow_lpm") - 20) < 0.3, "瞬时流量 F=f/200");
    let pa1 = m.out("PA1");
    assert.equal(pa1.source, "TIM2_CH2");
    assert(Math.abs(pa1.hz - 10000) < 1 && Math.abs(pa1.duty - 5) < 0.5, "初始 10 kHz / 5%");
    const page = () => m.u8("lcd_disp_src");
    m.press(0);
    m.until(() => page() === 1);
    m.press(2);
    m.until(() => m.u8("lcd_outp_tar_d_pct") === 10);
    m.press(0);
    m.until(() => page() === 2);
    const applied = m.ms;
    m.press(0);
    m.until(() => page() === 0);
    m.step(Math.max(0, 2500 - (m.ms - applied)));
    const mid = m.out("PA1").duty;
    m.step(4000);
    pa1 = m.out("PA1");
    assert(mid > 5.5 && mid < 9.5, "过渡中 " + mid.toFixed(1) + "%");
    assert(Math.abs(pa1.duty - 10) < 0.5, "到达 TarD=10%，实际 " + pa1.duty.toFixed(1) + "%");
    m.signals.PB4.hz = 9000;
    m.step(400);
    assert(m.leds & 1, "f>8000 Hz 时 LD1 报警");
    m.close();
    return { flow: 20, ramp: [mid.toFixed(1), pa1.duty.toFixed(1)] };
  },
  // 16 届省赛：R37/R38 调 PA7（TIM17）占空比与频率，PA15（TIM2_CH1）测频。
  p16(u, file) {
    const m = board(u, file);
    m.adc = [3.3, 3.3];
    m.signals.PA15.hz = 1500;
    m.warm();
    const pa7 = m.out("PA7");
    assert.equal(pa7.source, "TIM17_CH1");
    assert(pa7.hz > 1890 && pa7.hz <= 2000, "R38 满量程 → 约 1900–2000 Hz（固件按 4095/4096 取整），实际 " + pa7.hz);
    assert(pa7.duty > 78 && pa7.duty <= 80, "R37 满量程 → 约 79–80%（同样取整），实际 " + pa7.duty);
    assert.equal(m.captures().find((c) => c.pin === "PA15").source, "TIM2_CH1");
    assert(Math.abs(m.u32("tim_ic_val") - 1500) <= 15, "PA15 测频 " + m.u32("tim_ic_val"));
    m.adc = [0, 0];
    m.step(800);
    assert(Math.abs(m.out("PA7").hz - 1000) < 10 && Math.abs(m.out("PA7").duty - 10) < 1, "下限 1000 Hz / 10%");
    m.close();
    return { pa7: "2000 Hz / 80% → 1000 Hz / 10%", pa15: 1500 };
  },
  // 15 届省赛：PA15（TIM8）与 PB4（TIM3）双通道测频。
  p15(u, file) {
    const m = board(u, file);
    m.signals.PA15.hz = 1234;
    m.signals.PB4.hz = 15000;
    m.warm();
    const a = m.u32("tim_ic_val", 0),
      b = m.u32("tim_ic_val", 1),
      got = [a, b].sort((x, y) => x - y);
    // 1 MHz 计数时 15 kHz 的周期是 66.7 tick，固件得到 1e6/66 = 15151 Hz，与实物一致。
    assert(Math.abs(got[0] - 1234) <= 13 && Math.abs(got[1] - 15000) <= 300, "测频 " + [a, b]);
    m.close();
    return { tim_ic_val: [a, b] };
  },
  // 13 届国赛：参数写入 AT24C02 并在上电时读回；串口 “#” 翻转 LCD。
  n13(u, file) {
    const eeprom = new Uint8Array(256).fill(0xff);
    eeprom[0] = 1;
    eeprom[4] = 1;
    let m = board(u, file, { eeprom });
    m.warm();
    assert.deepEqual([m.u8("para_arr", 0), m.u8("para_arr", 1)], [1, 1], "上电读出 X=1、Y=1");
    m.press(0);
    m.press(1);
    m.press(2);
    m.press(2);
    m.step(100);
    assert.deepEqual([m.i2c.eeprom[0], m.i2c.eeprom[4]], [2, 3], "写入 EEPROM");
    const saved = m.i2c.eeprom.slice();
    m.rx.push(0x23);
    m.step(300);
    assert(m.lcd.regs[1] & 0x100 && m.lcd.regs[0x60] & 0x8000, "收到 # 后设置 SS 与 GS");
    m.close();
    m = board(u, file, { eeprom: saved });
    m.warm();
    assert.deepEqual([m.u8("para_arr", 0), m.u8("para_arr", 1)], [2, 3], "重新上电后读回");
    m.close();
    return { eeprom: [saved[0], saved[4]], flip: true };
  },
};
(async () => {
  const args = process.argv.slice(2),
    jobs = [];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, "");
    assert(scenarios[name], "未知场景：" + args[i]);
    jobs.push([name, args[i + 1]]);
  }
  assert(jobs.length, "用法：node tests/reference.cjs --p17 <axf> [--p16 <axf>] [--p15 <axf>] [--n13 <axf>]");
  const u = await require("../site/vendor/unicorn_arm.js")();
  let failed = 0;
  for (const [name, file] of jobs) {
    try {
      console.log("PASS", name, JSON.stringify(scenarios[name](u, file)));
    } catch (e) {
      failed++;
      console.log("FAIL", name, e.message);
    }
  }
  process.exitCode = failed ? 1 : 0;
})();
