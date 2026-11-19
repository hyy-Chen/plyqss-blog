---
title: "Linux 基础命令与日常运维操作"
date: 2026-11-19
tags:
  - "运维"
  - "Linux"
  - "命令"
  - "学习笔记"
---

> 会敲 `ls` 和能在生产机上安全地敲 `rm -rf` 是两回事。这篇不背命令大全，而是按「先建立安全习惯 → 文件/权限/用户/进程/磁盘/网络 → 危险操作护栏」组织，目标是让日常变更**可预期、可回滚、留得下痕迹**。性能排障相关的指标判读在「线上性能排查工具箱」那篇，这里只讲操作。

## 一、先建立安全习惯

```bash
pwd                       # 任何删除/覆盖前，先确认自己在哪
whoami && id              # 确认身份与所属组
ls -lah                   # 看清目标，包括隐藏文件
```

| 习惯                                         | 原因                            |
| -------------------------------------------- | ------------------------------- |
| 用普通账号 + `sudo`，不长期 root 登录        | 留审计记录，减少误操作半径      |
| 改配置前先 `cp -a file file.bak.$(date +%F)` | 出事能秒回滚                    |
| 批量操作先 dry-run（`echo` 要执行的命令）    | 看清将要影响哪些对象            |
| 危险路径用绝对路径，并先 `ls` 验证           | 相对路径 + 变量为空是经典事故   |
| 变量一律加引号，路径参数用 `--` 收尾         | 防空格文件名与 `-` 开头被当选项 |
| 变更记录时间、命令、结果                     | 复盘时不用靠回忆                |

一个具体到骨子里的例子：

```bash
target="/data/app/logs"
# 错误示范：变量为空时 rm -rf "/$target/" 会变成删根目录
# 正确示范：先校验再用 -- 明确结束选项
[[ -n "$target" && -d "$target" ]] || { echo "invalid target" >&2; exit 1; }
rm -rf -- "${target:?}"/*.log
```

## 二、文件与目录

| 命令    | 常用形式                                     | 说明                                 |
| ------- | -------------------------------------------- | ------------------------------------ |
| `ls`    | `ls -lahtr`                                  | 按时间倒序、含隐藏文件、人类可读大小 |
| `mkdir` | `mkdir -p /data/app/{logs,tmp}`              | 递归创建，幂等                       |
| `cp`    | `cp -a src dst`                              | 保留权限、属主、时间戳与链接         |
| `mv`    | `mv -i` / `mv -n`                            | 交互确认 / 不覆盖已有文件            |
| `ln`    | `ln -s target link`                          | 软链接；硬链接不加 `-s`              |
| `rm`    | `rm -i` / `rm -rf -- path`                   | 生产环境慎用 `-f`                    |
| `find`  | 见下                                         | 按条件批量定位                       |
| `stat`  | `stat file`                                  | 精确查看权限、inode、mtime           |
| `du`    | `du -sh dir` / `du -h --max-depth=1`         | 找大目录                             |
| `tar`   | `tar czf a.tgz dir` / `tar xzf a.tgz -C dst` | 打包与解包                           |
| `rsync` | `rsync -av --delete src/ dst/`               | 镜像同步，`--delete` 极危险          |

```bash
# 找 7 天前的日志并先打印，确认后再删
find /var/log/app -type f -name '*.log' -mtime +7 -print
find /var/log/app -type f -name '*.log' -mtime +7 -print -delete

# 找最近 24 小时内修改过大的配置文件
find /etc -type f -mmin -1440 -size +1M -ls
```

`rsync -av --delete src/ dst/` 的**尾部斜杠**语义不同：`src/` 表示复制目录内容，`src` 表示复制目录本身；加 `--dry-run` 先看清单，是上线前必做的一步。

## 三、权限与属主

```text
rwx r-x r--  → 754
│   │   └── other
│   └── group
└── owner
目录的 x 位 = 可进入；文件的 x 位 = 可执行
```

