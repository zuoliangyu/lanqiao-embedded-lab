// SPDX-License-Identifier: GPL-2.0-only
// 外设模型单元测试：不需要用户固件，使用 tests/fixtures 中自带的测试固件。
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
for (const f of ["elf", "lcd", "i2c", "timer"]) require("../site/" + f + ".js");
const { Machine } = require("../site/machine.js");
const hex = fs.readFileSync(path.join(__dirname, "fixtures/unit-firmware.hex"));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const GPIOA = 0x48000000,
  GPIOB = 0x48000400;
function setup(u, options) {
  const m = new Machine(u, hex, options);
  m.w = (a, v) => m.writePeripheral(a, v >>> 0, 4);
  m.r = (a) => m.readPeripheral(a, 4);
  // 引脚设为复用功能：mode 2，AF 编号写入 AFR
  m.af = (base, pin, af) => {
    m.w(base, (m.get(base) & ~(3 << (pin * 2))) | (2 << (pin * 2)));
    const afr = base + 0x20 + (pin >> 3) * 4;
    m.w(afr, (m.get(afr) & ~(15 << ((pin & 7) * 4))) | (af << ((pin & 7) * 4)));
  };
  return m;
}
// 与 BSP i2c_hal.c 相同的位操作：PB6 推挽输出，PB7 开漏输出 / 输入。
function i2c(m) {
  m.w(GPIOB, (m.get(GPIOB) & ~0xf000) | 0x5000);
  m.w(GPIOB + 4, m.get(GPIOB + 4) | 0x80);
  const pin = (n, v) => m.w(GPIOB + 0x18, v ? 1 << n : 1 << (n + 16)),
    scl = (v) => pin(6, v),
    sda = (v) => pin(7, v),
    read = () => (m.r(GPIOB + 0x10) >>> 7) & 1;
  const bus = {
    start() {
      sda(1);
      scl(1);
      sda(0);
      scl(0);
    },
    stop() {
      scl(0);
      sda(0);
      scl(1);
      sda(1);
    },
    send(byte) {
      for (let i = 7; i >= 0; i--) {
        sda((byte >>> i) & 1);
        scl(1);
        scl(0);
      }
      sda(1);
      scl(1);
      const ack = !read();
      scl(0);
      return ack;
    },
    recv(ack) {
      let b = 0;
      sda(1);
      for (let i = 0; i < 8; i++) {
        scl(1);
        b = (b << 1) | read();
        scl(0);
      }
      sda(ack ? 0 : 1);
      scl(1);
      scl(0);
      sda(1);
      return b;
    },
  };
  return bus;
}
test("HEX 装载与启动向量", (u) => {
  const fw = globalThis.parseFirmware(hex);
  assert.equal(fw.format, "hex");
  assert.equal(fw.segments[0].address, 0x08000000);
  const m = setup(u);
  assert.equal(m.readWord(0x08000004), 0x08000201);
  assert.throws(() => globalThis.parseFirmware(Buffer.from(":0100000000FF\n")), /HEX/);
  assert.throws(() => globalThis.parseFirmware(Buffer.from("hello")), /ELF、AXF 或 HEX/);
  m.close();
});
test("M24C02：页写、写周期、随机读与页内回卷", (u) => {
  const m = setup(u),
    bus = i2c(m);
  bus.start();
  assert(bus.send(0xa0), "器件地址应答");
  assert(bus.send(0x0e));
  for (const v of [0x11, 0x22, 0x33]) assert(bus.send(v));
  bus.stop();
  assert.deepEqual([...m.i2c.eeprom.subarray(0x0e, 0x10)], [0x11, 0x22]);
  assert.equal(m.i2c.eeprom[0x00], 0x33, "16 字节页内回卷到 0x00");
  bus.start();
  assert(!bus.send(0xa0), "写周期内不应答");
  bus.stop();
  for (let i = 0; i < 6; i++) m.tick();
  bus.start();
  assert(bus.send(0xa0));
  assert(bus.send(0x0e));
  bus.start();
  assert(bus.send(0xa1));
  assert.equal(bus.recv(true), 0x11);
  assert.equal(bus.recv(false), 0x22);
  bus.stop();
  bus.start();
  assert(!bus.send(0x90), "不存在的地址不应答");
  bus.stop();
  m.close();
  const again = setup(u, { eeprom: m.i2c.eeprom });
  assert.equal(again.i2c.eeprom[0x0f], 0x22, "复位后 EEPROM 保持");
  again.close();
});
test("MCP4017 与 PB14 / ADC1_IN5 轮询转换", (u) => {
  const m = setup(u),
    bus = i2c(m),
    adc = 0x50000000;
  m.w(adc + 0x30, 5 << 6);
  m.w(adc + 8, 1);
  assert.equal(m.r(adc) & 1, 1, "ADRDY");
  m.w(adc + 8, 4);
  assert.equal(m.r(adc) & 4, 4, "EOC 置位");
  const before = m.r(adc + 0x40);
  assert.equal(m.r(adc) & 4, 0, "读 DR 清除 EOC");
  // 未校准：比理想值偏低 67 LSB，另有约 2 LSB 噪声
  assert(Math.abs(before - (Math.round((m.mcp().volts / 3.3) * 4095) - 67)) <= 8, "PB14 读数 " + before);
  bus.start();
  assert(bus.send(0x5e));
  assert(bus.send(0x7f));
  bus.stop();
  bus.start();
  assert(bus.send(0x5f));
  assert.equal(bus.recv(false), 0x7f);
  bus.stop();
  m.w(adc + 8, 4);
  assert(m.r(adc + 0x40) > before, "滑片增大后电压升高");
  m.close();
});
test("ADC 校准：未校准偏低约 67 LSB，ADCAL 后写入 CALFACT 并恢复", (u) => {
  const m = setup(u),
    adc = 0x50000000,
    read = () => {
      let sum = 0;
      for (let k = 0; k < 64; k++) {
        m.w(adc + 8, 5);
        sum += m.r(adc + 0x40);
      }
      return sum / 64;
    };
  m.adc[0] = 3.3;
  m.w(adc + 0x30, 11 << 6);
  m.w(adc + 8, 1);
  const raw = read();
  assert(Math.abs(raw - 4028) < 2, "未校准满量程平均约 4028，实际 " + raw.toFixed(1));
  const volts = (raw / 4096) * 3.3;
  assert(volts > 3.235 && volts < 3.255, "换算后在 3.24 / 3.25 之间（与实物一致），实际 " + volts.toFixed(4));
  m.w(adc + 8, 2);
  m.w(adc + 8, 0x80000000);
  assert.equal(m.r(adc + 0xb4) & 0x7f, 67, "校准后 CALFACT_S");
  assert.equal(m.r(adc + 8) >>> 31, 0, "ADCAL 已清除");
  m.w(adc + 8, 1);
  assert(read() > 4093, "校准后满量程接近 4095");
  m.adc[0] = 1.65;
  assert(Math.abs(read() - 2047.5) < 1.5, "校准后中点");
  m.w(adc + 8, 2);
  m.w(adc + 0xb4, 0);
  m.w(adc + 8, 1);
  assert.equal(m.adcError(0), -67, "手动把 CALFACT 写 0 回到未校准");
  m.close();
});
test("TIM2_CH1（PA15）捕获中断逐边沿响应，中断内浮点不破坏主程序", (u) => {
  const m = setup(u),
    tim = 0x40000000;
  m.af(GPIOA, 15, 1);
  m.w(tim + 0x28, 15);
  m.w(tim + 0x2c, 0xffffffff);
  m.w(tim + 0x18, 1);
  m.w(tim + 0x20, 1);
  m.w(tim + 0x0c, 2);
  m.w(0xe000e100, 1 << 28);
  m.w(tim, 1);
  m.signals.PA15.hz = 2500;
  m.step(200);
  const capture = m.readWord(0x20000004),
    count = m.readWord(0x20000008);
  assert.equal(capture, 400, "1 MHz 计数、2500 Hz 输入：周期 400");
  assert(Math.abs(count - 500) <= 2, "200 ms 内约 500 次捕获中断，实际 " + count);
  assert.equal(m.readWord(0x20000000), 0x3f800000, "主循环的 s0 仍为 1.0");
  assert.deepEqual(m.captures().find((c) => c.pin === "PA15").source, "TIM2_CH1");
  m.close();
});
test("R40 脉冲范围两端：600 Hz 与 32 kHz 捕获", (u) => {
  for (const [hz, period] of [
    [600, 1666],
    [32000, 31],
  ]) {
    const m = setup(u),
      tim = 0x40000000;
    m.af(GPIOA, 15, 1);
    m.w(tim + 0x28, 15);
    m.w(tim + 0x2c, 0xffffffff);
    m.w(tim + 0x18, 1);
    m.w(tim + 0x20, 1);
    m.w(tim + 0x0c, 2);
    m.w(0xe000e100, 1 << 28);
    m.w(tim, 1);
    m.signals.PA15.hz = hz;
    m.step(100);
    assert.equal(m.readWord(0x20000004), period, hz + " Hz 的捕获周期");
    // 第 100 ms 边界上的那个沿可能落在下一毫秒，允许差 1
    assert(Math.abs(m.readWord(0x20000008) - hz / 10) <= 1, hz + " Hz 在 100 ms 内的中断次数 " + m.readWord(0x20000008));
    m.close();
  }
});
test("新建实例的内存已初始化（Flash 为 0xFF，SRAM 为 0）", (u) => {
  let m = setup(u);
  m.writeMemory(0x20000100, 0x12345678);
  m.close();
  m = setup(u);
  assert.equal(m.readWord(0x20000100), 0);
  assert.equal(m.readWord(0x0801fff0), 0xffffffff);
  m.close();
});
test("TIM8_CH1（PA15）+ DMA 循环捕获，复位从模式", (u) => {
  const m = setup(u),
    tim = 0x40013400,
    dma = 0x40020008;
  m.af(GPIOA, 15, 2);
  m.w(tim + 0x28, 15);
  m.w(tim + 0x2c, 0xffff);
  m.w(tim + 0x18, 1);
  m.w(tim + 0x20, 1);
  m.w(tim + 0x08, 0x54);
  m.w(tim + 0x0c, 1 << 9);
  m.w(dma + 8, tim + 0x34);
  m.w(dma + 12, 0x20001000);
  m.w(dma + 4, 4);
  m.w(dma, 1 | 32 | 128 | (2 << 8) | (2 << 10));
  m.w(tim, 1);
  m.signals.PA15.hz = 4000;
  m.step(20);
  for (let i = 0; i < 4; i++) assert.equal(m.readWord(0x20001000 + i * 4), 250);
  m.close();
});
test("PWM 按引脚识别：PA7 TIM17、PA2 TIM2_CH3、PA6 TIM3 PWM2", (u) => {
  const m = setup(u);
  const pwm = (base, ch, psc, arr, ccr, mode, moe) => {
    m.w(base + 0x28, psc);
    m.w(base + 0x2c, arr);
    m.w(base + 0x30 + ch * 4, ccr);
    const reg = base + 0x18 + ((ch - 1) >> 1) * 4;
    m.w(reg, m.get(reg) | (mode << (4 + ((ch - 1) & 1) * 8)));
    m.w(base + 0x20, m.get(base + 0x20) | (1 << ((ch - 1) * 4)));
    if (moe) m.w(base + 0x44, 0x8000);
    m.w(base, 1);
  };
  m.af(GPIOA, 7, 1);
  pwm(0x40014800, 1, 15, 999, 250, 6, true);
  m.af(GPIOA, 2, 1);
  pwm(0x40000000, 3, 0, 7999, 2000, 6, false);
  m.af(GPIOA, 6, 2);
  pwm(0x40000400, 1, 15, 499, 100, 7, false);
  const out = Object.fromEntries(m.outputs().map((o) => [o.pin, o]));
  assert.equal(out.PA7.source, "TIM17_CH1");
  assert.equal(out.PA7.hz, 1000);
  assert.equal(out.PA7.duty, 25);
  assert.equal(out.PA2.source, "TIM2_CH3");
  assert.equal(out.PA2.hz, 2000);
  assert.equal(out.PA6.duty, 80, "PWM2 模式取反");
  m.w(0x40014844, 0);
  assert.equal(m.timers.pin("PA7").enabled, false, "高级定时器需要 MOE");
  m.close();
});
test("EXTI0：B1（PB0）下降沿中断", (u) => {
  const m = setup(u);
  m.w(GPIOB, m.get(GPIOB) & ~3);
  m.w(0x40010008, 1);
  m.w(0x4001040c, 1);
  m.w(0x40010400, 1);
  m.w(0xe000e100, 1 << 6);
  m.step(5);
  m.keys[0] = true;
  m.step(5);
  assert.equal(m.readWord(0x20000010), 1);
  m.keys[0] = false;
  m.step(5);
  assert.equal(m.readWord(0x20000010), 1, "仅下降沿触发");
  m.close();
});
test("超长浮点直线代码分段执行，不触发内核中止", (u) => {
  const m = setup(u);
  assert(m.runs.length >= 1, "检测到长浮点代码");
  m.step(2);
  m.writeMemory(0x2000000c, 1);
  m.step(3);
  assert.equal(m.readWord(0x20000014), 0x43200000, "160 次累加得 160.0");
  m.close();
});
test("RTC：闰年进位、星期、闹钟 A 与 LSI 分频", (u) => {
  const m = setup(u),
    rtc = 0x40002800;
  m.w(0x40021090, 0x8000 | 0x100);
  m.regs.set(rtc, 0x235959);
  m.regs.set(rtc + 4, (0x24 << 16) | (3 << 13) | (0x02 << 8) | 0x28);
  for (let i = 0; i < 1000; i++) m.tick();
  assert.equal(m.get(rtc), 0);
  assert.equal(m.get(rtc + 4), (0x24 << 16) | (4 << 13) | (0x02 << 8) | 0x29);
  m.regs.set(rtc, 0x235959);
  for (let i = 0; i < 1000; i++) m.tick();
  assert.equal(m.get(rtc + 4) & 0x1fff, 0x0301, "2 月 29 日之后是 3 月 1 日");
  m.w(rtc + 0x40, 0x80000005);
  m.w(rtc + 0x18, 0x100);
  for (let i = 0; i < 5000; i++) m.tick();
  assert.equal(m.get(rtc + 0x50) & 1, 1, "闹钟 A 标志");
  m.w(0x40021090, 0x8000 | 0x200);
  assert.equal(m.rtcPeriod(), 1024, "LSI 32 kHz、默认分频：1 秒 = 1.024 s");
  m.close();
});
test("USART1：DMA 发送与波特率", (u) => {
  const m = setup(u),
    dma = 0x40020008;
  m.writeMemory(0x20000400, 0x00216968);
  m.w(dma + 8, 0x40013828);
  m.w(dma + 12, 0x20000400);
  m.w(dma + 4, 3);
  m.w(dma, 1 | 16 | 128);
  m.w(0x40013808, 0x80);
  m.tick();
  assert.equal(m.serial, "hi!");
  m.w(0x4001380c, 1667);
  assert(Math.abs(m.baud() - 9600) < 10);
  m.close();
});
test("时序模式与 LCD 翻转显示", (u) => {
  const fast = setup(u),
    accurate = setup(u, { timing: "accurate" });
  assert.equal(fast.perMs(), 8000);
  assert.equal(accurate.perMs(), 16000, "HSI 16 MHz：每毫秒 16000 条");
  fast.close();
  accurate.close();
  const lcd = new globalThis.LCD();
  lcd.regs[7] = 3;
  lcd.command(0x22);
  lcd.data(0xffff);
  const at = (data, x, y) => data[(y * 320 + x) * 4];
  assert.equal(at(lcd.rgba(), 319, 0), 255, "默认：GRAM(0,0) 在右上角");
  lcd.regs[1] = 0x100;
  lcd.regs[0x60] = 0xa700;
  const flipped = lcd.rgba();
  assert.equal(at(flipped, 0, 239), 255, "SS+GS：旋转 180°");
  assert.equal(at(flipped, 319, 0), 0);
});
(async () => {
  const u = await require("../site/vendor/unicorn_arm.js")();
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn(u);
      console.log("PASS", name);
    } catch (e) {
      failed++;
      console.log("FAIL", name, "\n ", e.message);
    }
  }
  console.log(tests.length - failed + "/" + tests.length + " passed");
  process.exitCode = failed ? 1 : 0;
})();
