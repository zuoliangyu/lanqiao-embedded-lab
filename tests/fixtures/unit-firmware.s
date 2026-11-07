@ 单元测试固件：TIM2 捕获中断、EXTI0 中断、FPU 现场保护、超长浮点直线代码。
@ 生成：arm-none-eabi-as -o fw.o unit-firmware.s
@       arm-none-eabi-ld -Ttext=0x08000200 --section-start=.vectors=0x08000000 -e reset -o fw.elf fw.o
@       arm-none-eabi-objcopy -O ihex fw.elf unit-firmware.hex
  .syntax unified
  .cpu cortex-m4
  .fpu fpv4-sp-d16
  .thumb
  .section .vectors, "a"
  .word 0x20008000
  .word reset + 1
  .rept 4
  .word fault + 1
  .endr
  .fill 10, 4, 0         @ 6-15（含 SysTick）
  .fill 6, 4, 0          @ IRQ0-5
  .word exti0 + 1        @ IRQ6 EXTI0
  .fill 21, 4, 0         @ IRQ7-27
  .word tim2 + 1         @ IRQ28 TIM2
  .fill 73, 4, 0
  .text
  .thumb_func
  .global reset
reset:
  ldr r0, =0xE000ED88    @ CPACR：开启 CP10/CP11
  ldr r1, =0x00F00000
  str r1, [r0]
  dsb
  isb
  ldr r4, =0x20000000
  vmov.f32 s0, #1.0
loop:
  vstr s0, [r4]          @ 主循环保存 s0；中断若破坏 s0，这里会写出 3.0
  ldr r1, [r4, #12]
  cmp r1, #0
  beq loop
  bl longfloat
  movs r1, #0
  str r1, [r4, #12]
  b loop
  .thumb_func
tim2:
  ldr r0, =0x40000034    @ TIM2->CCR1
  ldr r1, [r0]
  ldr r2, =0x20000000
  str r1, [r2, #4]       @ 最后一次捕获值
  ldr r3, [r2, #8]
  adds r3, #1
  str r3, [r2, #8]       @ 捕获中断次数
  vmov.f32 s0, #3.0      @ 故意破坏 s0
  ldr r0, =0x40000010    @ TIM2->SR 清零
  movs r1, #0
  str r1, [r0]
  ldr r0, =0x40000024    @ TIM2->CNT 清零（“软件清计数器”式测频）
  str r1, [r0]
  bx lr
  .thumb_func
exti0:
  ldr r2, =0x20000000
  ldr r3, [r2, #16]
  adds r3, #1
  str r3, [r2, #16]      @ EXTI0 中断次数
  ldr r0, =0x40010414    @ EXTI->PR1 写 1 清除
  movs r1, #1
  str r1, [r0]
  bx lr
  .thumb_func
longfloat:
  vmov.f32 s1, #1.0
  vsub.f32 s2, s2, s2
  .rept 160
  vadd.f32 s2, s2, s1
  .endr
  vstr s2, [r4, #20]     @ 应为 160.0
  bx lr
  .thumb_func
fault:
  b fault
  .ltorg
