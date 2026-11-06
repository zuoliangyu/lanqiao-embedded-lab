/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  class Machine {
    constructor(uc, firmware, options = {}) {
      this.uc = uc;
      this.e = new uc.Unicorn(uc.ARCH_ARM, uc.MODE_THUMB | uc.MODE_MCLASS);
      if (this.e.ctl_set_cpu_model)
        this.e.ctl_set_cpu_model(uc.CPU_ARM_CORTEX_M4);
      this.regs = new Map();
      this.lcd = new root.LCD(options.lcdId || 0x9325);
      this.ms = 0;
      this.instructions = 0;
      this.leds = 0;
      this.keys = [false, false, false, false];
      this.adc = [1.65, 1.65];
      this.frequency = 1000;
      this.serial = "";
      this.rx = [];
      this.unknown = new Map();
      this.exception = 0;
      this.systickPending = false;
      this.frames = [];
      this.hooks = [];
      this.trace = [];
      this.options = options;
      this.dmaStates = new Map();
      this.capturePhase = 0;
      this.captureCounter = 0;
      this.rxIdle = false;
      for (const [a, s] of [
        [0x08000000, 0x20000],
        [0, 0x20000],
        [0x20000000, 0x8000],
        [0x10000000, 0x3000],
        [0x40000000, 0x30000],
        [0x48000000, 0x2000],
        [0x50000000, 0x1000],
        [0xe000e000, 0x2000],
      ])
        this.e.mem_map(a, s, uc.PROT_ALL);
      this.firmware = root.parseELF(firmware);
      for (const seg of this.firmware.segments) {
        this.e.mem_write(seg.address, seg.data);
        if (seg.address >= 0x08000000 && seg.address < 0x08020000)
          this.e.mem_write(seg.address - 0x08000000, seg.data);
      }
      const sp = this.readWord(0x08000000),
        reset = this.readWord(0x08000004);
      if (
        !(reset & 1) ||
        reset < 0x08000001 ||
        reset >= 0x08020000 ||
        sp < 0x20000000 ||
        sp > 0x20008000
      )
        throw new Error("启动向量不符合 STM32G431RB 应用程序。");
      this.e.reg_write_i32(uc.ARM_REG_MSP, sp);
      this.e.reg_write_i32(uc.ARM_REG_SP, sp);
      this.e.reg_write_i32(uc.ARM_REG_PC, reset);
      this.e.reg_write_i32(uc.ARM_REG_XPSR, 0x01000000);
      this.regs.set(0x40021000, 0x500);
      this.regs.set(0x40021008, 5);
      this.regs.set(0x4002100c, 0x1000);
      this.regs.set(0xe000ed08, 0x08000000);
      this.regs.set(0xe000ed00, 0x410fc241);
      this.regs.set(0x40007000, 0x200);
      this.regs.set(0x4000280c, 0x27);
      this.regs.set(0x40002804, 0x2101);
      for (const [lo, hi] of [
        [0x40000000, 0x4002ffff],
        [0x48000000, 0x48001fff],
        [0x50000000, 0x50000fff],
        [0xe000e000, 0xe000ffff],
      ]) {
        this.hooks.push(
          this.e.hook_add(
            uc.HOOK_MEM_READ,
            (_, type, address, size) => {
              const a = Number(address);
              this.writeMemory(a, this.readPeripheral(a, size), size);
            },
            null,
            lo,
            hi,
          ),
        );
        this.hooks.push(
          this.e.hook_add(
            uc.HOOK_MEM_WRITE,
            (_, type, address, size, value) => {
              this.writePeripheral(Number(address), Number(value), size);
            },
            null,
            lo,
            hi,
          ),
        );
      }
      this.hooks.push(
        this.e.hook_add(uc.HOOK_INTR, (_, n) => {
          if (n === 8 && this.frames.length) {
            this.returnException();
            return;
          }
          this.fault = new Error(
            "CPU 异常 " + n + "，PC=0x" + this.pc.toString(16),
          );
          this.e.emu_stop();
        }),
      );
    }
    get pc() {
      return this.e.reg_read_i32(this.uc.ARM_REG_PC) >>> 0;
    }
    readWord(a) {
      const b = this.e.mem_read(a, 4);
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }
    writeMemory(a, v, size = 4) {
      const b = new Uint8Array(size);
      for (let i = 0; i < size; i++) b[i] = v >>> (i * 8);
      this.e.mem_write(a, b);
    }
    get(a) {
      return this.regs.get(a) >>> 0;
    }
    unsupported(a) {
      const base = a & 0xfffffc00;
      if (!this.unknown.has(base))
        this.unknown.set(base, "0x" + (base >>> 0).toString(16));
    }
    known(a) {
      return (
        (a >= 0x40020000 && a < 0x40020080) ||
        (a >= 0x40020800 && a < 0x40020900) ||
        (a >= 0x40021000 && a < 0x40021100) ||
        (a >= 0x40022000 && a < 0x40022400) ||
        (a >= 0x40007000 && a < 0x40007400) ||
        (a >= 0x40002800 && a < 0x40002c00) ||
        (a >= 0x40013800 && a < 0x40013c00) ||
        (a >= 0x40012c00 && a < 0x40013000) ||
        (a >= 0x40000000 && a < 0x40000800) ||
        (a >= 0x48000000 && a < 0x48001c00) ||
        (a >= 0x50000000 && a < 0x50000400) ||
        (a >= 0xe000e000 && a < 0xe000f000) ||
        (a >= 0x40010000 && a < 0x40010800)
      );
    }
    readPeripheral(address, size) {
      const a = (address & ~3) >>> 0,
        offset = address & 3;
      let v = this.get(a);
      if (!this.known(a)) this.unsupported(a);
      if (
        a >= 0x48000000 &&
        a < 0x48001c00 &&
        ((a & 0x3ff) === 0x18 || (a & 0x3ff) === 0x28)
      )
        v = 0;
      if (a >= 0x48000000 && a < 0x48001c00 && (a & 0x3ff) === 0x10) {
        const port = (a - 0x48000000) >>> 10;
        v = this.get(a + 4);
        if (port === 0) v = (v & ~1) | (this.keys[3] ? 0 : 1);
        if (port === 1)
          v =
            (v & ~7) |
            (this.keys[0] ? 0 : 1) |
            (this.keys[1] ? 0 : 2) |
            (this.keys[2] ? 0 : 4);
        if (
          port === 2 &&
          !(this.get(0x48000414) & 512) &&
          !(this.get(0x48000014) & 256)
        )
          v = this.lcd.read();
      }
      if (a === 0x4001381c)
        v = 0x6000c0 | (this.rx.length ? 0x20 : 0) | (this.rxIdle ? 0x10 : 0);
      if (a === 0x40013824) v = this.rx.shift() || 0;
      if (a === 0x4000280c) v |= 0x27 | (v & 0x80 ? 0x40 : 0);
      if (a === 0x40007014) v = 0;
      if (a === 0x50000040 || a === 0x50000140)
        v = Math.round((this.adc[(a - 0x50000040) >>> 8] / 3.3) * 4095);
      if (a === 0xe000e010) {
        v |= this.tickFlag ? 0x10000 : 0;
        this.tickFlag = false;
      }
      if (a === 0xe000e018) v = 0;
      if (a === 0xe000ed04)
        v = this.exception | (this.systickPending ? 1 << 26 : 0);
      return size === 4
        ? v >>> 0
        : (v >>> (offset * 8)) & ((1 << (size * 8)) - 1);
    }
    writePeripheral(address, value, size) {
      const a = (address & ~3) >>> 0;
      let v = value >>> 0;
      if (size < 4) {
        const shift = (address & 3) * 8,
          mask = ((1 << (size * 8)) - 1) << shift;
        v = ((this.get(a) & ~mask) | ((v << shift) & mask)) >>> 0;
      }
      const old = this.get(a);
      this.regs.set(a, v);
      if (!this.known(a)) this.unsupported(a);
      if (this.options.trace && this.trace.length < 200)
        this.trace.push([this.pc.toString(16), a.toString(16), v.toString(16)]);
      if (a === 0x40021000)
        this.regs.set(
          a,
          ((v & ~0x02020400) |
            (v & 0x100 ? 0x400 : 0) |
            (v & 0x10000 ? 0x20000 : 0) |
            (v & 0x1000000 ? 0x2000000 : 0)) >>>
            0,
        );
      if (a === 0x40021008) this.regs.set(a, (v & ~12) | ((v & 3) << 2));
      if (a === 0x40021090 || a === 0x40021094)
        this.regs.set(a, (v & ~2) | ((v & 1) << 1));
      if (a === 0x50000000 || a === 0x50000100) this.regs.set(a, old & ~v);
      if (a === 0x50000008 || a === 0x50000108) {
        this.regs.set(
          a,
          v & 16 ? v & ~0x8000001f : (v | (old & 1)) & ~0x80000000,
        );
        if (v & 1) this.regs.set(a - 8, this.get(a - 8) | 1);
      }
      if (a >= 0x48000000 && a < 0x48001c00) {
        const base = a & ~0x3ff,
          off = a & 0x3ff;
        let odr = this.get(base + 0x14);
        if (off === 0x18) {
          odr = (odr | (v & 65535)) & ~(v >>> 16);
          this.regs.set(base + 0x14, odr);
        }
        if (off === 0x28) {
          odr &= ~v;
          this.regs.set(base + 0x14, odr);
        }
        if (off === 0x14 || off === 0x18 || off === 0x28)
          this.gpioChanged(base, odr);
      }
      if (a === 0x40013828) this.serial += String.fromCharCode(v & 255);
      if (a === 0x40013820) {
        if (v & 0x10) this.rxIdle = false;
      }
      if (a >= 0x40020008 && a < 0x40020080) {
        const channel = Math.floor((a - 0x40020008) / 20),
          base = 0x40020008 + channel * 20;
        if (a === base + 4) this.dmaStates.set(channel, { count: v, index: 0 });
      }
      if (a === 0x40020004) {
        this.regs.set(0x40020000, this.get(0x40020000) & ~v);
      }
      if (a >= 0xe000e100 && a < 0xe000e10c) this.regs.set(a, old | v);
      if (a >= 0xe000e180 && a < 0xe000e18c)
        this.regs.set(a - 0x80, this.get(a - 0x80) & ~v);
      if (a === 0xe000e014) this.tickPhase = 0;
      if (a === 0xe000e018) this.tickFlag = false;
      if (a === 0xe000ed04) {
        if (v & (1 << 26)) this.systickPending = true;
        if (v & (1 << 25)) this.systickPending = false;
      }
    }
    gpioChanged(base, odr) {
      if (base === 0x48000400) {
        const previous = this.lastB || 0;
        this.lastB = odr;
        if (!(odr & 512) && !(previous & 32) && odr & 32) {
          const data = this.get(0x48000814) & 65535;
          if (odr & 256) this.lcd.data(data);
          else this.lcd.command(data);
        }
      }
      if (this.get(0x48000c14) & 4)
        this.leds = (~this.get(0x48000814) >>> 8) & 255;
    }
    enterException(number) {
      const u = this.uc,
        e = this.e;
      const handler = this.readWord(
        (this.get(0xe000ed08) || 0x08000000) + number * 4,
      );
      if (!(handler & 1) || handler < 0x08000000 || handler >= 0x08020000)
        throw new Error("无效中断向量 " + number);
      const names = ["R0", "R1", "R2", "R3", "R12", "LR", "PC", "XPSR"];
      let sp = e.reg_read_i32(u.ARM_REG_SP) >>> 0;
      const align = sp & 4;
      sp -= 32 + align;
      names.forEach((name, i) =>
        this.writeMemory(
          sp + i * 4,
          (e.reg_read_i32(u["ARM_REG_" + name]) |
            (name === "XPSR" && align ? 512 : 0)) >>>
            0,
        ),
      );
      this.frames.push({ sp, number, previous: this.exception });
      this.exception = number;
      e.reg_write_i32(u.ARM_REG_SP, sp);
      e.reg_write_i32(u.ARM_REG_LR, 0xfffffff9);
      e.reg_write_i32(
        u.ARM_REG_XPSR,
        (e.reg_read_i32(u.ARM_REG_XPSR) & 0xf8000000) | 0x01000000 | number,
      );
      e.reg_write_i32(u.ARM_REG_PC, handler);
    }
    returnException() {
      const f = this.frames.pop(),
        u = this.uc,
        e = this.e,
        sp = e.reg_read_i32(u.ARM_REG_SP) >>> 0;
      const values = Array.from({ length: 8 }, (_, i) =>
        this.readWord(sp + i * 4),
      );
      ["R0", "R1", "R2", "R3", "R12", "LR"].forEach((name, i) =>
        e.reg_write_i32(u["ARM_REG_" + name], values[i]),
      );
      e.reg_write_i32(u.ARM_REG_XPSR, values[7] & ~512);
      e.reg_write_i32(u.ARM_REG_SP, sp + 32 + (values[7] & 512 ? 4 : 0));
      e.reg_write_i32(u.ARM_REG_PC, values[6] | 1);
      this.exception = f.previous;
      if (this.servicing) this.e.emu_stop();
    }
    dmaRequest(peripheral, value) {
      for (let ch = 0; ch < 6; ch++) {
        const base = 0x40020008 + ch * 20,
          cfg = this.get(base),
          state = this.dmaStates.get(ch);
        if (
          !(cfg & 1) ||
          cfg & 16 ||
          this.get(base + 8) !== peripheral ||
          !state ||
          !state.count
        )
          continue;
        const width = 1 << ((cfg >>> 10) & 3),
          pointer = this.get(base + 12) + (cfg & 128 ? state.index * width : 0);
        if (width > 4 || pointer < 0x20000000 || pointer + width > 0x20008000)
          throw new Error("DMA 写入地址无效：0x" + pointer.toString(16));
        this.writeMemory(pointer, value, width);
        state.index++;
        this.regs.set(base + 4, state.count - state.index);
        let flag = 0;
        if (state.index === Math.floor(state.count / 2)) flag = 5;
        if (state.index >= state.count) {
          flag = 3;
          state.index = 0;
          if (cfg & 32) this.regs.set(base + 4, state.count);
          else this.regs.set(base, cfg & ~1);
        }
        if (flag)
          this.regs.set(0x40020000, this.get(0x40020000) | (flag << (ch * 4)));
      }
    }
    clockHz() {
      const cfgr = this.get(0x40021008),
        pll = this.get(0x4002100c),
        src = cfgr & 3;
      if (src === 2) return 24000000;
      if (src !== 3) return 16000000;
      return (
        ((((pll & 3) === 3 ? 24000000 : 16000000) / (((pll >>> 4) & 15) + 1)) *
          ((pll >>> 8) & 127)) /
        ((((pll >>> 25) & 3) + 1) * 2)
      );
    }
    pwm(base, channel) {
      const arr = this.get(base + 0x2c) + 1,
        psc = this.get(base + 0x28) + 1,
        ccr = this.get(base + 0x34 + (channel - 1) * 4);
      return {
        enabled:
          !!(this.get(base) & 1) &&
          !!(this.get(base + 0x20) & (1 << ((channel - 1) * 4))),
        hz: this.clockHz() / psc / arr,
        duty: Math.min(100, (ccr / arr) * 100),
      };
    }
    nextIRQ() {
      const enabled = (n) =>
        !!(this.get(0xe000e100 + 4 * Math.floor(n / 32)) & (1 << (n % 32)));
      for (let ch = 0; ch < 6; ch++) {
        const cfg = this.get(0x40020008 + ch * 20),
          flags = (this.get(0x40020000) >>> (ch * 4)) & 15;
        if (
          enabled(11 + ch) &&
          ((flags & 2 && cfg & 2) || (flags & 4 && cfg & 4))
        )
          return 27 + ch;
      }
      const cr = this.get(0x40013800);
      if (
        enabled(37) &&
        ((cr & 32 && this.rx.length) || (cr & 16 && this.rxIdle))
      )
        return 53;
      return 0;
    }
    service(number) {
      this.servicing = true;
      this.enterException(number);
      try {
        this.e.emu_start(this.pc | 1, 0, 0, 8000);
        if (this.fault) throw this.fault;
      } finally {
        this.servicing = false;
      }
    }
    tick() {
      this.ms++;
      if (this.get(0xe000e010) & 1) {
        const period = (this.get(0xe000e014) & 0xffffff) + 1;
        this.tickPhase =
          (this.tickPhase || 0) +
          this.clockHz() / 1000 / (this.get(0xe000e010) & 4 ? 1 : 8);
        if (this.tickPhase >= period) {
          this.tickPhase %= period;
          this.tickFlag = true;
          if (this.get(0xe000e010) & 2) this.systickPending = true;
        }
      }
      if (this.ms % 1000 === 0 && this.get(0x40021090) & 0x8000) {
        const a = 0x40002800,
          v = this.get(a),
          dec = (x) => (x & 15) + 10 * (x >>> 4),
          bcd = (x) => Math.floor(x / 10) * 16 + (x % 10);
        let t =
          (dec(v & 127) +
            dec((v >>> 8) & 127) * 60 +
            dec((v >>> 16) & 63) * 3600 +
            1) %
          86400;
        this.regs.set(
          a,
          bcd(t % 60) |
            (bcd(Math.floor(t / 60) % 60) << 8) |
            (bcd(Math.floor(t / 3600)) << 16),
        );
      }
      for (let i = 0; i < 2; i++)
        if ((this.get(0x50000008 + i * 256) & 5) === 5) {
          const val = Math.round((this.adc[i] / 3.3) * 4095);
          for (let n = 0; n < 30; n++)
            this.dmaRequest(0x50000040 + i * 256, val);
        }
      if (
        this.get(0x40000400) & 1 &&
        this.get(0x40000420) & 1 &&
        this.frequency > 0
      ) {
        this.capturePhase += this.frequency / 1000;
        const period =
          this.clockHz() / (this.get(0x40000428) + 1) / this.frequency;
        while (this.capturePhase >= 1) {
          this.capturePhase--;
          this.captureCounter =
            (this.captureCounter + period) % (this.get(0x4000042c) + 1);
          const capture =
            (this.get(0x40000408) & 7) === 4
              ? Math.round(period)
              : Math.round(this.captureCounter);
          this.regs.set(0x40000434, capture);
          if (this.get(0x4000040c) & 512) this.dmaRequest(0x40000434, capture);
        }
      }
      if (this.rx.length && this.get(0x40013808) & 64) {
        const n = this.rx.length;
        for (let i = 0; i < n; i++) {
          const v = this.rx.shift();
          this.dmaRequest(0x40013824, v);
        }
        this.rxIdle = true;
      }
    }
    step(quanta = 1) {
      for (let i = 0; i < quanta; i++) {
        if (!this.exception && !this.e.reg_read_i32(this.uc.ARM_REG_PRIMASK)) {
          if (this.systickPending) {
            this.systickPending = false;
            this.service(15);
          }
          for (let j = 0; j < 8 && !this.exception; j++) {
            const n = this.nextIRQ();
            if (!n) break;
            this.service(n);
          }
        }
        this.e.emu_start(this.pc | 1, 0, 0, 8000);
        this.instructions += 8000;
        if (this.fault) throw this.fault;
        this.tick();
      }
    }
    close() {
      for (const h of this.hooks) this.e.hook_del(h);
      this.e.close();
    }
  }
  root.Machine = Machine;
  if (typeof module !== "undefined") module.exports = { Machine };
})(globalThis);
