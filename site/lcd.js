/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  class LCD {
    constructor(id = 0x9325) {
      this.id = id;
      this.regs = new Uint16Array(256);
      this.pixels = new Uint16Array(240 * 320);
      this.index = 0;
      this.writes = 0;
      this.commands = 0;
      this.dirty = true;
      this.regs[0x51] = 239;
      this.regs[0x53] = 319;
    }
    command(value) {
      this.index = value & 255;
      this.commands++;
    }
    read() {
      return this.index === 0
        ? this.id
        : this.index === 0x22
          ? this.pixels[this.regs[0x21] * 240 + this.regs[0x20]] || 0
          : this.regs[this.index];
    }
    data(value) {
      if (this.index !== 0x22) {
        this.regs[this.index] = value;
        this.dirty = true;
        return;
      }
      let x = this.regs[0x20],
        y = this.regs[0x21];
      if (x < 240 && y < 320) this.pixels[y * 240 + x] = value;
      this.writes++;
      this.dirty = true;
      const entry = this.regs[3],
        dx = entry & 0x10 ? 1 : -1,
        dy = entry & 0x20 ? 1 : -1;
      const xmin = this.regs[0x50],
        xmax = this.regs[0x51],
        ymin = this.regs[0x52],
        ymax = this.regs[0x53];
      const nextX = () => {
        x += dx;
        if (x > xmax || x < xmin) {
          x = dx > 0 ? xmin : xmax;
          return true;
        }
        return false;
      };
      const nextY = () => {
        y += dy;
        if (y > ymax || y < ymin) {
          y = dy > 0 ? ymin : ymax;
          return true;
        }
        return false;
      };
      if (entry & 8) {
        if (nextY()) nextX();
      } else {
        if (nextX()) nextY();
      }
      this.regs[0x20] = x;
      this.regs[0x21] = y;
    }
    rgba() {
      const data = new Uint8ClampedArray(320 * 240 * 4),
        on = !!(this.regs[7] & 3);
      for (let y = 0; y < 320; y++)
        for (let x = 0; x < 240; x++) {
          const color = on ? this.pixels[y * 240 + x] : 0,
            p = (x * 320 + (319 - y)) * 4;
          data[p] = (((color >> 11) & 31) * 255) / 31;
          data[p + 1] = (((color >> 5) & 63) * 255) / 63;
          data[p + 2] = ((color & 31) * 255) / 31;
          data[p + 3] = 255;
        }
      this.dirty = false;
      return data;
    }
  }
  root.LCD = LCD;
  if (typeof module !== "undefined") module.exports = { LCD };
})(globalThis);
