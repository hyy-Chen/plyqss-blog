---
title: "容器底层：namespace、cgroup 与镜像分层"
date: 2026-11-13
tags:
  - "Linux"
  - "容器"
  - "云原生"
  - "后端"
  - "学习笔记"
---

> 容器不是轻量级虚拟机：它没有自己的内核，所有容器共享宿主机内核，只是被「隔离了视图、限制了用量、换了根目录、收窄了权限」。理解这四件事，就能解释很多看似诡异的现象：为什么容器里看到的 CPU 是宿主机的、为什么 4G 内存限制会被一段文件缓存触发 OOM、为什么 `localhost` 在 Pod 内能互通而跨 Pod 不行。

## 一、四块积木

```text
namespace  → 隔离「看得见什么」（进程号、网络、挂载点…）
cgroup     → 限制「能用多少」（CPU、内存、I/O、进程数）
联合文件系统 → 提供分层镜像与可写层（overlayfs）
权限收窄   → capabilities / seccomp / user namespace / 只读根文件系统
```

Docker/containerd 只是把这些内核能力打包成一个好用的运行时；K8s 的 Pod 则是「共享部分 namespace 的一组容器」。

## 二、namespace：隔离的是视图，不是资源

| namespace | 隔离内容                       | 直观效果                               |
| --------- | ------------------------------ | -------------------------------------- |
| `pid`     | 进程号空间                     | 容器内 PID 从 1 开始，看不到宿主机进程 |
| `net`     | 网卡、IP、路由、端口、iptables | 每个容器独立的协议栈与端口空间         |
| `mnt`     | 挂载点                         | 容器有自己的根文件系统视图             |
| `uts`     | 主机名与域名                   | 可设置独立 hostname                    |
| `ipc`     | System V IPC、POSIX 消息队列   | 容器间不共享共享内存段                 |
| `user`    | UID/GID 映射                   | 容器内 root 可映射为宿主机普通用户     |
| `cgroup`  | cgroup 层级视图                | 避免看到宿主机层级                     |
| `time`    | 系统时钟偏移                   | 较新内核支持                           |

```bash
lsns                                   # 查看当前系统各类 namespace
cat /proc/self/ns/*                     # 某进程所属 namespace 的 inode 号
nsenter -t <pid> -n ip addr             # 进入目标容器的 netns 排查网络
```

注意 **`/proc` 是谎言的常见来源**：容器里如果挂载的是宿主机 `/proc`（或没做 lsof/sysfs 隔离），`free`、`top`、`nproc` 会显示宿主机数据。Go 的 `runtime.NumCPU()`、`GOMAXPROCS` 曾因此按宿主机核数设置，导致 CPU 配额被瞬间打满（新版本已能读 cgroup 配额，但仍建议显式设置）。

## 三、cgroup v2：单一层级与配额文件

v1 每个子系统一棵独立的树，同一个进程在不同树里归属可以不同，配置复杂；v2 统一成一棵层级，通过 `cgroup.controllers` 启用控制器：

```bash
cat /sys/fs/cgroup/cgroup.controllers    # 可用控制器
cat /sys/fs/cgroup/cpu.max               # "50000 100000" = 0.5 核配额
cat /sys/fs/cgroup/memory.max            # 内存上限
cat /sys/fs/cgroup/memory.current        # 当前用量
cat /sys/fs/cgroup/memory.events         # oom / oom_kill 计数
cat /sys/fs/cgroup/io.max                # 块设备带宽/IOPS 限制
cat /sys/fs/cgroup/pids.max              # 进程/线程数上限
```

K8s 资源的映射关系：

| K8s 字段          | cgroup 效果             | 超限后果                         |
| ----------------- | ----------------------- | -------------------------------- |
| `requests.cpu`    | `cpu.weight` + 调度预留 | 不限制使用                       |
| `limits.cpu`      | `cpu.max` 配额          | **throttling**，P99 周期性尖刺   |
| `requests.memory` | 调度预留                | 不限制使用                       |
| `limits.memory`   | `memory.max`            | cgroup OOMKill（宿主机可能很闲） |

两个高频事故：

1. **CPU limit 造成延迟抖动**：`cpu.stat` 里 `nr_throttled` 增长，即使 CPU 使用率曲线不高。对延迟敏感服务要谨慎设 limit，或配合 `GOMAXPROCS` 一起调。
2. **内存 limit 被非堆内存吃满**：page cache、socket buffer、线程栈、cgo 分配都计入 `memory.current`，Go 的 `GOMEMLIMIT` 只管堆。参见「内存管理与虚拟内存」里的拆分方法。

## 四、镜像分层：overlayfs 与写时复制

```text
lowerdir  = 多个只读镜像层（基础镜像 + 每一条 Dockerfile 指令）
upperdir  = 容器专属可写层
merged    = 容器看到的统一视图
```

- 读文件：从上层往下找，命中即返回。
- 改文件：若文件只在 lowerdir，先**复制整个文件**到 upperdir 再修改（copy-up）。改一个 2GB 的大文件代价很高。
- 删文件：在 upperdir 创建 whiteout 标记，屏蔽下层同名文件，所以删除并不会让镜像变小。
- 数据卷（volume / bind mount）绕过 overlayfs，直接挂宿主机目录，I/O 性能与持久性都不同。

镜像层数多、每层都留大文件、在容器层写日志，都会放大磁盘与 copy-up 开销。多阶段构建、合并 `RUN` 指令、把日志 stdout 化交给日志驱动，都是由此而来。

## 五、容器网络：veth + bridge + NAT

