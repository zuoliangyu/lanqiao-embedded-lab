# 蓝桥杯嵌入式在线实验台

`lanqiao-embedded-lab`：面向蓝桥杯嵌入式赛项 CT117E-M4 竞赛板的浏览器仿真实验台。

在线使用：<https://zuoliangyu.github.io/lanqiao-embedded-lab/>

载入 STM32G431RBT6 的 ELF / AXF，在浏览器中执行 ARM 指令，并通过 CT117E-M4 V1.2 的 GPIO 总线驱动 LCD、按键和 LED。计算在浏览器 Web Worker 内进行，GitHub Pages 仅托管静态文件。无需开发板、后端服务或服务器租赁，固件文件不上传。

覆盖竞赛板（不含扩展板）上历届真题常用的外设，已用 BSP、模板和第 12–17 届参考工程验证。它是实验性原型，不保证所有 STM32G431 固件兼容，也不提供周期精确或电气级仿真。

## 本机使用

安装了 Node.js 的 Windows 电脑双击 `start.cmd`，或执行：

```sh
npm start        # 等同于 node serve.cjs，端口可用 PORT 环境变量修改
```

打开 `http://127.0.0.1:8127`，选择 ELF / AXF / HEX，点击“烧录并运行”。可暂停、继续、复位（保留 EEPROM 与 MCP4017）或断电重启（保留 EEPROM）。浏览器支持 WebAssembly 和 BigInt 即可；已在本机 Chromium 验证。不要直接双击 `site/index.html`，`file://` 不允许本项目的 Worker 加载。

LCD 左侧提供 `Line0`～`Line9` 辅助行号，顶部提供 `0`～`19` 列号，按 BSP 默认 16×24 像素字体对齐。行列号位于画面外，不写入 LCD 像素；自定义字体或按像素坐标绘图时，仅作为位置参考。

运行脚本仅用于本地静态预览，不参与固件执行。GitHub Pages 上不需要安装 Node.js。静态资源和内核均随项目提供，没有 CDN 运行依赖。

## GitHub Pages 部署

以下步骤用于自行部署副本。

1. 新建一个 GitHub 仓库。GitHub Free 的 Pages 使用公开仓库。
2. 将本项目根目录的文件提交到仓库 `main` 分支，包括 `site/` 和 `.github/workflows/pages.yml`。不要上传原有 STM32 工程、个人 ELF、AXF 或资源包。
3. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
4. 打开 **Actions → 发布蓝桥杯嵌入式实验台 → Run workflow**。
5. 工作流完成后，在 Pages 设置或工作流的 deployment 输出中打开站点，通常为 `https://用户名.github.io/仓库名/`。

工作流只上传静态文件，不编译固件、不编译 WebAssembly、不运行测试。所有资源使用相对地址，支持仓库子路径部署。Actions 仅做发布，不充当运行后端。GitHub Pages 的带宽和容量规则仍适用。

本仓库推送到 `main` 且 `site/` 有改动时会自动发布到 GitHub Pages；`检查` 工作流运行语法检查与单元测试，CodeQL 每周扫描一次。

## 时序模式

工具栏可切换两种时序，选择保存在浏览器中：

| 模式 | 每仿真毫秒执行的指令 | 特点 |
| --- | --- | --- |
| 快速（默认） | 8000 条 | 页面流畅；CPU 密集的代码比 80 MHz 实物慢约 10 倍，例如整屏清屏约 0.36 s 仿真时间（实物约 0.04 s）。协作式调度的程序在刷新 LCD 期间扫键很少，单击可能要等数秒仿真时间才响应 |
| 精确（按主频） | HCLK / 1000 条（80 MHz 时 80000 条） | 指令数与实物一致，可用于判断“刷新 0.1 s”“按键响应 ≤ 0.1 s”等要求；浏览器中运行明显慢于实时 |

两种模式都不模拟流水线、总线等待或中断延迟。工具栏右侧显示“仿真时间 / 实际时间”的实际倍率。

点按按键时，若固件尚未在 3 个不同毫秒里读到按下电平，松开会延后到读到为止，避免快速模式下整段错过一次短按。按住时长按仿真时间显示在按键下方。

## 已验证固件

