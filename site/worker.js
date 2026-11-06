/* SPDX-License-Identifier: GPL-2.0-only */
importScripts("vendor/unicorn_arm.js", "elf.js", "lcd.js", "machine.js");
let machine,
  running = false,
  speed = 1,
  timer,
  lastWall = 0,
  target = 0,
  lastFrame = 0;
const ready = MUnicorn();
function snapshot(force = false) {
  if (!machine) return;
  const data = {
    type: "state",
    running,
    ms: machine.ms,
    pc: machine.pc,
    leds: machine.leds,
    pixels: machine.lcd.writes,
    commands: machine.lcd.commands,
    unknown: [...machine.unknown.values()],
    serial: machine.serial.slice(-24000),
    pwm: [machine.pwm(0x40012c00, 1), machine.pwm(0x40000000, 2)],
    rtc: machine.get(0x40002800),
    rtcEnabled: !!(machine.get(0x40021090) & 0x8000),
  };
  if (machine.lcd.dirty || force) {
    data.frame = machine.lcd.rgba();
    postMessage(data, [data.frame.buffer]);
  } else postMessage(data);
}
function loop() {
  if (!running) return;
  const start = performance.now();
  target = Math.min(machine.ms + 80, target + (start - lastWall) * speed);
  lastWall = start;
  try {
    while (machine.ms < target && performance.now() - start < 14)
      machine.step();
    if (start - lastFrame > 50) {
      snapshot();
      lastFrame = start;
    }
  } catch (err) {
    running = false;
    postMessage({ type: "error", message: String(err), pc: machine.pc });
    snapshot(true);
  }
  if (running) timer = setTimeout(loop, 0);
}
function run() {
  if (!machine || running) return;
  running = true;
  lastWall = performance.now();
  target = machine.ms;
  loop();
  snapshot();
}
onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      running = false;
      clearTimeout(timer);
      if (machine) machine.close();
      machine = new Machine(await ready, data.bytes, { lcdId: data.lcdId });
      postMessage({ type: "loaded", size: machine.firmware.size });
      snapshot(true);
      if (data.run) run();
    } else if (data.type === "run") run();
    else if (data.type === "pause") {
      running = false;
      clearTimeout(timer);
      snapshot();
    } else if (data.type === "key" && machine)
      machine.keys[data.index] = data.down;
    else if (data.type === "analog" && machine)
      machine.adc[data.index] = Math.min(3.3, Math.max(0, data.value));
    else if (data.type === "frequency" && machine)
      machine.frequency = Math.min(20000, Math.max(0, data.value));
    else if (data.type === "uart" && machine) {
      if (machine.rx.length < 4096)
        machine.rx.push(...new TextEncoder().encode(data.text));
    } else if (data.type === "speed") speed = data.value;
  } catch (err) {
    running = false;
    postMessage({ type: "error", message: String(err) });
  }
};
