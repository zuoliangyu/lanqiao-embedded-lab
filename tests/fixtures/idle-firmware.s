@ 空闲跳过测试固件：SysTick 1 kHz 递增 tick；主程序按 mode 选择“等 tick”或“软件延时”。
@ 0x20000100 tick      0x20000104 等 tick 循环的处理次数
@ 0x20000108 mode      0x2000010c 软件延时循环计数
@ 生成：arm-none-eabi-as -o idle.o idle-firmware.s
@       arm-none-eabi-ld -Ttext=0x08000200 --section-start=.vectors=0x08000000 -e reset -o idle.elf idle.o
@       arm-none-eabi-objcopy -O ihex idle.elf idle-firmware.hex
  .syntax unified
  .cpu cortex-m4
  .thumb
  .section .vectors, "a"
  .word 0x20008000
  .word reset + 1
  .rept 13
  .word fault + 1
  .endr
  .word systick + 1      @ 15 SysTick
  .text
  .global reset
  .thumb_func
reset:
  ldr r0, =0xE000E014    @ SysTick LOAD：16 MHz HSI / 1000 - 1
  ldr r1, =15999
  str r1, [r0]
  ldr r0, =0xE000E010    @ CTRL：处理器时钟、中断、使能
  movs r1, #7
  str r1, [r0]
  ldr r4, =0x20000100
wait:
  ldr r1, [r4, #8]       @ mode = 1：软件延时
  cmp r1, #1
  beq delay
  ldr r2, [r4]           @ 等 tick 变化
  cmp r2, r5
  beq wait
  mov r5, r2
  ldr r3, [r4, #4]
  adds r3, #1
  str r3, [r4, #4]
  b wait
delay:
  ldr r3, [r4, #12]      @ 不读 tick 的纯计数循环，不应被跳过
  adds r3, #1
  str r3, [r4, #12]
  b delay
  .thumb_func
systick:
  ldr r0, =0x20000100
  ldr r1, [r0]
  adds r1, #1
  str r1, [r0]
  bx lr
  .thumb_func
fault:
  b fault
  .ltorg
