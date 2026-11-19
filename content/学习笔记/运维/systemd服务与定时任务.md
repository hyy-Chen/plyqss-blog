---
title: "systemd 服务与定时任务：把进程交给系统托管"
date: 2026-11-19
tags:
  - "运维"
  - "systemd"
  - "定时任务"
  - "学习笔记"
---

> `nohup ./app &` 能让进程活着，但不会在崩溃后拉起、不会开机自启、日志散落、也没有优雅停止。systemd 把这些都变成声明式配置，同时把「服务该在什么环境下运行」固定下来。这篇从 unit 文件三个段落讲到定时任务与常见故障。

## 一、为什么不用 `nohup &`

| 能力         | `nohup &`        | systemd                                |
| ------------ | ---------------- | -------------------------------------- |
| 崩溃自动重启 | 无               | `Restart` 策略                         |
| 开机自启     | 无               | `enable`                               |
| 日志         | 自己重定向，易丢 | journald 统一收集与轮转                |
| 优雅停止     | 靠人 `kill`      | SIGTERM + 超时 + 兜底 SIGKILL          |
| 资源限制     | 无               | `LimitNOFILE`、`MemoryMax`、`CPUQuota` |
| 依赖顺序     | 无               | `After` / `Requires`                   |
| 状态可查     | `ps` 猜          | `systemctl status/show`                |

生产服务应当只有一个入口：`systemctl`。否则值班同学会按自己的习惯各起一份，最后出现「端口被占」和「两个版本的进程同时跑」。

## 二、unit 文件的三段

一个 Go 服务的完整示例，放在 `/etc/systemd/system/order-api.service`：

```ini
[Unit]
Description=Order API service
Documentation=https://internal.example.com/runbook/order-api
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/data/order-api
EnvironmentFile=-/etc/order-api/env
ExecStartPre=/usr/bin/install -d -m 0750 /run/order-api
ExecStart=/data/order-api/bin/order-api --config /etc/order-api/app.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillMode=mixed
LimitNOFILE=65535
MemoryMax=2G
CPUQuota=150%
StandardOutput=journal
StandardError=journal
SyslogIdentifier=order-api
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/data/order-api /run/order-api

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile` 前的 `-` 表示文件不存在也不算错误；`$MAINPID` 由 systemd 注入。`ProtectSystem=strict` 会把整个文件系统设为只读，再用 `ReadWritePaths` 显式开放必要目录——这是收敛权限很好用的一招，但要确认程序所有写入路径都列全了。

## 三、关键字段速查

| 字段                     | 作用                          | 常见误配                                   |
| ------------------------ | ----------------------------- | ------------------------------------------ |
| `Type=simple`            | 启动即视为就绪                | 程序需要初始化却立刻被标记 active          |
| `Type=notify`            | 程序通过 `sd_notify` 报告就绪 | 需程序支持，否则一直启动中                 |
| `Restart=on-failure`     | 非 0 退出才重启               | `always` 会让配置错误时无限重启            |
| `RestartSec`             | 重启间隔                      | 太短会造成重启风暴                         |
| `StartLimitBurst`        | 时间窗内最大启动次数          | 不设则崩溃循环打满日志                     |
| `TimeoutStopSec`         | 等待优雅退出的时间            | 小于应用关闭耗时 → 请求被硬断              |
| `KillMode`               | 杀进程范围                    | `mixed` 先 SIGTERM 主进程，再清理残留      |
| `WorkingDirectory`       | 工作目录                      | 不设时相对路径全从 `/` 开始                |
| `Environment(File)`      | 注入环境变量                  | 交互式 shell 里的变量不会自动带过来        |
| `LimitNOFILE`            | fd 上限                       | 高并发服务不设容易 `too many open files`   |
| `MemoryMax` / `CPUQuota` | cgroup 资源上限               | 超内存直接 OOMKill，需与 `GOMEMLIMIT` 配合 |

## 四、日常操作

```bash
systemctl daemon-reload                    # 改完 unit 文件必做
systemctl enable --now order-api           # 设开机自启并立即启动
systemctl status order-api -l              # 状态与最近日志
systemctl show order-api -p MainPID,MemoryCurrent,NRestarts
systemctl cat order-api                    # 查看最终生效的配置（含 drop-in）
journalctl -u order-api -f                 # 跟随日志
journalctl -u order-api --since '1 hour ago' -p err
systemctl restart order-api && systemctl is-active --quiet order-api
```

**drop-in 覆盖**比直接改主 unit 文件更好维护：

```bash
systemctl edit order-api      # 生成 /etc/systemd/system/order-api.service.d/override.conf
```

这样包升级不会覆盖你的定制，且 `systemctl cat` 能看到叠加后的完整结果。

## 五、优雅停止链路

```text
systemctl stop
  → 摘流（前置脚本让 readiness 失败 / 从 LB 移除）
  → systemd 向主进程发 SIGTERM
  → 应用停止接受新请求，等待在途请求完成（需程序自己实现）
  → 进程退出；或超过 TimeoutStopSec 后 SIGKILL 兜底
```

三个必须对齐的点：**应用的 `Shutdown` 超时 < `TimeoutStopSec` < 上层（K8s / LB）的摘流等待时间**。顺序反了就会出现「已经不接流量了但进程还没停」或「进程已停但 LB 还在转发」的 502。

