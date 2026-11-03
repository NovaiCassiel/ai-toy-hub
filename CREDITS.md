# 致谢与第三方说明

本项目的代码是独立编写的，但下面这些开源项目和分享给了协议、数据或思路，在此感谢。

## 直接用到的协议与数据

- **[Toy-Relay-AI-mcp-SOSEXY](https://github.com/tutu-kitty/Toy-Relay-AI-mcp-SOSEXY)**（@miao_tutu，MIT）
  「云端 MCP + 手机浏览器网页蓝牙中继」的整体思路，以及啵啵贝 (SOSEXY) 蓝牙协议文档。
- **[sosexy-ble-control](https://github.com/51enuxu/sosexy-ble-control)**（MIT）
  啵啵贝蓝牙协议的原始逆向（12 字节帧、马达模式字节）。
- **[Buttplug.io](https://github.com/buttplugio/buttplug)**（BSD-3-Clause）
  Lovense 的蓝牙服务 UUID 清单和指令格式来自它公开的设备配置；Intiface Central 作为可选后端。
- **[Make Me a Hanzi](https://github.com/skishore/makemeahanzi) / [hanzi-writer-data](https://github.com/chanind/hanzi-writer-data)**（字形数据使用 Arphic Public License）
  画布按笔顺写字用的汉字笔顺中线。运行时按需从 CDN 获取，不随本项目分发。
- **[MediaPipe Tasks Audio](https://github.com/google-ai-edge/mediapipe)** 与 **YAMNet** 模型（Apache-2.0）
  在手机本地识别环境声音。首次使用时下载，不随本项目分发。

## 服务

- **[ElevenLabs](https://elevenlabs.io)**：可选的语音合成和语音转文字，需要自备账号。

## 启发（只借鉴想法，没有使用代码）

- @kattieloty 关于给 AI 搭建玩具控制台、绘制强度曲线的分享 → 画布玩法。
- [hervoice](https://github.com/fishisfish0614/hervoice)（@onecrazyfishhh）→ 不只听字，也听语气。
- [ai-hears-your-body](https://aria-duet.github.io/ai-hears-your-body/)（@Ariakittyyy）→ 让 AI 听见身体的声音。
- [AI 爱人的嗓子系列](https://github.com/sanqianzilanyue/ai-voice-breath-kiss-water-4)（@Fayelunaire）、@Sumikazzz 的拟声词分享、[voice-design-prompt-guide](https://github.com/3265807971-cloud/voice-design-prompt-guide) → 语气标签和声音设计。