使用用户本机已有二进制验证，没有改动或重新编译原工程，也没有把它们打包到网页中。

| 固件 | 结果 |
| --- | --- |
| BSP `HAL_06_LCD.axf` / `LL_06_LCD.axf` | 正确显示 `Hello,world.`；84,096 次像素写入，566 个白色像素 |
| 模板 `STM32_Xifeng.elf` | 启动、SysTick、清屏；B1 按下/释放；ADC DMA；TIM3 捕获 1,000 → 2,000 Hz；USART1 DMA+IDLE 回显 |
| 第 17 届省赛参考 | R39→PB4 测频 4,000 Hz，瞬时流量 20.0 L/min；PA1 输出 10 kHz / 5%；手动模式 TarD 改为 10% 后 2.5 s 时为 8%，最终 10%；f > 8 kHz 点亮 LD1 |
| 第 16 届省赛参考 | R37/R38 满量程时 PA7（TIM17）约 1,900 Hz / 79%（固件按 4095/4096 取整），归零时 1,000 Hz / 10%；PA15（TIM2_CH1）测频 1,500 Hz |
| 第 15 届省赛参考 | PA15（TIM8）1,234 Hz、PB4（TIM3）15 kHz 双通道测频；15 kHz 读成 15,151 Hz 是 1 MHz 计数下周期取整，与实物一致 |
| 第 13 届国赛参考 | 参数经 PB6/PB7 软件 I²C 写入 M24C02 地址 0/4，重新上电读回；串口 `#` 切换 R01/R60，LCD 旋转 180° |
| 第 12–17 届其他参考工程（共 25 个） | 均运行 2 s 无异常，无未支持外设访问 |

第 13 届省赛参考工程调用了模板里的 `pwm_set_frequency`，该函数把时钟写死为 72 MHz 且未计入 PSC，实物输出约 6.5 Hz；仿真显示的 7 Hz 是固件真实行为。第 15 届国赛参考工程的 `lcd_proc()` 为空，黑屏也是固件本身的行为。

## 仿真范围

| 部分 | 当前实现与边界 |
| --- | --- |
| CPU / 固件 | Unicorn.js ARM WebAssembly；载入 ELF / AXF / Intel HEX；入口向量表必须位于 `0x08000000`。中断进出时保存 S0–S15 与 FPSCR |
| 中断 | NVIC 使能、挂起、优先级与抢占分组（AIRCR.PRIGROUP），可嵌套；SysTick、PendSV、DMA1、ADC1_2、TIM1/2/3/4/6/7/8/15/16/17、USART1、EXTI0–15、RTC 闹钟；`NVIC_SystemReset` 会重新上电并保留 EEPROM |
| 时钟 | HSI/HSE(24 MHz)/PLL、AHB 与 APB1/APB2 分频；APB 分频不为 1 时定时器时钟加倍 |
| LCD | GPIOC 16 位并口，PB9 CS、PB8 RS、PB5 WR、PA8 RD；932X 寄存器/GRAM、窗口、自增和 RGB565；R01 SS 与 R60 GS 翻转显示。UC8230 为实验选项 |
| 按键 / LED / EXTI | B1–B4 低电平有效，可组合；EXTI 上下沿触发与 SYSCFG 端口选择；LED 按 74LS573 透明/锁存更新 |
| ADC | ADC1/ADC2 按 SQR 序列逐通道转换：PB12（IN11）、PB15（ADC2 IN15）、PB14（IN5，MCP4017 分压）；EOC/EOS 标志，DMA、轮询、中断读取；分辨率与左对齐 |
| 定时器 | 计数、预分频、自动重装、更新事件与 URS/UDIS、重复计数；输入捕获（直接/交叉输入、极性、预分频、溢出标志）、复位从模式（PWM 输入测频）、捕获 DMA 与逐边沿中断；PWM1/PWM2/强制电平/翻转模式、互补输出、MOE。按 GPIO 复用识别 PA1/PA2/PA6/PA7/PA15/PB4/PC0 上的通道 |
| 脉冲源 | R39→PB4、R40→PA15 两路 TLC555 方波，0–20 kHz，占空比 50% |
| I²C 器件 | 按 SCL/SDA 电平识别起止条件与 ACK：M24C02（0xA0，256 字节，16 字节页回卷，写后约 5 ms 不应答）；MCP4017（0x5E，7 位滑片，阻值型号可选，与 R17 分压到 PB14）。EEPROM 内容保存在浏览器本地 |
| USART1 | 轮询、RXNE/IDLE/TXE/TC 中断、RX DMA + IDLE、TX DMA；按 BRR 与时钟源计算波特率，偏离 9600 超过 3% 时界面提示；无电气时序 |
| RTC | LSE/LSI/HSE/32 分频与 PREDIV 决定秒长（LSI 默认分频约 1.024 s）；时间、日期（闰年、星期）、亚秒、闹钟 A |
| 未实现 | 扩展板、USB、SPI Flash、CAN、看门狗、低功耗、DAC、比较器、定时器编码器与中心对齐计数细节 |