`ExecStop` 可放自定义的优雅下线脚本，但如果应用自己正确处理 SIGTERM，通常不需要。

## 六、定时任务：timer 还是 cron

| 维度       | cron                 | systemd timer                            |
| ---------- | -------------------- | ---------------------------------------- |
| 日志       | 输出常丢或发邮件     | journald 统一收集                        |
| 错过执行   | 依赖实现，常直接跳过 | `Persistent=true` 开机后补跑             |
| 依赖与并发 | 自己处理             | 可与 service/锁结合                      |
| 随机延迟   | 自己写 sleep         | `RandomizedDelaySec` 原生支持            |
| 资源限制   | 无                   | 复用 service 的 cgroup 限制              |
| 可观测     | 弱                   | `systemctl list-timers`、`journalctl -u` |

timer 需要两个文件（以每日备份为例）：

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Daily backup

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
RandomizedDelaySec=15m
AccuracySec=1m
Unit=backup.service

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Run backup script

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/backup.sh
TimeoutStartSec=3600
```

```bash
systemctl daemon-reload
systemctl enable --now backup.timer
systemctl list-timers --all              # 下次触发时间
systemctl start backup.service           # 手动立即跑一次
```

`RandomizedDelaySec` 在多台机器执行同一任务时很关键：避免 02:00 整所有节点同时打 DB 或对象存储。

cron 仍适合极简单任务，但要记住它 **PATH 极窄、无环境变量、工作目录不固定**，脚本里必须写绝对路径并固定环境（见「Shell 脚本工程化」）。

## 七、常见故障排查

| 现象                              | 常见原因                                                          |
| --------------------------------- | ----------------------------------------------------------------- |
| 手动跑正常，systemd 起不来        | `PATH`、工作目录、环境变量、`User` 权限不同                       |
| `status` 显示 active 但服务不可用 | `Type=simple` 把「进程起来了」当成「就绪了」，需探针或 `notify`   |
| 一直重启                          | `Restart=always` + 配置错误；看 `journalctl` 与 `StartLimitBurst` |
| 改了 unit 不生效                  | 忘了 `daemon-reload`；或有 drop-in 覆盖                           |
| 停服务时请求 502                  | `TimeoutStopSec` 太短或未先摘流                                   |
| 日志看不到                        | 应用把日志写到了被 `ProtectSystem` 设为只读的路径                 |
| fd 耗尽                           | `LimitNOFILE` 未调；也检查应用是否泄漏句柄                        |
| 定时任务没执行                    | timer 未 enable、`Persistent` 语义误解、时区非预期                |

排查顺序：`systemctl status -l` → `journalctl -u ... --since` → `systemctl cat/show` → `systemctl show -p ...` 看资源与重启次数 → 最后才改配置。

## 八、与容器的关系

K8s 里的 `livenessProbe`/`readinessProbe`、`terminationGracePeriodSeconds`、`resources.limits` 本质上在做 systemd 做的同类事情：就绪判定、优雅退出、资源上限。区别在于职责层级：容器编排管 Pod 生命周期，systemd 管单机进程。两者混用时（例如在容器里再跑 systemd）容易出现信号转发与 PID 1 问题，一般应避免。

## 九、实践清单

- 服务一律 unit 托管，禁止长期 `nohup &`；改配置后用 `systemctl cat` 确认最终生效内容。
- `Restart=on-failure` + `RestartSec` + `StartLimitBurst`，避免重启风暴。
- 显式设置 `User`、`WorkingDirectory`、`EnvironmentFile`、`LimitNOFILE`。
- 应用实现 SIGTERM 优雅退出，并保证 `Shutdown` 超时 < `TimeoutStopSec` < 摘流等待。
- 定时任务优先 timer，配 `Persistent` 与 `RandomizedDelaySec`，日志进 journald。
- 用 `ProtectSystem=strict` + `ReadWritePaths` 收敛写权限，并确认所有写入路径已列出。
- 变更 unit 后 `daemon-reload` → `restart` → `is-active --quiet` → `journalctl` 复核。

## 十、面试速答

**Q：`Restart=always` 和 `Restart=on-failure` 怎么选？**
长驻服务通常用 `on-failure`：正常退出（如运维主动 stop 或程序按设计退出 0）不该被拉起；`always` 会让配置错误导致无限重启，必须配合 `StartLimitBurst` 和足够长的 `RestartSec`。

**Q：服务在终端能跑，systemd 起不来，怎么查？**
先看 `journalctl -u`，再核对 `WorkingDirectory`、PATH、环境变量、运行用户的文件权限与 `ProtectSystem` 只读限制。systemd 不加载交互式 shell 的 profile，这是最常见差异。

**Q：timer 的 `Persistent=true` 做什么？**
若定时触发时刻机器处于关机/休眠，开机后会补跑一次错过的任务。适合备份、对账这类不能漏的任务；通知类任务通常不该开启，避免开机后集中补发。

## 十一、一句话收尾

systemd 的价值不在于「帮我启动进程」，而在于把**启动、就绪、失败、停止、日志、资源上限**这些边界统一成一份可评审、可版本化的声明；边界写清楚了，半夜的排障才有据可查。
