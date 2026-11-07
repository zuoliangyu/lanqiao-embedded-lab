/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const $ = (id) => document.getElementById(id);
const STORE = "lanqiao-lab:";
let worker,
  file,
  bytes,
  loaded = false,
  lastSerial = "",
  serialOffset = 0,
  errorState = false,
  lastMs = 0;
// 板上掉电不丢失的状态：EEPROM 内容；MCP4017 的滑片只在复位时保留。
const board = {
  eeprom: loadEEPROM(),
  wiper: 0x3f,
  timing: localStorage.getItem(STORE + "timing") || "fast",
  mcpOhms: Number(localStorage.getItem(STORE + "mcp")) || 100000,
};
const latched = new Set(),
  trend = new Map(),
  PINS = ["PA1", "PA2", "PA6", "PA7"];
const ctx = $("lcd").getContext("2d");
function loadEEPROM() {
  const hex = localStorage.getItem(STORE + "eeprom"),
    data = new Uint8Array(256).fill(0xff);
  if (hex && /^[0-9a-f]{512}$/.test(hex))
    for (let i = 0; i < 256; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
  return data;
}
function saveEEPROM() {
  localStorage.setItem(
    STORE + "eeprom",
    Array.from(board.eeprom, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}
for (let i = 0; i < 8; i++) {
  const item = document.createElement("div");
  item.className = "led-item";
  item.innerHTML =
    '<i class="led" aria-label="LED ' +
    (i + 1) +
    ' 熄灭"></i><span>LD' +
    (i + 1) +
    "</span>";
  $("leds").append(item);
}
const cells = [];
for (let row = 0; row < 16; row++) {
  const head = document.createElement("span");
  head.className = "eeprom-head";
  head.textContent = (row * 16).toString(16).padStart(2, "0").toUpperCase();
  $("eeprom").append(head);
  for (let col = 0; col < 16; col++) {
    const cell = document.createElement("span");
    cell.title = "0x" + (row * 16 + col).toString(16).padStart(2, "0").toUpperCase();
    $("eeprom").append(cell);
    cells.push(cell);
  }
}
function renderEEPROM(written = []) {
  board.eeprom.forEach((b, i) => {
    cells[i].textContent = b.toString(16).padStart(2, "0").toUpperCase();
    cells[i].classList.toggle("blank", b === 0xff);
  });
  for (const a of written) {
    cells[a].classList.remove("new");
    void cells[a].offsetWidth;
    cells[a].classList.add("new");
  }
}
renderEEPROM();
$("timing").value = board.timing;
$("mcp-ohms").value = String(board.mcpOhms);
const setStatus = (text, running = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("running", running);
};
const showError = (message) => {
  $("alert").hidden = false;
  $("alert").textContent = /Aborted/.test(message)
    ? "仿真内核意外中止（" +
      message +
      "）。这通常发生在内核翻译超长的连续浮点代码时；请把出错位置附近的循环展开减少（例如改用 -O1/-O2 编译）后重试。"
    : message;
  errorState = true;
  setStatus("运行中止");
  $("pause").disabled = true;
  $("run").disabled = true;
};
function post(data) {
  if (worker) worker.postMessage(data);
}
const fmtHz = (hz) =>
  hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 2 : 3) + " kHz" : hz.toFixed(hz < 10 ? 2 : 1) + " Hz";
function createWorker(run, power = false) {
  if (worker) worker.terminate();
  loaded = false;
  errorState = false;
  lastSerial = "";
  serialOffset = 0;
  trend.clear();
  if (power) board.wiper = 0x3f;
  document.querySelectorAll(".key").forEach((el) => el.classList.remove("pressed", "latched"));
  latched.clear();
  $("serial").textContent = "等待 USART1 输出…";
  $("alert").hidden = true;
  setStatus("正在装载");
  $("run").disabled = true;
  $("pause").disabled = true;
  worker = new Worker("worker.js");
  worker.onerror = (e) =>
    showError(
      "仿真内核加载失败：" + e.message + "。请通过 HTTP / HTTPS 打开页面。",
    );
  worker.onmessage = ({ data }) => {
    if (data.type === "loaded") {
      loaded = true;
      $("run").disabled = false;
      $("reset").disabled = false;
      $("power").disabled = false;
      $("screen-empty").hidden = true;
      $("file-info").textContent =
        (data.size / 1024).toFixed(1) +
        " KB · " +
        (data.format === "hex" ? "Intel HEX" : "ARM ELF") +
        " · 文件未上传" +
        (data.guards ? " · 含超长浮点代码，已分段执行" : "");
      post({ type: "speed", value: Number($("speed").value) });
    } else if (data.type === "reset") {
      $("alert").hidden = false;
      $("alert").textContent = "固件请求了系统复位（NVIC_SystemReset），已重新上电运行，EEPROM 保持。";
    } else if (data.type === "error")
      showError(
        data.message + (data.pc ? " · PC 0x" + data.pc.toString(16) : ""),
      );
    else if (data.type === "state") render(data);
  };
  const copy = bytes.slice(0);
  worker.postMessage(
    {
      type: "load",
      bytes: copy,
      lcdId: Number($("lcd-model").value),
      timing: board.timing,
      eeprom: board.eeprom.slice(),
      wiper: board.wiper,
      mcpOhms: board.mcpOhms,
      adc: [0, 1].map((i) => Number($("adc" + i).value)),
      signals: { PB4: Number($("sig-PB4").value), PA15: Number($("sig-PA15").value) },
      run,
    },
    [copy],
  );
}
function render(data) {
  if (!errorState) setStatus(data.running ? "运行中" : "已暂停", data.running);
  $("run").disabled = data.running || !loaded || errorState;
  $("pause").disabled = !data.running;
  $("sim-time").innerHTML = (data.ms / 1000).toFixed(3) + " <small>s</small>";
  $("pc").textContent = "0x" + data.pc.toString(16).padStart(8, "0").toUpperCase();
  $("lcd-writes").textContent = data.pixels.toLocaleString() + " 次像素写入";
  $("rate").textContent = data.running
    ? "实际 " + data.rate.toFixed(2) + "×"
    : (data.perMs / 1000).toFixed(0) + "k 指令/ms";
  $("rate").title =
    "每仿真毫秒 " + data.perMs.toLocaleString() + " 条指令；HCLK " + (data.hclk / 1e6).toFixed(0) + " MHz";
  if (data.frame) ctx.putImageData(new ImageData(data.frame, 320, 240), 0, 0);
  document.querySelectorAll(".led").forEach((led, i) => {
    const on = !!(data.leds & (1 << i));
    led.classList.toggle("on", on);
    led.setAttribute("aria-label", "LED " + (i + 1) + (on ? " 点亮" : " 熄灭"));
  });
  if (data.serial !== lastSerial) {
    lastSerial = data.serial;
    $("serial").textContent = data.serial.slice(serialOffset) || "等待 USART1 输出…";
    $("serial").scrollTop = $("serial").scrollHeight;
  }
  const baud = Math.round(data.baud);
  $("baud").textContent = baud ? "USART1 · " + baud.toLocaleString() + " bps" : "USART1 未配置";
  $("baud").classList.toggle("warn", !!baud && Math.abs(baud - 9600) / 9600 > 0.03);
  $("baud").title = baud && Math.abs(baud - 9600) / 9600 > 0.03 ? "历年题目要求 9600 bps" : "";
  data.holds.forEach((h, i) => {
    const el = $("holds").children[i];
    el.textContent =
      h !== null ? "按住 " + (h / 1000).toFixed(2) + " s" : data.lastHold[i] ? "上次 " + (data.lastHold[i] / 1000).toFixed(2) + " s" : "";
    el.classList.toggle("active", h !== null);
  });
  renderOutputs(data);
  for (const c of data.captures)
    $("route-" + c.pin).textContent = c.source ? "→ " + c.source + " 输入捕获" : "未接入定时器（引脚未配置为定时器复用）";
  $("mcp").textContent =
    "N=" + data.wiper + " · " + (data.mcp.ohms / 1000).toFixed(1) + " kΩ · " + data.mcp.volts.toFixed(2) + " V";
  board.wiper = data.wiper;
  const bcd = (x) => ((x >>> 4) * 10 + (x & 15)).toString().padStart(2, "0");
  $("rtc").textContent = data.rtcEnabled
    ? bcd((data.rtc >>> 16) & 63) + ":" + bcd((data.rtc >>> 8) & 127) + ":" + bcd(data.rtc & 127)
    : "未启用";
  $("rtc-date").textContent = data.rtcEnabled
    ? "20" + bcd((data.date >>> 16) & 255) + "-" + bcd((data.date >>> 8) & 31) + "-" + bcd(data.date & 63) +
      " · 星期" + "一二三四五六日"[(((data.date >>> 13) & 7) || 1) - 1]
    : "—";
  $("rtc-note").textContent =
    data.rtcEnabled && data.rtcPeriod
      ? "按 RTC 时钟与分频运行：1 秒 = " + (data.rtcPeriod / 1000).toFixed(3) + " s 仿真时间"
      : "跟随仿真时间运行，初值由固件设置";
  if (data.eeprom) {
    board.eeprom = Uint8Array.from(data.eeprom);
    renderEEPROM(data.written || []);
    saveEEPROM();
  }
  $("unsupported").textContent = data.unknown.length
    ? "当前程序访问了尚未支持的外设地址：" + data.unknown.join("、") + "。这些访问采用空模型，结果不保证正确。"
    : "未检测到未支持的外设区域访问；这不代表所有寄存器行为均已覆盖。";
  if (data.unknown.length && !errorState) {
    $("alert").hidden = false;
    $("alert").textContent = "发现未支持的外设访问，结果可能不完整。点“使用说明”查看地址。";
  }
  if (data.ms < lastMs) trend.clear();
  lastMs = data.ms;
  for (const sample of data.history) {
    const [ms, ...values] = sample;
    PINS.forEach((pin, i) => {
      if (!trend.has(pin)) trend.set(pin, []);
      const list = trend.get(pin);
      list.push([ms, values[i]]);
      while (list.length && list[0][0] < ms - 10000) list.shift();
    });
  }
  drawTrend(data.ms);
}
function renderOutputs(data) {
  const rows = data.outputs.map((o) => {
    let source = "未配置",
      hz = "—",
      duty = "—";
    if (o.kind === "timer") {
      source = o.source + (o.enabled ? "" : " · 未输出");
      if (o.enabled) {
        hz = fmtHz(o.hz);
        duty = o.duty === null ? "比较模式 " + o.mode : o.duty.toFixed(1) + "%";
      }
    } else if (o.kind === "gpio") {
      source = "GPIO 输出";
      duty = o.level ? "高电平" : "低电平";
    } else if (o.kind === "capture") source = o.source + " · 输入";
    else if (o.kind === "af") source = "AF" + o.af;
    else if (o.kind === "analog") source = "模拟";
    else if (o.kind === "input") source = "GPIO 输入";
    return "<tr><td>" + o.pin + "</td><td>" + source + "</td><td>" + hz + "</td><td>" + duty + "</td></tr>";
  });
  const html = rows.join("");
  if ($("pwm-rows").innerHTML !== html) $("pwm-rows").innerHTML = html;
}
function drawTrend(now) {
  const canvas = $("trend"),
    g = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height,
    list = trend.get($("trend-pin").value) || [];
  g.clearRect(0, 0, w, h);
  g.strokeStyle = "#e3ebe5";
  g.lineWidth = 1;
  // 顶部 24 px 留给文字，曲线画在下方。
  const top = 24,
    span = h - top - 6;
  for (let y = 0; y <= 4; y++) {
    g.beginPath();
    g.moveTo(0, top + (y * span) / 4);
    g.lineTo(w, top + (y * span) / 4);
    g.stroke();
  }
  if (!list.length) return;
  const x = (ms) => w - ((now - ms) / 10000) * w,
    maxHz = Math.max(1, ...list.map(([, v]) => (v ? v[0] : 0)));
  const line = (pick, style, dash) => {
    g.strokeStyle = style;
    g.setLineDash(dash);
    g.lineWidth = 2;
    g.beginPath();
    let open = false;
    for (const [ms, v] of list) {
      if (!v) {
        open = false;
        continue;
      }
      const y = top + (1 - pick(v)) * span;
      if (open) g.lineTo(x(ms), y);
      else g.moveTo(x(ms), y);
      open = true;
    }
    g.stroke();
  };
  line((v) => (v[1] === null ? 0 : v[1] / 100), "#16877f", []);
  line((v) => v[0] / maxHz, "#c69c29", [5, 4]);
  g.setLineDash([]);
  g.fillStyle = "#788c8a";
  g.font = "11px Consolas, monospace";
  const last = list[list.length - 1][1];
  g.fillText(
    "100%  ·  峰值 " + fmtHz(maxHz) + (last ? "  ·  当前 " + fmtHz(last[0]) + " / " + (last[1] === null ? "—" : last[1].toFixed(1) + "%") : ""),
    6,
    16,
  );
}
$("firmware").addEventListener("change", async (event) => {
  const candidate = event.target.files[0];
  if (!candidate) return;
  if (candidate.size > 16 * 1024 * 1024) {
    showError("文件超过 16 MB，请选择 G431 的 ELF / AXF / HEX。");
    return;
  }
  file = candidate;
  bytes = await file.arrayBuffer();
  $("file-name").textContent = file.name;
  createWorker(false, true);
});
$("choose-file").onclick = () => $("firmware").click();
$("run").onclick = () => post({ type: "run" });
$("pause").onclick = () => post({ type: "pause" });
$("reset").onclick = () => {
  if (bytes) createWorker(false);
};
$("power").onclick = () => {
  if (bytes) createWorker(false, true);
};
$("speed").onchange = () => post({ type: "speed", value: Number($("speed").value) });
$("timing").onchange = () => {
  board.timing = $("timing").value;
  localStorage.setItem(STORE + "timing", board.timing);
  post({ type: "timing", value: board.timing });
};
$("mcp-ohms").onchange = () => {
  board.mcpOhms = Number($("mcp-ohms").value);
  localStorage.setItem(STORE + "mcp", board.mcpOhms);
  post({ type: "mcp-ohms", value: board.mcpOhms });
};
$("eeprom-clear").onclick = () => {
  if (!confirm("把 EEPROM 的 256 字节全部写成 0xFF？浏览器里保存的内容也会清除。")) return;
  board.eeprom.fill(0xff);
  saveEEPROM();
  renderEEPROM();
  post({ type: "eeprom-fill", value: 0xff });
};
$("trend-pin").onchange = () => drawTrend(lastMs);
function key(index, down) {
  if (!loaded) return;
  document.querySelector('[data-key="' + index + '"]').classList.toggle("pressed", down);
  post({ type: "key", index, down });
}
// Shift + 点击或右键：锁定按下，再点一次松开，便于鼠标做组合键。
function toggleLatch(el) {
  const index = Number(el.dataset.key),
    on = !latched.has(index);
  if (on) latched.add(index);
  else latched.delete(index);
  el.classList.toggle("latched", on);
  key(index, on);
}
document.querySelectorAll(".key").forEach((el) => {
  el.oncontextmenu = (event) => {
    event.preventDefault();
    toggleLatch(el);
  };
  el.onpointerdown = (event) => {
    if (event.button === 2) return;
    event.preventDefault();
    if (event.shiftKey || latched.has(Number(el.dataset.key))) {
      toggleLatch(el);
      return;
    }
    el.setPointerCapture(event.pointerId);
    key(Number(el.dataset.key), true);
  };
  el.onpointerup =
    el.onpointercancel =
    el.onlostpointercapture =
      () => {
        if (!latched.has(Number(el.dataset.key))) key(Number(el.dataset.key), false);
      };
  el.onkeydown = (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      key(Number(el.dataset.key), true);
    }
  };
  el.onkeyup = (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      key(Number(el.dataset.key), false);
    }
  };
});
document.addEventListener("keydown", (e) => {
  if (
    !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) &&
    /^[1-4]$/.test(e.key) &&
    !e.repeat
  ) {
    e.preventDefault();
    key(Number(e.key) - 1, true);
  }
});
document.addEventListener("keyup", (e) => {
  if (/^[1-4]$/.test(e.key) && !latched.has(Number(e.key) - 1)) key(Number(e.key) - 1, false);
});
window.addEventListener("blur", () => {
  for (let i = 0; i < 4; i++) if (!latched.has(i)) key(i, false);
});
for (let i = 0; i < 2; i++)
  $("adc" + i).oninput = () => {
    const value = Number($("adc" + i).value);
    $("adc" + i + "-value").innerHTML = value.toFixed(2) + " <small>V</small>";
    post({ type: "analog", index: i, value });
  };
