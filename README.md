# 蓝桥杯嵌入式在线实验台

`lanqiao-embedded-lab`：面向蓝桥杯嵌入式赛项 CT117E-M4 竞赛板的浏览器仿真实验台。

载入 STM32G431RBT6 的 ELF / AXF，在浏览器中执行 ARM 指令，并通过 CT117E-M4 V1.2 的 GPIO 总线驱动 LCD、按键和 LED。计算在浏览器 Web Worker 内进行，GitHub Pages 仅托管静态文件。无需开发板、后端服务或服务器租赁，固件文件不上传。

这是针对已提供 BSP 与 STM32_Xifeng 模板验证的实验性原型，不保证所有 STM32G431 固件兼容，也不提供周期精确或电气级仿真。

## 本机使用

安装了 Node.js 的 Windows 电脑双击 `start.cmd`，或执行：

```sh
npm start        # 等同于 node serve.cjs，端口可用 PORT 环境变量修改
```

打开 `http://127.0.0.1:8127`，选择 ELF / AXF，点击“烧录并运行”。可暂停、继续、复位。浏览器支持 WebAssembly 和 BigInt 即可；已在本机 Chromium 验证。不要直接双击 `site/index.html`，`file://` 不允许本项目的 Worker 加载。

LCD 左侧提供 `Line0`～`Line9` 辅助行号，顶部提供 `0`～`19` 列号，按 BSP 默认 16×24 像素字体对齐。行列号位于画面外，不写入 LCD 像素；自定义字体或按像素坐标绘图时，仅作为位置参考。

运行脚本仅用于本地静态预览，不参与固件执行。GitHub Pages 上不需要安装 Node.js。静态资源和内核均随项目提供，没有 CDN 运行依赖。

## GitHub Pages 部署

1. 新建一个 GitHub 仓库。GitHub Free 的 Pages 使用公开仓库。
2. 将本项目根目录的文件提交到仓库 `main` 分支，包括 `site/` 和 `.github/workflows/pages.yml`。不要上传原有 STM32 工程、个人 ELF、AXF 或资源包。
3. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
4. 打开 **Actions → 发布蓝桥杯嵌入式实验台 → Run workflow**。
5. 工作流完成后，在 Pages 设置或工作流的 deployment 输出中打开站点，通常为 `https://用户名.github.io/仓库名/`。

工作流只上传静态文件，不编译固件、不编译 WebAssembly、不运行测试。所有资源使用相对地址，支持仓库子路径部署。Actions 仅做发布，不充当运行后端。GitHub Pages 的带宽和容量规则仍适用。

项目已初始化为本地 git 仓库，尚未创建远程仓库或执行公开发布。

## 已验证固件

使用用户本机已有二进制验证，没有改动或重新编译原工程，也没有把它们打包到网页中。

| 固件 | 结果 |
| --- | --- |
| BSP `HAL_06_LCD.axf` | 原始 ARM 指令产生 84,096 次像素写入；正确显示 `Hello,world.`；非黑色像素为 566 个白色像素 |
| 模板 `STM32_Xifeng.elf` | 启动、SysTick、LCD 清黑完成；B1 按下/释放使固件 `key_val` 变成 1/0 |
| 同一模板的 ADC / DMA | 输入 0.825 V 与 2.475 V，DMA 原始采样分别为 1024 / 3071；固件浮点计算结果随输入改变 |
| 同一模板的捕获 / PWM | 捕获输入从 1,000 Hz 改为 2,000 Hz，固件结果相应改变；PWM 为约 470.588 Hz、5% |
| 同一模板的 USART1 | 页面输入经 DMA 与 IDLE 中断进入固件，固件回显 `ringbuffer data: ct117e-test` |

当前模板源码中的 `lcd_proc()` 为空，启动仅清黑。该 ELF 保持黑屏是程序的实际行为；可使用 BSP 的 HAL LCD 示例确认显示链路。

有多个不同的 AXF/ELF 构建产物时，它们不一定对应当前源码。本次模板验收使用 `MDK-ARM/build/STM32_Xifeng/STM32_Xifeng.elf`。

## 仿真范围