```bash
chmod 750 /data/app                # 目录常用：属主全权，组可读可进
chmod u+x script.sh                # 只给属主加执行位
chown -R app:app /data/app         # 递归改属主（先确认范围）
umask 027                          # 新建文件默认 640、目录 750
getfacl file && setfacl -m u:ops:r file   # 需要给单个用户开例外时用 ACL
```

特殊位：`SUID`（执行时以文件属主身份运行）、`SGID`（目录下新建文件继承组）、`sticky`（`/tmp` 的 1777，只能删自己的文件）。排查「明明有 r 权限却进不去」时，先查父目录链上是否缺 `x`：

```bash
namei -l /data/app/config.yaml      # 逐级列出路径的权限，非常好用
```

## 四、用户、组与 sudo

```bash
id app                             # uid/gid/所属组
useradd -m -s /bin/bash deploy
usermod -aG docker deploy          # 注意是 -aG，漏 -a 会清掉原有组
passwd -l user                     # 锁定账号而非删除
visudo                             # 唯一推荐的 sudoers 编辑方式（会做语法校验）
```

`sudoers` 里 `NOPASSWD: ALL` 等价于给一个免密 root，应收敛到具体命令白名单。`su - user` 会加载目标用户的登录环境（PATH、HOME、shell 配置），`su user` 不会——脚本里环境变量莫名其妙不对，常常是这个差别。

## 五、进程与服务管理

```bash
ps -eo pid,ppid,user,stat,etime,cmd --sort=start_time | tail -20
pgrep -af 'myapp'                  # 按命令行找进程
kill -TERM <pid>                   # 先礼貌退出
kill -HUP  <pid>                   # 常用于通知重载配置（取决于程序实现）
kill -KILL <pid>                   # 最后手段，不给清理机会
```

| 信号           | 语义                             |
| -------------- | -------------------------------- |
| `SIGTERM` (15) | 请求退出，可被捕获，用于优雅关闭 |
| `SIGINT` (2)   | Ctrl+C                           |
| `SIGHUP` (1)   | 常被程序用于重载配置             |
| `SIGKILL` (9)  | 内核强杀，不可捕获、不可忽略     |

前台任务临时托管：`nohup cmd >/var/log/cmd.log 2>&1 &` 能扛终端断开，但**没有自动重启、日志轮转和开机自启**，生产服务应交给 systemd（见「systemd 服务与定时任务」那篇）。

## 六、磁盘与挂载

```bash
df -hT                             # 各挂载点空间与文件系统类型
df -i                              # inode 使用率（小文件多的必查项）
lsblk -f                           # 块设备、分区与 UUID
findmnt /data                      # 确认挂载来源与选项
mount -o remount,ro /data          # 只读重挂载（维护窗口）
lsof +L1                           # 找出「已删除但仍被进程占用」的文件
```

「删了大日志但 `df` 没变」基本都是进程还持有 fd，用 `lsof +L1` 找到 PID 后让它重开日志（或重启服务），空间才会释放。`fsck` 必须在**卸载后**执行，在线跑可能损坏数据。

## 七、网络与远程

```bash
ip addr show && ip route show       # 替代 ifconfig/route
ss -lntp                           # 谁在监听哪个端口
curl -fsS -m 5 -o /dev/null -w '%{http_code} %{time_total}\n' https://example.com/health
dig +short example.com              # DNS 解析（nslookup 亦可）
ssh -i ~/.ssh/id_ed25519 user@host
scp -r ./dist user@host:/tmp/
rsync -av --dry-run ./dist/ user@host:/data/app/
```

`curl` 健康检查建议同时带 `-f`（4xx/5xx 返回非零）、`-sS`（静默但保留错误）、`-m`（超时），否则脚本会把「返回错误页」当成成功。`ssh` 批量操作时用密钥 + `ssh-agent`，别把口令写进脚本。

## 八、包管理与运行环境

