/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const $ = (id) => document.getElementById(id);
let worker,
  file,
  bytes,
  loaded = false,
  lastSerial = "",
  serialOffset = 0,
  errorState = false;
const ctx = $("lcd").getContext("2d");
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
const setStatus = (text, running = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("running", running);
};
const showError = (message) => {
  $("alert").hidden = false;
  $("alert").textContent = message;
  errorState = true;
  setStatus("运行中止");
  $("pause").disabled = true;
  $("run").disabled = true;
};
function post(data) {
  if (worker) worker.postMessage(data);
}
function createWorker(run) {
  if (worker) worker.terminate();
  loaded = false;
  errorState = false;
  lastSerial = "";
  serialOffset = 0;
  document
    .querySelectorAll(".key")
    .forEach((el) => el.classList.remove("pressed"));
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
      $("screen-empty").hidden = true;
      $("file-info").textContent =
        (data.size / 1024).toFixed(1) + " KB · ARM ELF · 文件未上传";
      post({ type: "speed", value: Number($("speed").value) });
      for (let i = 0; i < 2; i++)
        post({ type: "analog", index: i, value: Number($("adc" + i).value) });
      post({ type: "frequency", value: Number($("frequency").value) });
    } else if (data.type === "error")
      showError(
        data.message + (data.pc ? " · PC 0x" + data.pc.toString(16) : ""),
      );
    else if (data.type === "state") {
      if (!errorState)
        setStatus(data.running ? "运行中" : "已暂停", data.running);
      $("run").disabled = data.running || !loaded || errorState;
      $("pause").disabled = !data.running;
      $("sim-time").innerHTML =
        (data.ms / 1000).toFixed(3) + " <small>s</small>";
      $("pc").textContent =
        "0x" + data.pc.toString(16).padStart(8, "0").toUpperCase();
      $("lcd-writes").textContent =
        data.pixels.toLocaleString() + " 次像素写入";
      if (data.frame)
        ctx.putImageData(new ImageData(data.frame, 320, 240), 0, 0);
      document.querySelectorAll(".led").forEach((led, i) => {
        const on = !!(data.leds & (1 << i));
        led.classList.toggle("on", on);
        led.setAttribute(
          "aria-label",
          "LED " + (i + 1) + (on ? " 点亮" : " 熄灭"),
        );
      });
      if (data.serial !== lastSerial) {
        lastSerial = data.serial;
        $("serial").textContent =
          data.serial.slice(serialOffset) || "等待 USART1 输出…";
        $("serial").scrollTop = $("serial").scrollHeight;
      }
      data.pwm.forEach(
        (p, i) =>
          ($("pwm" + i).textContent = p.enabled
            ? p.hz.toFixed(1) + " Hz / " + p.duty.toFixed(1) + "%"
            : "未启用"),
      );
      const bcd = (x) =>
        ((x >>> 4) * 10 + (x & 15)).toString().padStart(2, "0");
      $("rtc").textContent = data.rtcEnabled
        ? bcd((data.rtc >>> 16) & 63) +
          ":" +
          bcd((data.rtc >>> 8) & 127) +
          ":" +
          bcd(data.rtc & 127)
        : "未启用";
      $("unsupported").textContent = data.unknown.length
        ? "当前程序访问了尚未支持的外设地址：" +
          data.unknown.join("、") +
          "。这些访问采用空模型，结果不保证正确。"
        : "未检测到未支持的外设区域访问；这不代表所有寄存器行为均已覆盖。";
      if (data.unknown.length && !errorState) {
        $("alert").hidden = false;
        $("alert").textContent =
          "发现未支持的外设访问，结果可能不完整。展开下方“兼容范围”查看地址。";
      }
    }
  };
  const copy = bytes.slice(0);
  worker.postMessage(
    { type: "load", bytes: copy, lcdId: Number($("lcd-model").value), run },
    [copy],
  );
}
$("firmware").addEventListener("change", async (event) => {
  const candidate = event.target.files[0];
  if (!candidate) return;
  if (candidate.size > 16 * 1024 * 1024) {
    showError("文件超过 16 MB，请选择 G431 的 ELF / AXF。");
    return;
  }
  file = candidate;
  bytes = await file.arrayBuffer();
  $("file-name").textContent = file.name;
  createWorker(false);
});
$("choose-file").onclick = () => $("firmware").click();
$("run").onclick = () => post({ type: "run" });
$("pause").onclick = () => post({ type: "pause" });
$("reset").onclick = () => {
  if (bytes) createWorker(false);
};
$("speed").onchange = () =>
  post({ type: "speed", value: Number($("speed").value) });
function key(index, down) {
  if (!loaded) return;
  document
    .querySelector('[data-key="' + index + '"]')
    .classList.toggle("pressed", down);
  post({ type: "key", index, down });
}
document.querySelectorAll(".key").forEach((el) => {
  el.onpointerdown = (event) => {
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    key(Number(el.dataset.key), true);
  };
  el.onpointerup =
    el.onpointercancel =
    el.onlostpointercapture =
      () => key(Number(el.dataset.key), false);
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
    /^[1-4]$/.test(e.key)
  ) {
    e.preventDefault();
    key(Number(e.key) - 1, true);
  }
});
document.addEventListener("keyup", (e) => {
  if (/^[1-4]$/.test(e.key)) key(Number(e.key) - 1, false);
});
window.addEventListener("blur", () => {
  for (let i = 0; i < 4; i++) key(i, false);
});
for (let i = 0; i < 2; i++)
  $("adc" + i).oninput = () => {
    const value = Number($("adc" + i).value);
    $("adc" + i + "-value").innerHTML = value.toFixed(2) + " <small>V</small>";
    post({ type: "analog", index: i, value });
  };
$("frequency").oninput = () => {
  const value = Number($("frequency").value);
  $("frequency-value").innerHTML =
    value.toLocaleString() + " <small>Hz</small>";
  post({ type: "frequency", value });
};
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
$("help-button").onclick = () => {
  $("help").open = true;
  $("help").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
};
$("readme-link").href = "README.md";
if (location.protocol === "file:")
  showError(
    "请使用项目中的启动脚本，或把 site 目录部署到 GitHub Pages；浏览器不允许 file:// 页面启动仿真 Worker。",
  );
