/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  // PB6/PB7 软件 I2C 总线上的两个器件：M24C02（0xA0，256 字节，16 字节页）
  // 和 MCP4017（0x5E，7 位变阻器）。只依据 SCL/SDA 电平跳变工作，与延时长短无关。
  const EEPROM_ADDR = 0x50,
    MCP_ADDR = 0x2f,
    PAGE = 16,
    WRITE_MS = 5;
  class I2CBus {
    constructor(now, eeprom, wiper = 0x3f) {
      this.now = now;
      this.eeprom = eeprom || new Uint8Array(256).fill(0xff);
      this.wiper = wiper & 0x7f;
      this.scl = 1;
      this.sda = 1;
      this.out = 1;
      this.mode = "idle";
      this.pointer = 0;
      this.busyUntil = -1;
      this.pending = new Map();
      this.written = [];
      this.version = 0;
    }
    // master 为 MCU 端驱动的电平（释放为 1），返回本次更新后的总线 SDA。
    update(scl, master) {
      const sda = master & this.out;
      if (scl && this.scl && sda !== this.sda) {
        if (sda) this.stop();
        else this.start();
      } else if (scl && !this.scl) this.rise(sda);
      else if (!scl && this.scl) this.fall();
      this.scl = scl;
      this.sda = master & this.out;
      return this.sda;
    }
    start() {
      this.pending.clear();
      this.mode = "rx";
      this.first = true;
      this.reading = false;
      this.addressed = false;
      this.clk = 0;
      this.byte = 0;
      this.out = 1;
    }
    stop() {
      if (this.device === "eeprom" && this.pending.size) {
        for (const [a, v] of this.pending) this.eeprom[a] = v;
        this.written = [...this.pending.keys()];
        this.pending.clear();
        this.busyUntil = this.now() + WRITE_MS;
        this.version++;
      }
      this.mode = "idle";
      this.out = 1;
    }
    rise(sda) {
      if (this.mode !== "rx" && this.mode !== "tx") return;
      this.clk++;
      if (this.mode === "rx" && this.clk <= 8) this.byte = ((this.byte << 1) | sda) & 255;
      if (this.mode === "tx" && this.clk === 9) this.ack = !sda;
    }
    fall() {
      if (this.mode === "rx") {
        if (this.clk === 8) this.out = this.receive(this.byte) ? 0 : 1;
        else if (this.clk === 9) {
          this.out = 1;
          this.clk = 0;
          this.byte = 0;
          if (this.ignore) this.mode = "idle";
          else if (this.reading) {
            this.mode = "tx";
            this.load();
          }
        }
      } else if (this.mode === "tx") {
        if (this.clk >= 1 && this.clk < 8) this.out = (this.tx >>> (7 - this.clk)) & 1;
        else if (this.clk === 8) this.out = 1;
        else if (this.clk === 9) {
          this.clk = 0;
          if (this.ack) this.load();
          else {
            this.mode = "idle";
            this.out = 1;
          }
        }
      }
    }
    load() {
      if (this.device === "eeprom") {
        this.tx = this.eeprom[this.pointer];
        this.pointer = (this.pointer + 1) & 255;
      } else this.tx = this.wiper;
      this.out = (this.tx >>> 7) & 1;
    }
    receive(byte) {
      this.ignore = false;
      if (this.first) {
        this.first = false;
        const address = byte >>> 1;
        this.reading = !!(byte & 1);
        if (address === EEPROM_ADDR && this.now() >= this.busyUntil) this.device = "eeprom";
        else if (address === MCP_ADDR) this.device = "mcp";
        else {
          this.ignore = true;
          return false;
        }
        return true;
      }
      if (this.device === "mcp") {
        this.wiper = byte & 0x7f;
        this.version++;
      } else if (!this.addressed) {
        this.pointer = byte;
        this.addressed = true;
      } else {
        this.pending.set(this.pointer, byte);
        this.pointer = (this.pointer & ~(PAGE - 1)) | ((this.pointer + 1) & (PAGE - 1));
      }
      return true;
    }
  }
  // MCP4017 的 W–B 端与 R17（10 kΩ）上拉组成分压，输出 AO3 → PB14。
  function mcpVoltage(wiper, ohms = 100000) {
    const r = (ohms * wiper) / 127 + 75;
    return { ohms: r, volts: (3.3 * r) / (r + 10000) };
  }
  root.I2CBus = I2CBus;
  root.mcpVoltage = mcpVoltage;
  if (typeof module !== "undefined") module.exports = { I2CBus, mcpVoltage };
})(globalThis);