document.querySelectorAll(".signal").forEach((el) => {
  el.oninput = () => {
    const value = Number(el.value);
    $(el.id + "-value").innerHTML = value.toLocaleString() + " <small>Hz</small>";
    post({ type: "signal", pin: el.dataset.pin, value });
  };
});
$("serial-form").onsubmit = (e) => {
  e.preventDefault();
  if (!loaded) return;
  const text = $("serial-input").value + ($("newline").checked ? "\r\n" : "");
  post({ type: "uart", text });
  $("serial-input").value = "";
};
$("clear-serial").onclick = () => {
  serialOffset = lastSerial.length;
  $("serial").textContent = "";
};
$("help-button").onclick = () => $("help").showModal();
$("alert").onclick = () => ($("alert").hidden = true);
$("readme-link").href = "README.md";
$("about-button").onclick = () => $("about").showModal();
// 点击弹窗外的遮罩关闭
for (const d of [$("about"), $("help")])
  d.onclick = (e) => {
    if (e.target === d) d.close();
  };
$("copy-qq").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("qq-group").textContent);
    $("copy-qq").textContent = "已复制";
  } catch {
    getSelection().selectAllChildren($("qq-group"));
    $("copy-qq").textContent = "已选中，请按 Ctrl+C";
  }
  setTimeout(() => ($("copy-qq").textContent = "复制群号"), 2000);
};
if (location.protocol === "file:")
  showError(
    "请使用项目中的启动脚本，或把 site 目录部署到 GitHub Pages；浏览器不允许 file:// 页面启动仿真 Worker。",
  );
