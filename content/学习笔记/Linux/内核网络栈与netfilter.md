---
title: "内核网络栈与 netfilter：一个包从网卡到 socket"
date: 2026-11-13
tags:
  - "Linux"
  - "内核"
  - "网络"
  - "后端"
  - "学习笔记"
---

> 前面几篇讲 epoll 事件循环、TCP 状态机和长连接治理，都是应用视角。这篇往内核里走一层：包从网卡进来经过哪些队列和钩子、出站经过哪里、iptables/conntrack 在哪一步生效，以及「抓包抓到了但应用没收到」这类问题该怎么定位。

## 一、收包路径

```text
① 网卡 DMA 把帧写到 ring buffer（内存）
② 硬中断通知 CPU → 触发 NAPI 软中断，关闭中断改为轮询批量收包
③ 分配 sk_buff，经驱动 → 链路层 → IP 层（校验、路由、分片重组）
④ 经过 netfilter 的 PREROUTING / INPUT hook
⑤ TCP 层处理序号、确认、拥塞控制，数据放入 socket 接收缓冲区
⑥ 应用 recv/read 从接收缓冲区拷贝到用户态
```

几个关键点：

| 环节            | 为什么重要                                               |
| --------------- | -------------------------------------------------------- |
| ring buffer     | 突发流量超过 Ring Size 会在网卡层丢包，应用毫无感知      |
| NAPI            | 高包量时从「每包一中断」改成轮询，避免软中断把 CPU 打满  |
| `sk_buff`       | 包的元数据载体，各层在它上面增删协议头，避免反复拷贝     |
| 软中断 `si`     | `mpstat` 里 `si` 高说明 CPU 花在收包上，需看多队列与 RPS |
| socket 接收缓冲 | 应用读不过来时 `Recv-Q` 堆积，最终触发接收窗口收缩与丢包 |

**NAPI 是理解 `si` 的关键**：中断太多会耗尽 CPU，纯轮询又增加延迟，所以内核用「中断唤醒 + 轮询一批 + 预算用尽再开中断」折中。这也意味着 PPS 极高的机器上，单核软中断可能成为瓶颈，需要 RSS/RPS 把包分散到多核。

## 二、发包路径与排队

```text
应用 write → socket 发送缓冲区 → TCP 分段与拥塞窗口控制
   → IP 路由 → netfilter OUTPUT/POSTROUTING → qdisc 队列
   → 驱动发送队列 → 网卡 DMA → 网线
```

`qdisc`（队列规则）决定包的排队、限速与调度：

| qdisc             | 用途                                     |
| ----------------- | ---------------------------------------- |
| `fq` / `fq_codel` | 按流公平排队、主动丢弃以抑制 bufferbloat |
| `pfifo_fast`      | 传统简单 FIFO                            |
| `htb` / `tbf`     | 限速与流量整形                           |
| `noqueue`         | 虚拟设备（如 loopback、veth）常见        |

**bufferbloat** 是常见但难查的延迟来源：队列过长时包不丢，但排队延迟飙升，表现为「带宽跑满了、P99 却很差」。用 `tc -s qdisc show` 看队列长度与丢包，`fq_codel` 通过控制排队时延而非单纯丢弃来缓解。

## 三、netfilter 的五个钩子

```text
入站: PREROUTING → [路由判断] → INPUT（本机）或 FORWARD（转发）
出站: OUTPUT → POSTROUTING
```

| 表       | 主要用途                  | 常用链                                  |
| -------- | ------------------------- | --------------------------------------- |
| `filter` | 放行/丢弃                 | INPUT / FORWARD / OUTPUT                |
| `nat`    | 地址与端口转换            | PREROUTING（DNAT）/ POSTROUTING（SNAT） |
| `mangle` | 改标记、TTL、MSS          | 各 hook                                 |
| `raw`    | 连接跟踪前处理（NOTRACK） | PREROUTING / OUTPUT                     |

