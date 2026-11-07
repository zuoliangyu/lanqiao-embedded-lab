/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  // G431 定时器：基址、APB 总线、通道数、计数位宽与中断号。
  // TIM1/TIM8 的更新、捕获、触发/换相、刹车各自占一个中断。
  const TIMERS = [
    { name: "TIM1", base: 0x40012c00, apb: 2, ch: 4, bits: 16, moe: true,
      irq: { up: 25, cc: 27, trg: 26, brk: 24 } },
    { name: "TIM2", base: 0x40000000, apb: 1, ch: 4, bits: 32, irq: 28 },
    { name: "TIM3", base: 0x40000400, apb: 1, ch: 4, bits: 16, irq: 29 },
    { name: "TIM4", base: 0x40000800, apb: 1, ch: 4, bits: 16, irq: 30 },
    { name: "TIM6", base: 0x40001000, apb: 1, ch: 0, bits: 16, irq: 54 },
    { name: "TIM7", base: 0x40001400, apb: 1, ch: 0, bits: 16, irq: 55 },
    { name: "TIM8", base: 0x40013400, apb: 2, ch: 4, bits: 16, moe: true,
      irq: { up: 44, cc: 46, trg: 45, brk: 43 } },
    { name: "TIM15", base: 0x40014000, apb: 2, ch: 2, bits: 16, moe: true, irq: 24 },
    { name: "TIM16", base: 0x40014400, apb: 2, ch: 1, bits: 16, moe: true, irq: 25 },
    { name: "TIM17", base: 0x40014800, apb: 2, ch: 1, bits: 16, moe: true, irq: 26 },
  ];
  // 竞赛板相关引脚的复用功能：AF 编号 → [定时器, 通道, 是否互补输出]。
  const PIN_AF = {
    PA1: { 1: ["TIM2", 2], 9: ["TIM15", 1, true] },
    PA2: { 1: ["TIM2", 3], 9: ["TIM15", 1] },
    PA3: { 1: ["TIM2", 4], 9: ["TIM15", 2] },
    PA6: { 1: ["TIM16", 1], 2: ["TIM3", 1] },
    PA7: { 1: ["TIM17", 1], 2: ["TIM3", 2], 4: ["TIM8", 1, true], 6: ["TIM1", 1, true] },
    PA15: { 1: ["TIM2", 1], 2: ["TIM8", 1] },
    PB4: { 1: ["TIM16", 1], 2: ["TIM3", 1], 4: ["TIM8", 2, true] },
    PC0: { 2: ["TIM1", 1] },
  };
  const PORTS = "ABCDEFG";
  class Timers {
    constructor(machine) {
      this.m = machine;
      this.list = TIMERS.map((t) => ({ ...t, cnt: 0, rep: 0, div: [0, 0, 0, 0] }));
      this.byBase = new Map(this.list.map((t) => [t.base, t]));
      this.byName = new Map(this.list.map((t) => [t.name, t]));
    }
    at(a) {
      return this.byBase.get((a & ~0x3ff) >>> 0);
    }
    mask(t) {
      return t.bits === 32 ? 0xffffffff : 0xffff;
    }
    read(t, off, v) {
      return off === 0x24 ? (Math.floor(t.cnt + 1e-6) & this.mask(t)) >>> 0 : v;
    }
    write(t, off, v, old) {
      const r = this.m.regs,
        b = t.base;
      if (off === 0x10) r.set(b + 0x10, (old & v) >>> 0);
      if (off === 0x24) t.cnt = (v & this.mask(t)) >>> 0;
      if (off === 0x14) {
        r.set(b + 0x14, 0);
        let sr = this.m.get(b + 0x10) | (v & 0x1e);
        if (v & 1) {
          t.cnt = 0;
          t.rep = 0;
          if (!(this.m.get(b) & 4)) sr |= 1;
        }
        r.set(b + 0x10, sr >>> 0);
      }
    }
    // 每个仿真毫秒推进一次：按时间顺序处理输入边沿、捕获和溢出。
    tick(edges) {
      const m = this.m;
      for (const t of this.list) {
        const b = t.base;
        if (!(m.get(b) & 1)) continue;
        const rate = m.timerClock(t.apb) / ((m.get(b + 0x28) & 0xffff) + 1) / 1000,
          inputs = t.ch ? this.inputs(t, edges) : [];
        let now = 0;
        for (const e of inputs) {
          this.count(t, (e.at - now) * rate);
          now = e.at;
          this.edge(t, e);
        }
        this.count(t, (1 - now) * rate);
      }
    }
    count(t, n) {
      const m = this.m,
        b = t.base,
        period = ((m.get(b + 0x2c) & this.mask(t)) >>> 0) + 1;
      if (period < 2) return;
      t.cnt += n;
      if (t.cnt < period) return;
      const wraps = Math.floor(t.cnt / period);
      t.cnt -= wraps * period;
      if (m.get(b) & 2) return;
      const every = t.moe ? (m.get(b + 0x30) & 0xffff) + 1 : 1;
      t.rep += wraps;
      if (t.rep >= every) {
        t.rep %= every;
        m.regs.set(b + 0x10, m.get(b + 0x10) | 1);
      }
    }
    // 找出接到本定时器 TIx 的外部信号边沿。
    inputs(t, edges) {
      const list = [];
      for (const [pin, events] of edges) {
        const route = this.route(pin);
        if (!route || route[0] !== t.name || route[2]) continue;
        for (const e of events) list.push({ at: e.at, rising: e.rising, ti: route[1] });
      }
      return list.sort((a, b) => a.at - b.at);
    }
    route(pin) {
      const m = this.m,
        port = PORTS.indexOf(pin[1]),
        n = Number(pin.slice(2)),
        base = 0x48000000 + port * 0x400;
      if (((m.get(base) >>> (n * 2)) & 3) !== 2) return null;
      const af = (m.get(base + 0x20 + (n >> 3) * 4) >>> ((n & 7) * 4)) & 15;
      return (PIN_AF[pin] && PIN_AF[pin][af]) || null;
    }
    polarity(ccer, ch, rising) {
      const p = (ccer >>> ((ch - 1) * 4 + 1)) & 1,
        np = (ccer >>> ((ch - 1) * 4 + 3)) & 1;
      return p && np ? true : p ? !rising : rising;
    }
    edge(t, e) {
      const m = this.m,
        b = t.base,
        ccer = m.get(b + 0x20),
        dier = m.get(b + 0x0c);
      for (let ch = 1; ch <= t.ch; ch++) {
        const mr = m.get(b + 0x18 + ((ch - 1) >> 1) * 4) >>> (((ch - 1) & 1) * 8),
          ccs = mr & 3;
        if (!ccs || ccs === 3 || !(ccer & (1 << ((ch - 1) * 4)))) continue;
        if ((ccs === 1 ? ch : ((ch - 1) ^ 1) + 1) !== e.ti) continue;
        if (!this.polarity(ccer, ch, e.rising)) continue;
        if (++t.div[ch - 1] < 1 << ((mr >>> 2) & 3)) continue;
        t.div[ch - 1] = 0;
        const value = (Math.floor(t.cnt + 1e-6) & this.mask(t)) >>> 0,
          ccr = b + 0x30 + ch * 4;
        m.regs.set(ccr, value >>> 0);
        let sr = m.get(b + 0x10);
        if (sr & (1 << ch)) sr |= 1 << (ch + 8);
        m.regs.set(b + 0x10, (sr | (1 << ch)) >>> 0);
        if (dier & (1 << (ch + 8))) m.dmaRequest(ccr, value);
        if (dier & (1 << ch)) m.interruptNow(this.ccIRQ(t) + 16);
      }
      const smcr = m.get(b + 8),
        sms = (smcr & 7) | ((smcr >>> 13) & 8),
        ts = ((smcr >>> 4) & 7) | ((smcr >>> 17) & 0x18);
      if (
        sms === 4 &&
        ((ts === 4 && e.ti === 1) ||
          (ts === 5 && e.ti === 1 && this.polarity(ccer, 1, e.rising)) ||
          (ts === 6 && e.ti === 2 && this.polarity(ccer, 2, e.rising)))
      )
        t.cnt = 0;
    }
    ccIRQ(t) {
      return typeof t.irq === "number" ? t.irq : t.irq.cc;
    }
    // 当前请求的中断号（IRQn），由 SR 与 DIER 共同决定。
    pending(out) {
      const m = this.m;
      for (const t of this.list) {
        const f = m.get(t.base + 0x10) & m.get(t.base + 0x0c) & 0xff;
        if (!f) continue;
        if (typeof t.irq === "number") out.add(t.irq);
        else {
          if (f & 1) out.add(t.irq.up);
          if (f & 0x1e) out.add(t.irq.cc);
          if (f & 0x60) out.add(t.irq.trg);
          if (f & 0x80) out.add(t.irq.brk);
        }
      }
    }
    pwm(t, ch, comp = false) {
      const m = this.m,
        b = t.base,
        cr1 = m.get(b),
        ccer = m.get(b + 0x20),
        arr = ((m.get(b + 0x2c) & this.mask(t)) >>> 0) + 1,
        reg = m.get(b + 0x18 + ((ch - 1) >> 1) * 4),
        mr = reg >>> (((ch - 1) & 1) * 8),
        mode = ((mr >>> 4) & 7) | (((reg >>> (16 + ((ch - 1) & 1) * 8)) & 1) << 3),
        en = 1 << ((ch - 1) * 4 + (comp ? 2 : 0)),
        center = (cr1 >>> 5) & 3;
      let hz = m.timerClock(t.apb) / ((m.get(b + 0x28) & 0xffff) + 1) / arr / (center ? 2 : 1),
        duty = null;
      const ccr = m.get(b + 0x30 + ch * 4);
      if (mode === 6) duty = Math.min(ccr, arr) / arr;
      else if (mode === 7) duty = 1 - Math.min(ccr, arr) / arr;
      else if (mode === 4) duty = 0;
      else if (mode === 5) duty = 1;
      else if (mode === 3) {
        duty = 0.5;
        hz /= 2;
      }
      if (duty !== null && ccer & (en << 1)) duty = 1 - duty;
      if (duty !== null && comp) duty = 1 - duty;
      return {
        enabled:
          !!(cr1 & 1) &&
          !!(ccer & en) &&
          !(mr & 3) &&
          !(t.moe && !(m.get(b + 0x44) & 0x8000)),
        hz,
        duty: duty === null ? null : duty * 100,
        mode,
      };
    }
    // 引脚当前的输出状态：定时器 PWM、GPIO 电平或未配置。
    pin(name) {
      const m = this.m,
        port = PORTS.indexOf(name[1]),
        n = Number(name.slice(2)),
        base = 0x48000000 + port * 0x400,
        mode = (m.get(base) >>> (n * 2)) & 3;
      if (mode === 1) return { pin: name, kind: "gpio", level: (m.get(base + 0x14) >>> n) & 1 };
      if (mode !== 2) return { pin: name, kind: mode === 3 ? "analog" : "input" };
      const af = (m.get(base + 0x20 + (n >> 3) * 4) >>> ((n & 7) * 4)) & 15,
        route = PIN_AF[name] && PIN_AF[name][af];
      if (!route) return { pin: name, kind: "af", af };
      const t = this.byName.get(route[0]),
        mr = m.get(t.base + 0x18 + ((route[1] - 1) >> 1) * 4) >>> (((route[1] - 1) & 1) * 8);
      const source = route[0] + "_CH" + route[1] + (route[2] ? "N" : "");
      if (mr & 3) return { pin: name, kind: "capture", af, source };
      return { pin: name, kind: "timer", af, source, ...this.pwm(t, route[1], !!route[2]) };
    }
  }
  root.Timers = Timers;
  root.TIMER_PINS = Object.keys(PIN_AF);
  if (typeof module !== "undefined") module.exports = { Timers };
})(globalThis);