外围寄存器采用有限行为模型，访问未支持的外设区域会在界面提示，但已识别区域内尚未实现的寄存器行为无法全部自动识别。

Unicorn.js 内核在翻译上百条连续浮点指令的基本块时会中止（`-O3` 展开的累加循环会产生这种代码）。装载时会扫描出这类代码所在的 1 KB 页，执行到这些页时分段翻译；遇到这种情况时文件信息里会显示“已分段执行”。

LCD 画面来自实际 GPIO 写屏，前端没有预设输出，也不通过函数名替换用户的 LCD/HAL 函数。

## 结构

- `site/elf.js`：ELF32 与 Intel HEX 装载、范围检查。
- `site/machine.js`：执行内核适配、时钟、NVIC、GPIO、ADC、DMA、USART、RTC、EXTI 与板级连接。
- `site/timer.js`：通用/高级定时器、引脚复用与 PWM / 捕获。
- `site/i2c.js`：PB6/PB7 总线上的 M24C02 与 MCP4017。
- `site/lcd.js`：LCD 寄存器、GRAM 和横屏像素转换。
- `site/worker.js`：独立线程运行、暂停、输入、复位与画面消息。
- `site/app.js`、`index.html`、`style.css`：实验台界面。三列布局，1920×1080 与 1440×900 浏览器窗口在 100% 缩放下一屏显示全部面板；窗口较矮时自动压缩间距，宽度小于 1200 px 时改为两列。
- `site/vendor/unicorn_arm.js`：固定版本的第三方 ARM WASM 内核，自包含文件。
- `site/README.md`、`LICENSE.txt`、`THIRD_PARTY.md`：根目录同名文件的副本。Pages 只发布 `site/`，GPL 要求许可与源码说明随内核一起分发；修改根目录文件后需同步。
- `site/vendor/source/`：Unicorn.js 与 Unicorn 内核的对应源码包。
- `tests/unit.cjs`、`tests/fixtures/`：外设模型单元测试与自带的测试固件（汇编源码与 HEX）。
- `tests/smoke.cjs`：用 BSP 与模板固件验证屏幕、按键、ADC、捕获及串口。
- `tests/reference.cjs`：用历届参考工程固件做端到端验收。
- `serve.cjs`、`start.cmd`：仅用于本机预览的静态服务器。
- `VALIDATION.md`：验收记录。

## 验证

以下命令不构建固件，固件文件不随项目分发。

```sh
npm run check    # 语法检查
npm test         # 外设单元测试，不需要外部固件
npm run test:smoke -- "路径/HAL_06_LCD.axf" "路径/STM32_Xifeng.elf"
npm run test:reference -- --p17 "17届省赛.axf" --p16 "16届省赛.axf" --p15 "15届省赛.axf" --n13 "13届国赛.axf"
```

屏幕回归校验采用 RGBA SHA-256：

`d17eb71de34d373670b9d1ba100a7a6d0510744bdd165b3b2ab7e18ba62f44bb`

## 作者

左岚 · [哔哩哔哩](https://space.bilibili.com/27619688) · QQ 交流群 1019721429

## 许可

项目代码使用 GPL-2.0-only，与所使用的 Unicorn.js 许可一致，见 `LICENSE`。第三方来源、版本和源码获取方式见 `THIRD_PARTY.md`。网页内核公开不要求上传你在浏览器本地选择的私人固件。