规则按顺序匹配，链很长时每个包都要线性走一遍，高 PPS 下会成为 CPU 热点。`nftables` 用统一的规则集与集合（set/map）改善这一点，也支持按前缀/端口做集合匹配，避免上万条线性规则。

**连接跟踪（conntrack）** 是 NAT 与状态防火墙的基础：内核为每条连接记一条条目（含状态、双方地址端口、超时）。表满是经典线上故障：

```text
dmesg: nf_conntrack: table full, dropping packet
```

常见于大流量 NAT 网关、K8s 节点、短连接风暴。排查与调整：

```bash
conntrack -S                                   # 统计（entries、dropped、insert_failed）
sysctl net.netfilter.nf_conntrack_max          # 表大小
sysctl net.netfilter.nf_conntrack_count        # 当前条目
conntrack -L | head                            # 看具体连接与状态
```

调大表要同步评估内存（每条连接占几百字节），更重要的是**缩短超时或让高并发短连接走长连接/连接池**；对不需要跟踪的流量可用 `raw` 表 `NOTRACK` 豁免。

## 四、抓包点：抓到不等于收到

`tcpdump` 基于 `AF_PACKET`，在很早的位置拿到包副本：

```text
入站：tcpdump 通常先于 netfilter 看到包
出站：tcpdump 看到包，也不代表它一定被网卡发出
```

所以：

- **抓到 SYN 但没有 SYN-ACK**：可能是 iptables DROP、路由错误、监听队列满、或包根本没到正确 netns。
- **抓到包但应用没读到**：查 netfilter 丢包计数、conntrack、以及 socket 接收缓冲是否溢出。
- **容器场景**：包可能停留在宿主机 netns 或 veth 另一端，要在正确的 netns 里抓（`nsenter -t <pid> -n tcpdump ...`）。

K8s 里还有个常见开关 `bridge-nf-call-iptables`：让桥接流量也经过 iptables，否则 Service/NetworkPolicy 规则可能不生效；打开后也可能让本来直通的 Pod 流量被意外拦截。

## 五、分层定位丢包

| 层          | 证据                          | 命令                                      |
| ----------- | ----------------------------- | ----------------------------------------- |
| 网卡/驱动   | rx_missed、rx_no_buffer 增长  | `ethtool -S eth0`                         |
| ring buffer | 丢包计数                      | `ethtool -g eth0`、`ethtool -G`           |
| 软中断      | 丢包与时间挤压                | `/proc/net/softnet_stat`、`mpstat -P ALL` |
| 协议栈      | UDP/TCP 层丢包与溢出          | `netstat -su`、`nstat -az`                |
| 监听队列    | ListenDrops / ListenOverflows | `nstat -az TcpExtListenDrops`、`ss -lnt`  |
| socket      | 接收缓冲溢出、应用读慢        | `ss -tm`、`ss -tanp`                      |
| netfilter   | 规则 DROP 计数、conntrack 满  | `iptables -L -v -n`、`conntrack -S`       |

一个实用顺序：先确认丢在哪一层，再决定是调参数、改架构还是改应用。`ethtool -S` 有计数而其他层没有 → 硬件/驱动层；`ListenDrops` 涨 → 应用 accept 太慢或队列太小；`Recv-Q` 持续不降 → 应用读不过来。

## 六、多队列与 CPU 亲和

```text
RSS（硬件多队列）→ 网卡按哈希把包分到多个 RX 队列，各自中断到不同 CPU
RPS（软件）      → 单队列网卡也能在软中断层把处理分散到多核
XPS              → 发包时按 CPU 选择 TX 队列
```

高 PPS 服务若发现 `si` 集中在单核、其他核空闲，先看队列数与中断分布：

```bash
cat /proc/interrupts | grep eth0
ethtool -l eth0                  # 支持的队列数
ethtool -L eth0 combined 8       # 调整队列数
cat /proc/net/softnet_stat        # 每 CPU 的 processed / dropped / time_squeeze
```