| 部分 | 当前实现与边界 |
| --- | --- |
| CPU / ELF | 复用 Unicorn.js ARM WebAssembly；执行 ELF / AXF 中的代码，支持 Thumb、模板涉及的浮点运算；入口向量表必须位于 `0x08000000` |
| 内存 | 128 KB Flash、32 KB SRAM 地址窗口、CCM 独立窗口；尚未完整建模 SRAM/CCM 别名、bit-band、Flash 擦写与保护 |
| 启动 | RCC、PWR、Flash 等 HAL 初始化需要的基本寄存器行为；晶振和 PLL 就绪采用立即响应 |
| 中断 | 基础 SysTick 和模板使用的 DMA1 / USART1 中断；不支持完整中断优先级、嵌套、PSP 上下文切换、FPU 扩展异常栈、RTOS 与所有异常语义 |
| LCD | GPIOC 16 位并口，PB9 CS、PB8 RS、PB5 WR、PA8 RD；932X 的寄存器/GRAM、窗口、游标自增和 RGB565；默认 9325 ID。UC8230 为实验选项，未列入本次验收 |
| 按键 / LED | B1–B4 对应 PB0/PB1/PB2/PA0，低电平有效；LED 根据 PC8–PC15 和 PD2 的 74LS573 透明/锁存行为更新 |
| ADC / DMA | 对应模板 ADC1/ADC2 的模拟输入、DMA1 循环传输和半满/完成标志；采样频率、转换延时及 DMAMUX 路由约束未完整建模 |
| TIM | 模板的 TIM3 CH1 输入捕获及 DMA；TIM1 CH1 / TIM2 CH2 的 PWM 参数读出。时钟计算覆盖本次 HSI/PLL、总线不分频配置，不保证其他分频配置 |
| RTC | 基础 BCD 时间寄存器和逻辑时间推进；日期跨日、闹钟、校准等未实现 |
| USART1 | 轮询发送/接收、模板使用的 RX DMA/IDLE 中断；无电气波特率时序模拟 |
| 未实现 | USB、SPI Flash、I²C EEPROM / MCP4017、CAN、其他 ADC/TIM 通道及复杂芯片功能 |

外围寄存器采用有限行为模型，部分寄存器仅保存写入值。访问未支持的外设区域会在界面提示，但已识别区域内尚未实现的寄存器行为无法全部自动识别。“没有未支持区域”不等于完全兼容。

逻辑时间由执行批次推进：一个主循环执行批次最多 8,000 条指令，推进 1 ms，并根据 SysTick 配置产生节拍；中断处理另有有限指令预算。运行倍率控制目标逻辑时间推进速度，实际速度受电脑性能影响。这不能用于测量真实 CPU 性能、精密延时或硬件中断延迟。

LCD 画面来自实际 GPIO 写屏，前端没有预设 `Hello,world.` 或根据文件名伪造输出。模型也不通过函数名替换用户的 LCD/HAL 函数。

## 结构

- `site/elf.js`：ELF32 装载和范围检查。
- `site/machine.js`：执行内核适配、G431 的有限外设与板级连接。
- `site/lcd.js`：LCD 寄存器、GRAM 和横屏像素转换。
- `site/worker.js`：独立线程运行、暂停、输入及画面消息。
- `site/app.js`、`index.html`、`style.css`：实验台界面。
- `site/vendor/unicorn_arm.js`：固定版本的第三方 ARM WASM 内核，自包含文件。
- `site/README.md`、`LICENSE.txt`、`THIRD_PARTY.md`：根目录同名文件的副本。Pages 只发布 `site/`，GPL 要求许可与源码说明随内核一起分发；修改根目录文件后需同步。
- `site/vendor/source/`：Unicorn.js 与 Unicorn 内核的对应源码包。
- `tests/smoke.cjs`：用现有固件验证屏幕、按键、ADC、捕获及串口的针对性检查。
- `serve.cjs`、`start.cmd`：仅用于本机预览的静态服务器。
- `VALIDATION.md`：验收记录。

## 验证

以下命令不构建固件，通常数秒完成。需提供对应本地文件路径，二进制未随项目分发。

```sh
npm run check    # 语法检查，不需要固件
npm test -- "路径/HAL_06_LCD.axf" "路径/STM32_Xifeng.elf"
```

屏幕回归校验采用 RGBA SHA-256：

`d17eb71de34d373670b9d1ba100a7a6d0510744bdd165b3b2ab7e18ba62f44bb`

## 许可

项目代码使用 GPL-2.0-only，与所使用的 Unicorn.js 许可一致，见 `LICENSE`。第三方来源、版本和源码获取方式见 `THIRD_PARTY.md`。网页内核公开不要求上传你在浏览器本地选择的私人固件。