```text
容器 netns: eth0 (veth 一端)
      ↕ veth pair
宿主机: vethxxx → bridge (docker0 / cni0) → iptables NAT → 物理网卡
```

- 同 Pod 内的容器共享同一个 `netns`，因此可以用 `localhost` 互通、端口不能冲突。
- 跨 Pod 通信走 CNI 插件：有的用 bridge + 路由，有的用 Overlay（VXLAN），有的直接 BGP 路由。
- 容器访问外网通常经 `MASQUERADE` 做源地址转换；外部访问容器靠 `DNAT` 端口映射或 Service（kube-proxy 的 iptables/IPVS 规则）。
- `conntrack` 记录每条 NAT 连接，连接数过高会表满丢包（见「内核网络栈与 netfilter」）。

排查时 `nsenter -t <pid> -n` 进入容器网络命名空间，用容器内视角看路由、iptables 与 socket 状态，比在宿主机猜要快得多。

## 六、PID 1、信号与僵尸回收

容器 PID namespace 里的 1 号进程有两个额外责任：**转发信号**与 **`wait` 回收孤儿进程**。普通应用通常两者都不做：

```text
kubectl delete pod → 发 SIGTERM 给 PID 1 → 应用不处理 / 不转发
   → 等到 terminationGracePeriodSeconds → SIGKILL
   → 期间在途请求被硬断，且容器内僵尸进程堆积
```

解法：

| 方案                         | 说明                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `docker run --init` / `tini` | 由 init 进程承担 reap 与信号转发                                |
| 应用自己处理                 | `signal.NotifyContext` + `Shutdown`（带超时）+ `wait4(-1, ...)` |
| K8s `shareProcessNamespace`  | 让 Pod 内共享进程空间，配合专门的 init 容器                     |

优雅退出还要和 readiness 配合：先让探针失败摘流 → 等待一小段让 Service/Ingress 规则生效 → 再停止接受新请求并等待在途请求完成 → 退出。顺序反了就会有「已停止服务却仍被转发流量」的 502。

## 七、权限收窄：root 不是真的 root

容器默认以 root 运行，但这个 root 在宿主机上仍可能拥有过大权限（尤其在没启用 user namespace 时）。Capabilities 把 root 特权拆成细粒度单元：

| 能力               | 风险                                  |
| ------------------ | ------------------------------------- |
| `CAP_SYS_ADMIN`    | 几乎等价于宿主机 root，可挂载、改网络 |
| `CAP_NET_ADMIN`    | 改路由、iptables                      |
| `CAP_SYS_PTRACE`   | 读取其他进程内存                      |
| `CAP_DAC_OVERRIDE` | 绕过文件权限检查                      |

实践清单：

- 用非 root 用户运行，镜像里显式 `USER`，K8s 设 `runAsNonRoot` + `allowPrivilegeEscalation: false`。
- drop 掉所有 capability，只按需加回；默认配置通常给了过多能力。
- 启用 seccomp（限制系统调用面），必要时用 AppArmor/SELinux。
- 根文件系统只读，只给明确需要写的目录挂空卷。
- 绝不 `--privileged`，绝不把 `/var/run/docker.sock` 挂进容器（等价于把宿主机 root 交出去）。
- 敏感环境变量与 Secret 注入要有审计，别打进镜像层（镜像层是只读但可被任何拿到镜像的人读）。

## 八、实践清单

- 容器内显式设置 `GOMAXPROCS`、`GOMEMLIMIT`，别依赖宿主机可见资源。
- 监控 `cpu.stat` 的 throttling 与 `memory.events` 的 oom_kill，而不是只看使用率曲线。
- 镜像多阶段构建、减少层数，大文件与运行时写入放到 volume 或 stdout 日志。
- 应用实现 SIGTERM 优雅退出、僵尸回收，并配合 readiness 摘流。
- 用 `lsns` / `nsenter` / `/sys/fs/cgroup` 在宿主机侧核对隔离与配额，而不是只看容器内的 `/proc`。
- 按最小权限配置 capabilities、seccomp、只读根文件系统，定期审计特权容器。
- 压测包含「CPU 配额打满」「memory limit 触发」「Pod 滚动退出」三类场景。

## 九、面试速答

**Q：容器和虚拟机的本质区别？**
容器共享宿主机内核，靠 namespace 隔离视图、cgroup 限制资源、联合文件系统提供分层根文件系统；虚拟机有独立内核与硬件虚拟化层。因此容器启动快、密度高，但隔离边界更弱，内核版本与安全配置与宿主机强绑定。

**Q：容器里看到 64 核但只给了 1 核配额，会发生什么？**
`nproc`/`NumCPU` 常读到宿主机核数，运行时可能起过多线程争抢 1 核配额，触发 cgroup throttling，表现为 CPU 使用率不高但 P99 抖动。应显式设置 `GOMAXPROCS` 并复核 `cpu.stat`。

**Q：为什么容器里会堆僵尸进程？**
PID 1 没有 `wait` 回收子进程。用 init 进程（tini/dumb-init）或让应用自己 reap，同时正确处理 SIGTERM 与优雅退出。

**Q：K8s 的 request 和 limit 在内核里对应什么？**
request 主要用于调度预留，CPU 上映射为权重 `cpu.weight`；limit 映射为硬上限，CPU 是 `cpu.max` 配额、内存是 `memory.max`。超限分别导致 throttling 与 cgroup OOMKill。

## 十、一句话收尾

容器是内核能力的**编排**，不是一种新的隔离硬件；一旦出问题，答案基本都在 namespace 的视图、cgroup 的配额、overlayfs 的写时复制或 PID 1 的信号处理里。
