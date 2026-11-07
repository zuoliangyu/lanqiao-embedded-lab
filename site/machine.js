/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  // 快速模式下每个仿真毫秒执行的指令数；精确模式按 HCLK 计算。
  const FAST_IPMS = 8000;
  const ADC_BASE = [0x50000000, 0x50000100];
  // ADC 自校准消除的是偏移误差（RM0440 21.4.8）。上电时 CALFACT=0，未校准的读数整体偏低；
  // 按 CT117E 实测：R37/R38 拧到 3.3 V 时，未校准平均约 4028，即偏低约 67 LSB。
  const ADC_CALFACT = [67, 67],
    ADC_NOISE_LSB = 2;
  const HSE = 24000000;
  class Machine {
    constructor(uc, firmware, options = {}) {
      this.uc = uc;
      this.e = new uc.Unicorn(uc.ARCH_ARM, uc.MODE_THUMB | uc.MODE_MCLASS);
      if (this.e.ctl_set_cpu_model)
        this.e.ctl_set_cpu_model(uc.CPU_ARM_CORTEX_M4);
      this.regs = new Map();
      this.handle = uc.getValue(this.e.handle_ptr, "*");
      this.scratch = uc._malloc(8);
      this.lcd = new root.LCD(options.lcdId || 0x9325);
      this.timing = options.timing === "accurate" ? "accurate" : "fast";
      this.ms = 0;
      this.instructions = 0;
      this.leds = 0;
      this.keys = [false, false, false, false];
      this.keyReads = [0, 0, 0, 0];
      this.keyReadMs = [-1, -1, -1, -1];
      this.keyRelease = [false, false, false, false];
      this.keyDownAt = [null, null, null, null];
      this.lastHold = [0, 0, 0, 0];
      this.adc = [1.65, 1.65];
      this.signals = {
        PB4: { hz: 1000, duty: 0.5, phase: 0 },
        PA15: { hz: 1000, duty: 0.5, phase: 0 },
      };
      this.mcpOhms = options.mcpOhms || 100000;
      this.serial = "";
      this.rx = [];
      this.unknown = new Map();
      this.exception = 0;
      this.systickPending = false;
      this.pendsv = false;
      this.swPending = new Set();
      this.frames = [];
      this.hooks = [];
      this.trace = [];
      this.options = options;
      this.dmaStates = new Map();
      this.adcIndex = [0, 0];
      this.seed = (options.seed || 0x2024) >>> 0;
      this.rxIdle = false;
      this.rtcMs = 0;
      this.extiLevels = -1;
      this.isrUsed = 0;
      this.budget = 0;
      this.serviceDepth = -1;
      this.costs = new Map();
      this.flash = new Uint8Array(0x20000);
      this.fpRegs = Array.from({ length: 16 }, (_, i) => uc["ARM_REG_S" + i]);
      this.i2c = new root.I2CBus(() => this.ms, options.eeprom, options.wiper);
      this.timers = new root.Timers(this);
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
      // Unicorn.js 在同一进程里新建实例时会复用旧实例未清零的内存：Flash 置为擦除态，其余清零。
      for (const [a, s] of [
        [0x08000000, 0x20000],
        [0, 0x20000],
      ])
        this.e.mem_write(a, new Uint8Array(s).fill(0xff));
      for (const [a, s] of [
        [0x20000000, 0x8000],
        [0x10000000, 0x3000],
        [0x40000000, 0x30000],
        [0x48000000, 0x2000],
        [0x50000000, 0x1000],
        [0xe000e000, 0x2000],
      ])
        this.e.mem_write(a, new Uint8Array(s));
      this.firmware = root.parseFirmware(firmware);
      for (const seg of this.firmware.segments) {
        this.e.mem_write(seg.address, seg.data);
        if (seg.address >= 0x08000000 && seg.address < 0x08020000) {
          this.e.mem_write(seg.address - 0x08000000, seg.data);
          this.flash.set(seg.data, seg.address - 0x08000000);
        }
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
      for (const [a, v] of [
        [0x40021000, 0x500],
        [0x40021008, 5],
        [0x4002100c, 0x1000],
        [0xe000ed08, 0x08000000],
        [0xe000ed00, 0x410fc241],
        [0x40007000, 0x200],
        [0x4000280c, 0x27],
        [0x40002804, 0x2101],
        [0x40002810, 0x007f00ff],
        [0x48000000, 0xabffffff],
        [0x48000400, 0xfffffebf],
        [0x4800000c, 0x64000000],
        [0x4800040c, 0x100],
      ])
        this.regs.set(a, v);
      for (let p = 2; p < 7; p++) this.regs.set(0x48000000 + p * 0x400, 0xffffffff);
      for (const t of this.timers.list)
        this.regs.set(t.base + 0x2c, t.bits === 32 ? 0xffffffff : 0xffff);
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
      // 用基本块钩子计数，不用 emu_start 的指令计数模式：后者在部分地址取指失败。
      this.hooks.push(
        this.e.hook_add(
          uc.HOOK_BLOCK,
          (_, address, size) => {
            this.budget -= this.cost(Number(address), size);
            if (this.budget <= 0) this.stop();
            else if (this.guard) this.guardBlock(Number(address));
          },
          null,
          1,
          0,
        ),
      );
      this.hooks.push(
        this.e.hook_add(uc.HOOK_INTR, (_, n) => {
          if (n === 8 && this.frames.length) {
            this.returnException();
            return;
          }
          this.fault = new Error(
            "CPU 异常 " + n + "，PC=0x" + this.pc.toString(16),
          );
          this.stop();
        }),
      );
      // Unicorn.js 翻译含上百条连续浮点指令的基本块时会中止（常见于 -O3 展开的累加循环）。
      // 这些代码所在的页设为不可执行，进入时逐块执行并用 until 截短翻译长度。
      this.runs = this.longFloatRuns();
      this.guards = new Set();
      for (const r of this.runs)
        for (let page = r.start & ~0x3ff; page < r.end; page += 0x400) this.guards.add(page >>> 0);
      for (const page of this.guards)
        this.e.mem_protect(page, 0x400, uc.PROT_READ | uc.PROT_WRITE);
    }
    get pc() {
      return this.e.reg_read_i32(this.uc.ARM_REG_PC) >>> 0;
    }
    get frequency() {
      return this.signals.PB4.hz;
    }
    set frequency(hz) {
      this.signals.PB4.hz = hz;
    }
    readWord(a) {
      const b = this.e.mem_read(a, 4);
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }
    // 外设读钩子每次都要把计算值写回模拟内存；绕过包装函数的 malloc/ccall，开销约为其 1/6。
    writeMemory(a, v, size = 4) {
      this.uc.setValue(this.scratch, v | 0, "i32");
      this.uc._uc_mem_write(this.handle, BigInt(a), this.scratch, BigInt(size));
    }
    get(a) {
      return this.regs.get(a) >>> 0;
    }
    cost(a, size) {
      let n = this.costs.get(a);
      if (n !== undefined) return n;
      const off = a >= 0x08000000 ? a - 0x08000000 : a;
      if ((a < 0x20000 || a >= 0x08000000) && off + size <= 0x20000) {
        n = 0;
        for (let p = off, end = off + size; p < end; n++)
          p += (this.flash[p + 1] & 0xf8) >= 0xe8 ? 4 : 2;
        n = Math.max(1, n);
        this.costs.set(a, n);
        return n;
      }
      return Math.max(1, Math.round(size / 3));
    }
    insnLength(a) {
      return (this.flash[a - 0x08000000 + 1] & 0xf8) >= 0xe8 ? 4 : 2;
    }
    // 线性扫描 Flash，找出超过 64 条浮点指令且中间没有跳转的直线代码，
    // 每 16 条指令设一个分段点。
    longFloatRuns() {
      const f = this.flash,
        end = this.firmware.segments.reduce(
          (m, s) => (s.address >= 0x08000000 && s.address < 0x08020000 ? Math.max(m, s.address - 0x08000000 + s.data.length) : m),
          0,
        ),
        runs = [];
      let p = 0,
        start = 0,
        fp = 0,
        marks = [];
      while (p + 4 <= end) {
        const h1 = f[p] | (f[p + 1] << 8);
        marks.push(p);
        let branch = false;
        if ((h1 & 0xf800) >= 0xe800) {
          const h2 = f[p + 2] | (f[p + 3] << 8);
          if ((h1 & 0xf800) === 0xf000 && h2 & 0x8000) branch = true;
          if ((h1 & 0xfff0) === 0xe8d0 && (h2 & 0xffe0) === 0xf000) branch = true;
          if ((h1 & 0xffd0) === 0xe890 && h2 & 0x8000) branch = true;
          if ((h1 & 0xec00) === 0xec00) fp++;
          p += 4;
        } else {
          if ((h1 & 0xf000) === 0xd000 && (h1 & 0x0e00) !== 0x0e00) branch = true;
          if ((h1 & 0xf800) === 0xe000) branch = true;
          if ((h1 & 0xff00) === 0x4700 || (h1 & 0xff87) === 0x4687) branch = true;
          if ((h1 & 0xf500) === 0xb100 || (h1 & 0xff00) === 0xbd00) branch = true;
          p += 2;
        }
        if (!branch) continue;
        if (fp > 64)
          runs.push({
            start: 0x08000000 + start,
            end: 0x08000000 + p,
            splits: marks.filter((_, i) => i && i % 16 === 0).map((x) => 0x08000000 + x),
          });
        start = p;
        fp = 0;
        marks = [];
      }
      return runs;
    }
    // 受保护页；跨页的 32 位指令也算进入下一页。
    guardPage(pc) {
      const page = (pc & ~0x3ff) >>> 0;
      if (this.guards.has(page)) return page;
      if (pc >= page + 0x3fc && this.guards.has(page + 0x400)) return page + 0x400;
      return 0;
    }
    runAt(a) {
      return this.runs.find((r) => a >= r.start && a < r.end) || null;
    }
    // 下一次 emu_start 的 until：位于长直线代码内时取下一个分段点，否则取本页内首段的分段点。
    untilFor(pc, page) {
      const run = this.runAt(pc) || this.runs.find((r) => r.end > page && r.start < page + 0x400 && r.start >= pc) ||
        this.runs.find((r) => r.end > page && r.start < page + 0x400);
      const next = run && run.splits.find((s) => s > pc);
      return next || (run && run.end > pc ? run.end : 0);
    }
    stop() {
      this.halt = true;
      this.e.emu_stop();
    }
    guarded(page) {
      const u = this.uc;
      this.e.mem_protect(page, 0x400, u.PROT_ALL);
      try {
        while (!this.halt && !this.fault && this.guardPage(this.pc) === page) {
          this.guard = { page, run: this.runAt(this.pc), first: true };
          const pc = this.pc,
            next = page + 0x400;
          // 跨页的 32 位指令：只为这一条临时放开下一页。
          if (pc + this.insnLength(pc) > next && this.guards.has(next)) {
            this.e.mem_protect(next, 0x400, u.PROT_ALL);
            try {
              this.e.emu_start(pc | 1, pc + 4, 0, 0);
            } finally {
              this.e.mem_protect(next, 0x400, u.PROT_READ | u.PROT_WRITE);
            }
          } else this.e.emu_start(pc | 1, this.untilFor(pc, page), 0, 0);
        }
      } finally {
        this.guard = null;
        this.e.mem_protect(page, 0x400, u.PROT_READ | u.PROT_WRITE);
      }
    }
    // 受保护页内：离开本页或离开当前长直线代码时停一次，重新选择 until。
    guardBlock(a) {
      const g = this.guard;
      if (g.first) {
        g.first = false;
        return;
      }
      if ((a & ~0x3ff) >>> 0 !== g.page || this.runAt(a) !== g.run) this.e.emu_stop();
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
        (a >= 0x40002400 && a < 0x40002c00) ||
        (a >= 0x40013800 && a < 0x40013c00) ||
        (a >= 0x40012c00 && a < 0x40013000) ||
        (a >= 0x40013400 && a < 0x40013800) ||
        (a >= 0x40014000 && a < 0x40014c00) ||
        (a >= 0x40000000 && a < 0x40000c00) ||
        (a >= 0x40001000 && a < 0x40001800) ||
        (a >= 0x48000000 && a < 0x48001c00) ||
        (a >= 0x50000000 && a < 0x50000400) ||
        (a >= 0xe000e000 && a < 0xe000f000) ||
        (a >= 0x40010000 && a < 0x40010800)
      );
    }
    // ---- 时钟树 ----
    sysclk() {
      const cfgr = this.get(0x40021008),
        pll = this.get(0x4002100c),
        src = cfgr & 3;
      if (src === 2) return HSE;
      if (src !== 3) return 16000000;
      return (
        ((((pll & 3) === 3 ? HSE : 16000000) / (((pll >>> 4) & 15) + 1)) *
          ((pll >>> 8) & 127)) /
        ((((pll >>> 25) & 3) + 1) * 2)
      );
    }
    clockHz() {
      return this.sysclk();
    }
    hclk() {
      const h = (this.get(0x40021008) >>> 4) & 15;
      return this.sysclk() / (h < 8 ? 1 : [2, 4, 8, 16, 64, 128, 256, 512][h - 8]);
    }
    apbDiv(n) {
      const p = (this.get(0x40021008) >>> (n === 1 ? 8 : 11)) & 7;
      return p < 4 ? 1 : 1 << (p - 3);
    }
    pclk(n) {
      return this.hclk() / this.apbDiv(n);
    }
    timerClock(n) {
      const d = this.apbDiv(n);
      return (this.hclk() / d) * (d === 1 ? 1 : 2);
    }
    perMs() {
      return this.timing === "accurate"
        ? Math.max(1000, Math.round(this.hclk() / 1000))
        : FAST_IPMS;
    }
    baud() {
      const sel = this.get(0x40021088) & 3,
        clk = [this.pclk(2), this.sysclk(), 16000000, 32768][sel],
        presc = [1, 2, 4, 6, 8, 10, 12, 16, 32, 64, 128, 256][this.get(0x4001382c) & 15] || 1,
        brr = this.get(0x4001380c) & 0xffff,
        over8 = this.get(0x40013800) & 0x8000;
      if (!brr) return 0;
      return over8
        ? (2 * clk) / presc / ((brr & 0xfff0) | ((brr & 7) << 1))
        : clk / presc / brr;
    }
    // ---- 外设寄存器读 ----
    readPeripheral(address, size) {
      const a = (address & ~3) >>> 0,
        offset = address & 3;
      let v = this.get(a);
      if (!this.known(a)) this.unsupported(a);
      const timer = this.timers.at(a);
      if (timer) v = this.timers.read(timer, a - timer.base, v);
      else if (a >= 0x48000000 && a < 0x48001c00) {
        const off = a & 0x3ff;
        if (off === 0x18 || off === 0x28) v = 0;
        if (off === 0x10) v = this.idr((a - 0x48000000) >>> 10);
      } else if (a >= 0x50000000 && a < 0x50000200 && (a & 0xff) === 0x40) {
        const i = (a >>> 8) & 1;
        this.regs.set(ADC_BASE[i], this.get(ADC_BASE[i]) & ~4);
      }
      if (a === 0x4001381c) v = this.usartISR();
      if (a === 0x40013824) v = this.rx.shift() || 0;
      if (a === 0x4000280c) v |= 0x27 | (v & 0x80 ? 0x40 : 0);
      if (a === 0x40002808) v = this.rtcSubseconds();
      if (a === 0x40002854)
        v = this.get(0x40002850) & ((this.get(0x40002818) >>> 12) & 3);
      if (a === 0x40007014) v = 0;
      if (a === 0xe000e010) {
        v |= this.tickFlag ? 0x10000 : 0;
        this.tickFlag = false;
      }
      if (a === 0xe000e018) {
        const period = (this.get(0xe000e014) & 0xffffff) + 1;
        v = (period - 1 - (Math.floor(this.tickPhase || 0) % period)) >>> 0;
      }
      if (a === 0xe000ed04)
        v =
          this.exception |
          (this.systickPending ? 1 << 26 : 0) |
          (this.pendsv ? 1 << 28 : 0);
      if (a === 0xe000ed0c) v = (v & 0x700) | 0xfa050000;
      return size === 4
        ? v >>> 0
        : (v >>> (offset * 8)) & ((1 << (size * 8)) - 1);
    }
    // ---- 外设寄存器写 ----
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
      const timer = this.timers.at(a);
      if (timer) {
        this.timers.write(timer, a - timer.base, v, old);
        return;
      }
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
      if (a >= 0x50000000 && a < 0x50000200) this.adcWrite(a, v, old);
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
        if (off <= 0x0c || off === 0x14 || off === 0x18 || off === 0x28)
          this.gpioChanged(base, odr);
      }
      if (a === 0x40013828) {
        this.serial += String.fromCharCode(v & 255);
        if (this.serial.length > 100000) this.serial = this.serial.slice(-50000);
      }
      if (a === 0x40013820 && v & 0x10) this.rxIdle = false;
      if (a >= 0x40020008 && a < 0x40020080) {
        const channel = Math.floor((a - 0x40020008) / 20),
          base = 0x40020008 + channel * 20;
        if (a === base + 4) this.dmaStates.set(channel, { count: v, index: 0 });
      }
      if (a === 0x40020004) this.regs.set(0x40020000, this.get(0x40020000) & ~v);
      if (a === 0x40010410) this.regs.set(0x40010414, this.get(0x40010414) | (v & this.get(0x40010400)));
      if (a === 0x40010414) this.regs.set(a, old & ~v);
      if (a === 0x4000280c && old & 0x80 && !(v & 0x80)) this.rtcMs = 0;
      if (a === 0x4000285c) this.regs.set(0x40002850, this.get(0x40002850) & ~v);
      if (a >= 0xe000e100 && a < 0xe000e120) this.regs.set(a, old | v);
      if (a >= 0xe000e180 && a < 0xe000e1a0)
        this.regs.set(a - 0x80, this.get(a - 0x80) & ~v);
      if (a >= 0xe000e200 && a < 0xe000e220)
        for (let i = 0; i < 32; i++) if (v & (1 << i)) this.swPending.add((a - 0xe000e200) * 8 + i);
      if (a >= 0xe000e280 && a < 0xe000e2a0)
        for (let i = 0; i < 32; i++) if (v & (1 << i)) this.swPending.delete((a - 0xe000e280) * 8 + i);
      if (a === 0xe000e014) this.tickPhase = 0;
      if (a === 0xe000e018) {
        this.tickFlag = false;
        this.tickPhase = 0;
      }
      if (a === 0xe000ed04) {
        if (v & (1 << 26)) this.systickPending = true;
        if (v & (1 << 25)) this.systickPending = false;
        if (v & (1 << 28)) this.pendsv = true;
        if (v & (1 << 27)) this.pendsv = false;
      }
      if (a === 0xe000ed0c) {
        if (v >>> 16 !== 0x05fa) this.regs.set(a, old);
        else {
          this.regs.set(a, v & 0x700);
          if (v & 4) {
            this.resetRequested = true;
            this.stop();
          }
        }
      }
    }
    // ---- GPIO 与板级连接 ----
    external(port, n) {
      if (port === 0 && n === 0) return this.keys[3] ? 0 : 1;
      if (port === 1 && n <= 2) return this.keys[n] ? 0 : 1;
      if (port === 1 && n === 6) return 1;
      if (port === 1 && n === 7) return this.i2c.out;
      if (port === 1 && n === 4) return this.signalLevel("PB4");
      if (port === 0 && n === 15) return this.signalLevel("PA15");
      return null;
    }
    // 松开短按时，等固件在 3 个不同的毫秒里读到按下电平再真正松开：
    // 快速时序下整屏刷新较慢，协作式调度可能整段错过一次 100 ms 的点按。
    setKey(i, down) {
      if (down) {
        if (!this.keys[i]) this.keyDownAt[i] = this.ms;
        this.keys[i] = true;
        this.keyRelease[i] = false;
        this.keyReads[i] = 0;
        this.keyReadMs[i] = -1;
      } else if (this.keyReads[i] >= 3) this.releaseKey(i);
      else this.keyRelease[i] = true;
    }
    releaseKey(i) {
      if (this.keys[i] && this.keyDownAt[i] !== null) this.lastHold[i] = this.ms - this.keyDownAt[i];
      this.keys[i] = false;
      this.keyRelease[i] = false;
      this.keyDownAt[i] = null;
    }
    keyRead(i) {
      if (this.keys[i] && this.keyReadMs[i] !== this.ms) {
        this.keyReadMs[i] = this.ms;
        this.keyReads[i]++;
      }
    }
    idr(port) {
      if (port === 0) this.keyRead(3);
      if (port === 1) for (let i = 0; i < 3; i++) this.keyRead(i);
      if (
        port === 2 &&
        !(this.get(0x48000414) & 512) &&
        !(this.get(0x48000014) & 256)
      )
        return this.lcd.read();
      const base = 0x48000000 + port * 0x400,
        moder = this.get(base),
        otyper = this.get(base + 4),
        pupd = this.get(base + 0x0c),
        odr = this.get(base + 0x14);
      let v = 0;
      for (let n = 0; n < 16; n++) {
        const mode = (moder >>> (n * 2)) & 3,
          bit = 1 << n;
        let level;
        if (mode === 3) level = 0;
        else if (mode === 1 && !(otyper & bit)) level = odr & bit ? 1 : 0;
        else {
          const ext = this.external(port, n);
          level = ext !== null ? ext : ((pupd >>> (n * 2)) & 3) === 1 ? 1 : 0;
          if (mode === 1 && !(odr & bit)) level = 0;
        }
        if (level) v |= bit;
      }
      return v;
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
        const moder = this.get(base),
          drive = (n) => (((moder >>> (n * 2)) & 3) === 1 && !(odr & (1 << n)) ? 0 : 1);
        this.i2c.update(drive(6), drive(7));
      }
      if (this.get(0x48000c14) & 4)
        this.leds = (~this.get(0x48000814) >>> 8) & 255;
    }
    signalLevel(pin) {
      const s = this.signals[pin];
      return s.hz > 0 && s.phase < s.duty ? 1 : 0;
    }
    // 生成本毫秒内 R39/R40 方波的边沿，时间以毫秒的小数表示。
    signalEdges() {
      const edges = new Map();
      for (const [pin, s] of Object.entries(this.signals)) {
        const list = [],
          c = Math.min(100000, Math.max(0, s.hz)) / 1000,
          p = s.phase;
        if (c > 0) {
          for (let k = 1; k <= p + c; k++) list.push({ at: (k - p) / c, rising: true });
          for (let j = 0; j + s.duty <= p + c; j++)
            if (j + s.duty > p) list.push({ at: (j + s.duty - p) / c, rising: false });
          list.sort((x, y) => x.at - y.at);
          s.phase = (p + c) % 1;
        }
        edges.set(pin, list);
      }
      return edges;
    }
    mcp() {
      return root.mcpVoltage(this.i2c.wiper, this.mcpOhms);
    }
    // ---- ADC ----
    adcWrite(a, v, old) {
      const i = (a >>> 8) & 1,
        base = ADC_BASE[i],
        off = a & 0xff;
      if (off === 0) this.regs.set(a, old & ~v);
      if (off !== 8) return;
      // ADCAL：硬件完成校准并把校准值写入 CALFACT（ADCALDIF 选择单端或差分）。
      if (v & 0x80000000 && !(old & 1)) {
        const cal = this.get(base + 0xb4);
        this.regs.set(
          base + 0xb4,
          v & 0x40000000 ? (cal & ~0x7f0000) | (ADC_CALFACT[i] << 16) : (cal & ~0x7f) | ADC_CALFACT[i],
        );
      }
      let cr = v & ~0x80000000;
      if (v & 2) {
        cr &= ~3;
        this.regs.set(base, this.get(base) & ~1);
      } else cr |= old & 1;
      if (v & 16) cr &= ~0x14;
      if (v & 1 && !(old & 1)) this.regs.set(base, this.get(base) | 1);
      if ((cr & 5) === 5 && !(old & 4) && !(this.get(base + 0x0c) & 0x2000)) {
        const len = (this.get(base + 0x30) & 15) + 1;
        for (let n = 0; n < len; n++) this.adcConvert(i);
        cr &= ~4;
      }
      this.regs.set(a, cr >>> 0);
    }
    adcChannel(base, rank) {
      const r = rank + 1,
        [reg, shift] =
          r <= 4 ? [0x30, 6 * r] : r <= 9 ? [0x34, 6 * (r - 5)] : r <= 14 ? [0x38, 6 * (r - 10)] : [0x3c, 6 * (r - 15)];
      return (this.get(base + reg) >>> shift) & 31;
    }
    adcVolts(i, ch) {
      if (i === 0 && ch === 11) return this.adc[0];
      if (i === 1 && ch === 15) return this.adc[1];
      if (i === 0 && ch === 5) return this.mcp().volts;
      if (i === 0 && ch === 18) return 1.212;
      if (i === 0 && ch === 16) return 0.76;
      if (i === 0 && ch === 17) return 1.1;
      return 0;
    }
    adcConvert(i) {
      const base = ADC_BASE[i],
        len = (this.get(base + 0x30) & 15) + 1,
        cfgr = this.get(base + 0x0c),
        bits = [12, 10, 8, 6][(cfgr >>> 3) & 3],
        ch = this.adcChannel(base, this.adcIndex[i] % len),
        volts = Math.min(3.3, Math.max(0, this.adcVolts(i, ch))),
        code = (volts / 3.3) * 4095 + this.adcError(i) + this.noise() * ADC_NOISE_LSB;
      let value = Math.min(4095, Math.max(0, Math.round(code))) >>> (12 - bits);
      if (cfgr & 0x8000) value <<= 16 - bits;
      this.regs.set(base + 0x40, value);
      this.adcIndex[i] = (this.adcIndex[i] + 1) % len;
      this.regs.set(base, this.get(base) | 4 | (this.adcIndex[i] === 0 ? 8 : 0));
      if (cfgr & 1) this.dmaRequest(base + 0x40, value);
    }
    // 12 位下的偏移误差（LSB）：0 表示已正确校准。
    adcError(i) {
      return (this.get(ADC_BASE[i] + 0xb4) & 0x7f) - ADC_CALFACT[i];
    }
    // 近似标准正态的确定性噪声（固定种子，便于复现测试结果）。
    noise() {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
        sum += this.seed / 4294967296;
      }
      return (sum - 1.5) * 2;
    }
    // ---- 串口 ----
    usartISR() {
      return 0x6000c0 | (this.rx.length ? 0x20 : 0) | (this.rxIdle ? 0x10 : 0);
    }
    // ---- RTC ----
    rtcPeriod() {
      const bdcr = this.get(0x40021090),
        sel = (bdcr >>> 8) & 3,
        clk = [0, 32768, 32000, HSE / 32][sel],
        prer = this.get(0x40002810);
      return clk ? ((((prer >>> 16) & 127) + 1) * ((prer & 0x7fff) + 1) * 1000) / clk : 0;
    }
    rtcSubseconds() {
      const s = this.get(0x40002810) & 0x7fff,
        period = this.rtcPeriod();
      return period ? s - Math.min(s, Math.floor((this.rtcMs / period) * (s + 1))) : s;
    }
    rtcTick() {
      if (!(this.get(0x40021090) & 0x8000) || this.get(0x4000280c) & 0x80) return;
      const period = this.rtcPeriod();
      if (!period) return;
      this.rtcMs++;
      while (this.rtcMs >= period) {
        this.rtcMs -= period;
        this.rtcSecond();
      }
    }
    rtcSecond() {
      const dec = (x) => (x & 15) + 10 * (x >>> 4),
        bcd = (x) => Math.floor(x / 10) * 16 + (x % 10),
        tr = this.get(0x40002800);
      let t = dec(tr & 127) + dec((tr >>> 8) & 127) * 60 + dec((tr >>> 16) & 63) * 3600 + 1;
      if (t >= 86400) {
        t = 0;
        const dr = this.get(0x40002804);
        let year = dec((dr >>> 16) & 255),
          month = dec((dr >>> 8) & 31),
          day = dec(dr & 63),
          wd = (dr >>> 13) & 7;
        const dim = [31, year % 4 ? 28 : 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 31;
        if (++day > dim) {
          day = 1;
          if (++month > 12) {
            month = 1;
            year = (year + 1) % 100;
          }
        }
        wd = (wd % 7) + 1;
        this.regs.set(0x40002804, (bcd(year) << 16) | (wd << 13) | (bcd(month) << 8) | bcd(day));
      }
      const time = bcd(t % 60) | (bcd(Math.floor(t / 60) % 60) << 8) | (bcd(Math.floor(t / 3600)) << 16);
      this.regs.set(0x40002800, time);
      const cr = this.get(0x40002818);
      if (!(cr & 0x100)) return;
      const al = this.get(0x40002840),
        dr = this.get(0x40002804),
        hit =
          (al & 0x80 || (al & 0x7f) === (time & 0x7f)) &&
          (al & 0x8000 || ((al >>> 8) & 0x7f) === ((time >>> 8) & 0x7f)) &&
          (al & 0x800000 || ((al >>> 16) & 0x3f) === ((time >>> 16) & 0x3f)) &&
          (al & 0x80000000 ||
            (al & 0x40000000
              ? ((al >>> 24) & 15) === ((dr >>> 13) & 7)
              : ((al >>> 24) & 0x3f) === (dr & 0x3f)));
      if (hit) {
        this.regs.set(0x40002850, this.get(0x40002850) | 1);
        this.regs.set(0x40010414, this.get(0x40010414) | (1 << 17));
      }
    }
    // ---- 中断控制 ----
    priority(n) {
      if (n >= 16) {
        const i = n - 16;
        return (this.get(0xe000e400 + (i & ~3)) >>> ((i & 3) * 8)) & 0xff;
      }
      if (n === 15) return this.get(0xe000ed20) >>> 24;
      if (n === 14) return (this.get(0xe000ed20) >>> 16) & 0xff;
      return 0;
    }
    group(n) {
      return this.priority(n) >> (((this.get(0xe000ed0c) >>> 8) & 7) + 1);
    }
    enabled(n) {
      if (n < 16) return true;
      const i = n - 16;
      return !!(this.get(0xe000e100 + 4 * (i >>> 5)) & (1 << (i & 31)));
    }
    canTake(n) {
      if (this.e.reg_read_i32(this.uc.ARM_REG_PRIMASK)) return false;
      return !this.exception || this.group(n) < this.group(this.exception);
    }
    pendingIRQs() {
      const s = new Set(this.swPending);
      const dmaFlags = this.get(0x40020000);
      for (let ch = 0; ch < 6; ch++)
        if ((dmaFlags >>> (ch * 4)) & this.get(0x40020008 + ch * 20) & 0xe) s.add(11 + ch);
      for (const base of ADC_BASE)
        if (this.get(base) & this.get(base + 4) & 0x7ff) s.add(18);
      const cr1 = this.get(0x40013800);
      if (cr1 & this.usartISR() & 0xf0) s.add(37);
      this.timers.pending(s);
      const pr = this.get(0x40010414) & this.get(0x40010400);
      for (let n = 0; n < 5; n++) if (pr & (1 << n)) s.add(6 + n);
      if (pr & 0x3e0) s.add(23);
      if (pr & 0xfc00) s.add(40);
      if (this.get(0x40002850) & (this.get(0x40002818) >>> 12) & 3) s.add(41);
      return s;
    }
    nextException() {
      const list = [];
      if (this.systickPending) list.push(15);
      if (this.pendsv) list.push(14);
      for (const irq of this.pendingIRQs()) if (this.enabled(irq + 16)) list.push(irq + 16);
      if (!list.length) return 0;
      list.sort((x, y) => this.priority(x) - this.priority(y) || x - y);
      return list[0];
    }
    takeInterrupts() {
      for (let j = 0; j < 8; j++) {
        const n = this.nextException();
        if (!n || !this.canTake(n)) return;
        this.service(n);
      }
    }
    // 捕获中断需要逐个边沿响应，否则“清零计数器”式的测频程序会得到倍数周期。
    interruptNow(n) {
      if (this.enabled(n) && this.canTake(n)) this.service(n);
    }
    enterException(number) {
      const u = this.uc,
        e = this.e;
      const handler = this.readWord(
        (this.get(0xe000ed08) || 0x08000000) + number * 4,
      );
      if (!(handler & 1) || handler < 0x08000000 || handler >= 0x08020000)
        throw new Error("无效中断向量 " + number);
      if (number === 15) this.systickPending = false;
      if (number === 14) this.pendsv = false;
      this.swPending.delete(number - 16);
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
      // 浮点寄存器在 JS 侧保存，避免中断里的浮点运算破坏主程序状态。
      const fp = this.fpRegs.map((r) => e.reg_read_i32(r));
      fp.push(e.reg_read_i32(u.ARM_REG_FPSCR));
      this.frames.push({ sp, number, previous: this.exception, fp });
      e.reg_write_i32(u.ARM_REG_SP, sp);
      e.reg_write_i32(u.ARM_REG_LR, this.exception ? 0xfffffff1 : 0xfffffff9);
      this.exception = number;
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
      this.fpRegs.forEach((r, i) => e.reg_write_i32(r, f.fp[i]));
      e.reg_write_i32(u.ARM_REG_FPSCR, f.fp[16]);
      e.reg_write_i32(u.ARM_REG_XPSR, values[7] & ~512);
      e.reg_write_i32(u.ARM_REG_SP, sp + 32 + (values[7] & 512 ? 4 : 0));
      e.reg_write_i32(u.ARM_REG_PC, values[6] | 1);
      this.exception = f.previous;
      if (this.serviceDepth >= 0 && this.frames.length <= this.serviceDepth)
        this.stop();
    }
    run(budget) {
      this.budget = budget;
      this.halt = false;
      while (!this.halt && !this.fault) {
        const page = this.guardPage(this.pc);
        try {
          if (page) this.guarded(page);
          else {
            this.e.emu_start(this.pc | 1, 0, 0, 0);
            break;
          }
        } catch (err) {
          if (!this.guardPage(this.pc)) throw err;
        }
      }
      const used = budget - Math.max(0, this.budget);
      this.instructions += used;
      if (this.fault) throw this.fault;
      return used;
    }
    service(number) {
      const depth = this.serviceDepth;
      this.serviceDepth = this.frames.length;
      this.enterException(number);
      try {
        this.isrUsed += this.run(this.perMs());
      } finally {
        this.serviceDepth = depth;
      }
    }
    // ---- DMA ----
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
        if (
          width > 4 ||
          !(
            (pointer >= 0x20000000 && pointer + width <= 0x20008000) ||
            (pointer >= 0x10000000 && pointer + width <= 0x10002800)
          )
        )
          throw new Error("DMA 写入地址无效：0x" + pointer.toString(16));
        this.writeMemory(pointer, value, width);
        this.dmaStep(ch, base, cfg, state);
      }
    }
    dmaStep(ch, base, cfg, state) {
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
    // 内存到串口的 DMA 发送（HAL_UART_Transmit_DMA）。
    dmaTransmit() {
      if (!(this.get(0x40013808) & 0x80)) return;
      for (let ch = 0; ch < 6; ch++) {
        const base = 0x40020008 + ch * 20,
          cfg = this.get(base),
          state = this.dmaStates.get(ch);
        if (!(cfg & 1) || !(cfg & 16) || this.get(base + 8) !== 0x40013828 || !state) continue;
        while (state.count && this.get(base) & 1) {
          const width = 1 << ((cfg >>> 10) & 3),
            pointer = this.get(base + 12) + (cfg & 128 ? state.index * width : 0);
          this.serial += String.fromCharCode(this.e.mem_read(pointer, 1)[0]);
          const circular = cfg & 32;
          this.dmaStep(ch, base, cfg, state);
          if (circular && state.index === 0) break;
        }
      }
    }
    // ---- 1 ms 节拍 ----
    tick() {
      this.ms++;
      for (let i = 0; i < 4; i++) if (this.keyRelease[i] && this.keyReads[i] >= 3) this.releaseKey(i);
      const ctrl = this.get(0xe000e010);
      if (ctrl & 1) {
        const period = (this.get(0xe000e014) & 0xffffff) + 1;
        this.tickPhase = (this.tickPhase || 0) + this.hclk() / 1000 / (ctrl & 4 ? 1 : 8);
        if (this.tickPhase >= period) {
          this.tickPhase %= period;
          this.tickFlag = true;
          if (ctrl & 2) this.systickPending = true;
        }
      }
      this.rtcTick();
      for (let i = 0; i < 2; i++) {
        const base = ADC_BASE[i];
        if ((this.get(base + 8) & 5) === 5 && this.get(base + 0x0c) & 0x2000) {
          const n = this.get(base + 0x0c) & 1 ? 30 : (this.get(base + 0x30) & 15) + 1;
          for (let k = 0; k < n; k++) this.adcConvert(i);
        }
      }
      this.timers.tick(this.signalEdges());
      if (this.rx.length && this.get(0x40013808) & 64) {
        const n = this.rx.length;
        for (let i = 0; i < n; i++) this.dmaRequest(0x40013824, this.rx.shift());
        this.rxIdle = true;
      } else if (this.rxWas && !this.rx.length) this.rxIdle = true;
      this.rxWas = this.rx.length > 0;
      this.dmaTransmit();
      this.extiTick();
    }
    extiTick() {
      const imr = this.get(0x40010400) & 0xffff;
      if (!imr) return;
      const ports = new Map(),
        rt = this.get(0x40010408),
        ft = this.get(0x4001040c);
      let levels = 0,
        pr = this.get(0x40010414);
      for (let n = 0; n < 16; n++) {
        const port = (this.get(0x40010008 + (n >> 2) * 4) >>> ((n & 3) * 4)) & 15;
        if (!ports.has(port)) ports.set(port, this.idr(port));
        if ((ports.get(port) >>> n) & 1) levels |= 1 << n;
      }
      if (this.extiLevels >= 0) {
        const changed = (levels ^ this.extiLevels) & imr;
        pr |= changed & ((levels & rt) | (~levels & ft));
        this.regs.set(0x40010414, pr >>> 0);
      }
      this.extiLevels = levels;
    }
    step(quanta = 1) {
      for (let i = 0; i < quanta; i++) {
        this.takeInterrupts();
        const per = this.perMs();
        this.run(Math.max(per >> 3, per - this.isrUsed));
        this.isrUsed = 0;
        if (this.resetRequested) return;
        this.tick();
      }
    }
    // ---- 状态查询 ----
    pwm(base, channel) {
      const p = this.timers.pwm(this.timers.at(base), channel);
      return { enabled: p.enabled, hz: p.hz, duty: p.duty === null ? 0 : p.duty };
    }
    outputs(pins = ["PA1", "PA2", "PA6", "PA7"]) {
      const list = pins.map((p) => this.timers.pin(p));
      for (const p of root.TIMER_PINS)
        if (!pins.includes(p)) {
          const o = this.timers.pin(p);
          if (o.kind === "timer" && o.enabled) list.push(o);
        }
      return list;
    }
    captures() {
      return Object.keys(this.signals).map((pin) => {
        const o = this.timers.pin(pin);
        return { pin, hz: this.signals[pin].hz, source: o.kind === "capture" ? o.source : null };
      });
    }
    close() {
      for (const h of this.hooks) this.e.hook_del(h);
      this.e.close();
      this.uc._free(this.scratch);
    }
  }
  root.Machine = Machine;
  if (typeof module !== "undefined") module.exports = { Machine };
})(globalThis);