```bash
# Debian/Ubuntu
apt update && apt install -y curl jq
dpkg -l | grep -i nginx
# RHEL/CentOS/Rocky
dnf install -y curl jq
rpm -qa | grep -i nginx
```

环境三件套最容易出错：`PATH`（cron/systemd 与交互式 shell 不同，脚本里用绝对路径或显式设置）、`HOME`（影响配置读取）、`LANG/LC_ALL`（影响排序与正则，统计脚本建议固定 `LC_ALL=C`）。

## 九、日常组合速查

```bash
# 看某目录最大的 10 个文件
du -ah /data | sort -rh | head -10
# 找出占用某端口的进程
ss -lntp | grep ':8080'
# 确认某文件被哪个进程打开
lsof /data/app/config.yaml
# 批量检查多台主机的时间偏差
for h in host1 host2 host3; do printf '%s ' "$h"; ssh "$h" 'date -u +%FT%TZ'; done
# 改配置前留一份带时间戳的备份
cp -a -- /etc/app.conf "/etc/app.conf.bak.$(date +%Y%m%d%H%M%S)"
```

## 十、危险操作护栏

| 操作                | 风险                        | 护栏                                 |
| ------------------- | --------------------------- | ------------------------------------ |
| `rm -rf $VAR/`      | 变量为空或带空格 → 删错目录 | `${VAR:?}` + 非空/存在校验 + 先 `ls` |
| `chmod -R 777`      | 把所有安全边界抹掉          | 按最小权限精确赋权，用 ACL 处理例外  |
| `dd of=/dev/sdX`    | 盘符写错直接毁数据          | `lsblk` 反复确认，优先用镜像工具     |
| `find ... -exec rm` | 匹配范围超出预期            | 先 `-print` 审阅，再执行             |
| `> file`            | 覆盖而非追加                | 明确用 `>>`，重要文件先备份          |
| `rsync --delete`    | 目标端多余文件全被删        | 必带 `--dry-run` 预演                |
| `:(){ :             | :& };:`                     | fork 炸弹打满进程表                  | 用 `ulimit -u` / `pids.max` 限制 |

任何批量脚本都应支持 `--dry-run`：把要执行的命令打印出来却不真的执行。这条规则在下一篇会被反复用到。

## 十一、实践清单

- 生产变更遵循「确认路径 → 备份 → dry-run → 执行 → 验证 → 记录」六步。
- 用普通账号 + `sudo` 白名单；`visudo` 编辑，绝不写 `NOPASSWD: ALL`。
- 路径变量加引号、用 `--` 收尾、危险变量用 `${VAR:?}` 保护。
- 删除前先 `find -print` 审阅；`rsync --delete` 前必做 `--dry-run`。
- 服务交给 systemd 托管，不用 `nohup &` 长期跑。
- 脚本里显式设置 `PATH` 与 `LC_ALL`，避免 cron/systemd 环境差异。
- 定期检查 `df -h`、`df -i`、`lsof +L1` 与证书/密钥到期时间。

## 十二、面试速答

**Q：`cp -a` 比 `cp -r` 多了什么？**
`-a` 归档模式会保留权限、属主、时间戳、符号链接与特殊文件，等价于 `-dR --preserve=all`；做备份和迁移时用它，避免复制后服务因权限变化起不来。

**Q：删了大文件磁盘空间没释放，怎么查？**
文件仍被某个进程持有 fd，目录项删了但数据块未释放。用 `lsof +L1` 找到进程，让它重开文件或重启服务；不要盲目重启整机。

**Q：为什么目录需要 `x` 权限？**
目录的 `x` 是「可进入/可访问其中 inode」，只有 `r` 能列名字但打不开内容。排查「有读权限却访问不了」时用 `namei -l` 逐级看路径上的 `x` 位。

## 十三、一句话收尾

基础命令的难点从来不是记不住参数，而是**默认情况下它不会替你确认「这真的是你想操作的那个对象」**；把校验、备份、dry-run 和留痕变成肌肉记忆，才算能上生产。