注意 `irqbalance` 可能把中断迁来迁去，低延迟场景会绑定中断与业务线程到不同核，避免互相抢 cache 和 CPU。

## 七、socket 缓冲与背压

```text
接收缓冲满 → 通告窗口缩小 → 对端减速 → 极端情况丢包
发送缓冲满 → write 阻塞或 EAGAIN → 应用侧背压
```

相关参数与观察：

```bash
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem   # 自动调优的 min/default/max
ss -tm                                       # 单连接的 skmem、rtt、cwnd
ss -tanp state established | head             # Recv-Q / Send-Q
```

`SO_RCVBUF`/`SO_SNDBUF` 可显式设置，但通常交给内核自动调优更好；长肥网络（高带宽高延迟）才需要按 BDP 调整窗口上限。应用侧更重要的是**别把「写成功」当成「对端已处理」**——`write` 成功只表示数据进了本机发送缓冲。

## 八、与前面几篇的分工

| 问题                                | 该看哪篇                           |
| ----------------------------------- | ---------------------------------- |
| 连接建不上、TIME_WAIT 多、握手队列  | 「TCP 状态机、内核参数与线上排障」 |
| epoll 事件循环、LT/ET、背压实现     | 「服务端网络编程与事件循环」       |
| 帧格式、心跳、重连                  | 「长连接、协议帧与连接治理」       |
| 包在内核里怎么走、iptables 为什么丢 | 本篇                               |
| CPU/内存/磁盘的通用排查命令         | 「线上性能排查工具箱」             |

## 九、实践清单

- 排查丢包按层定位：网卡 ring → 软中断 → 协议栈 → 监听队列 → socket → netfilter，逐层拿计数。
- `tcpdump` 结论要和 iptables 计数、conntrack、socket 状态交叉验证，抓到包不等于应用收到。
- 大流量网关监控 `nf_conntrack_count` 与 `dropped`，优先用连接池/长连接降低条目数，不盲目调大表。
- 规则多的节点用 nftables 集合替代线性 iptables 链；关注规则命中计数。
- 高 PPS 服务检查 RSS/RPS 队列与 `softnet_stat`，避免软中断集中在单核。
- 容器/K8s 场景进对应 netns 抓包，并确认 `bridge-nf-call-iptables` 与 NetworkPolicy 的实际影响。
- 用 `fq_codel` 等队列规则控制 bufferbloat，把「排队延迟」纳入 P99 归因。

## 十、面试速答

**Q：一个数据包从网卡到应用要经过哪些环节？**
DMA 写入 ring buffer → 硬中断触发 NAPI 软中断轮询 → `sk_buff` 经链路层、IP 层与 netfilter hook → TCP 层处理并放入 socket 接收缓冲 → 应用 `recv` 拷贝到用户态。

**Q：抓包看到请求了，应用却没收到，可能是什么原因？**
`tcpdump` 在 netfilter 之前就能拿到副本，包可能随后被 iptables 丢弃、conntrack 表满、路由到错误 netns、监听队列溢出，或 socket 接收缓冲已满。要结合规则计数、`conntrack -S`、`nstat`、`ss` 逐层排查。

**Q：`nf_conntrack: table full` 是什么，怎么处理？**
连接跟踪表耗尽，新连接被丢弃，常见于大流量 NAT 网关与短连接风暴。短期可调 `nf_conntrack_max`（注意内存）并优化超时；根治要减少短连接、复用连接，或对无需跟踪的流量用 `raw` 表 `NOTRACK`。

**Q：NAPI 为什么存在？**
每包一次硬中断在高 PPS 下会把 CPU 打满；NAPI 在中断触发后关闭中断、以预算为上限轮询批量收包，兼顾低负载时的低延迟与高负载时的吞吐。

## 十一、一句话收尾

应用看到的是「一次 `read`」，内核为此走了 DMA、软中断、协议栈、netfilter、队列和 socket 缓冲六层；**每一层都可能丢包或排队，而大部分延迟问题都藏在你看不见的那几层里**。
