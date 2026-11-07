/* SPDX-License-Identifier: GPL-2.0-only */
importScripts("vendor/unicorn_arm.js", "elf.js", "lcd.js", "i2c.js", "timer.js", "machine.js");
let machine,
  running = false,
  speed = 1,
  timer,
  lastWall = 0,
  target = 0,
  lastFrame = 0,
  config = null,
  eepromVersion = -1,
  history = [],
  lastSample = -10,
  rate = { wall: 0, ms: 0, value: 0 };
const PINS = ["PA1", "PA2", "PA6", "PA7"];
const ready = MUnicorn();
async function create() {
  if (machine) machine.close();
  const c = config;
  machine = new Machine(await ready, c.bytes, {
    lcdId: c.lcdId,
    timing: c.timing,
    eeprom: c.eeprom,
    wiper: c.wiper,
    mcpOhms: c.mcpOhms,
  });
  machine.adc = c.adc.slice();
  for (const pin of Object.keys(machine.signals)) machine.signals[pin].hz = c.signals[pin];
  history = [];
  lastSample = -10;
  eepromVersion = -1;
}
function sample() {
  if (machine.ms - lastSample < 10) return;
  lastSample = machine.ms;
  history.push([machine.ms, ...PINS.map((p) => {
    const o = machine.timers.pin(p);
    return o.kind === "timer" && o.enabled ? [o.hz, o.duty] : o.kind === "gpio" ? [0, o.level * 100] : null;
  })]);
}
function snapshot(force = false) {
  if (!machine) return;
  const now = performance.now();
  if (now - rate.wall > 1000) {
    rate.value = rate.wall ? (machine.ms - rate.ms) / (now - rate.wall) : 0;
    rate.wall = now;
    rate.ms = machine.ms;
  }
  const mcp = machine.mcp(),
    data = {
      type: "state",
      running,
      ms: machine.ms,
      pc: machine.pc,
      leds: machine.leds,
      pixels: machine.lcd.writes,
      commands: machine.lcd.commands,
      unknown: [...machine.unknown.values()],
      serial: machine.serial.slice(-24000),
      outputs: machine.outputs(PINS),
      captures: machine.captures(),
      rtc: machine.get(0x40002800),
      date: machine.get(0x40002804),
      rtcEnabled: !!(machine.get(0x40021090) & 0x8000),
      rtcPeriod: machine.rtcPeriod(),
      baud: machine.baud(),
      wiper: machine.i2c.wiper,
      mcp,
      holds: machine.keyDownAt.map((t) => (t === null ? null : machine.ms - t)),
      lastHold: machine.lastHold,
      timing: machine.timing,
      perMs: machine.perMs(),
      hclk: machine.hclk(),
      rate: running ? rate.value : 0,
      history,
      guards: machine.runs.length,
    };
  history = [];
  if (machine.i2c.version !== eepromVersion) {
    eepromVersion = machine.i2c.version;
    data.eeprom = machine.i2c.eeprom.slice();
    data.written = machine.i2c.written;
  }
  if (machine.lcd.dirty || force) {
    data.frame = machine.lcd.rgba();
    postMessage(data, [data.frame.buffer]);
  } else postMessage(data);
}
async function loop() {
  if (!running) return;
  const start = performance.now();
  target = Math.min(machine.ms + 80, target + (start - lastWall) * speed);
  lastWall = start;
  try {
    while (machine.ms < target && performance.now() - start < 14) {
      machine.step();
      sample();
      if (machine.resetRequested) {
        // 固件调用 NVIC_SystemReset：保留 EEPROM 与 MCP4017，重新上电运行。
        config.eeprom = machine.i2c.eeprom.slice();
        config.wiper = machine.i2c.wiper;
        await create();
        target = machine.ms;
        postMessage({ type: "reset", reason: "firmware" });
        break;
      }
    }
    if (start - lastFrame > 50) {
      snapshot();
      lastFrame = start;
    }
  } catch (err) {
    running = false;
    postMessage({ type: "error", message: String(err && err.message ? err.message : err), pc: machine.pc });
    snapshot(true);
  }
  if (running) timer = setTimeout(loop, 0);
}
function run() {
  if (!machine || running) return;
  running = true;
  lastWall = performance.now();
  rate = { wall: 0, ms: machine.ms, value: 0 };
  target = machine.ms;
  loop();
  snapshot();
}
onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      running = false;
      clearTimeout(timer);
      config = data;
      await create();
      postMessage({ type: "loaded", size: machine.firmware.size, format: machine.firmware.format, guards: machine.runs.length });
      snapshot(true);
      if (data.run) run();
    } else if (data.type === "run") run();
    else if (data.type === "pause") {
      running = false;
      clearTimeout(timer);
      snapshot();
    } else if (!machine) return;
    else if (data.type === "key") machine.setKey(data.index, data.down); else if (data.type === "analog") {
      machine.adc[data.index] = Math.min(3.3, Math.max(0, data.value));
      config.adc[data.index] = machine.adc[data.index];
    } else if (data.type === "signal" || data.type === "frequency") {
      const pin = data.pin || "PB4",
        // R39/R40 调节的 TLC555 输出范围约 600–32000 Hz
        hz = Math.min(32000, Math.max(600, data.value));
      machine.signals[pin].hz = hz;
      config.signals[pin] = hz;
    } else if (data.type === "uart") {
      if (machine.rx.length < 4096) machine.rx.push(...new TextEncoder().encode(data.text));
    } else if (data.type === "speed") speed = data.value;
    else if (data.type === "timing") {
      machine.timing = config.timing = data.value;
      snapshot();
    } else if (data.type === "mcp-ohms") {
      machine.mcpOhms = config.mcpOhms = data.value;
      snapshot();
    } else if (data.type === "eeprom-fill") {
      machine.i2c.eeprom.fill(data.value);
      machine.i2c.written = [];
      machine.i2c.version++;
      snapshot();
    }
  } catch (err) {
    running = false;
    postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
