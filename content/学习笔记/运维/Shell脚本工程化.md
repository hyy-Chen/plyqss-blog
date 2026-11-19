---
title: "Shell 脚本工程化：从能跑一次到能半夜自动跑"
date: 2026-11-19
tags:
  - "运维"
  - "Shell"
  - "自动化"
  - "学习笔记"
---

> 一个在终端里跑得好好的脚本，放进 crontab 就可能因为 PATH、工作目录、环境变量或并发重入而悄悄失败。更糟的是「失败却返回 0」，让监控以为一切正常。这篇讲怎么把脚本写成**可预期、可观测、可重入、可回滚**的小程序。

## 一、起手式：三行决定可靠性

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
```

| 选项          | 作用                               | 要注意                                            |
| ------------- | ---------------------------------- | ------------------------------------------------- |
| `-e`          | 命令失败即退出                     | 在 `if`、`&&`、`                                  |     | `、管道中间等上下文会被抑制，别当万能保险 |
| `-E`          | 让 `ERR` trap 继承到函数与子 shell | 配合错误定位                                      |
| `-u`          | 引用未定义变量直接报错             | 可选参数要用 `${1:-}` 显式给默认值                |
| `-o pipefail` | 管道任一环节失败即整体失败         | 否则 `grep` 失败会被 `wc -l` 的成功掩盖           |
| `IFS`         | 限定分词符                         | 避免带空格路径被拆开，但会影响现有 `for` 循环写法 |

`-e` 最容易误解的地方：

```bash
set -e
false && echo ok        # 不会退出，因为 && 左侧属于条件上下文
if grep x file; then :; fi   # 同理不会退出
grep x file | wc -l     # 没有 pipefail 时，grep 失败也不退出
```

所以**关键步骤要显式检查退出码**，而不是全靠 `-e`：

```bash
if ! rsync -av src/ dst/; then
  log ERROR "rsync failed"
  exit 1
fi
```

## 二、变量、引号与参数

```bash
readonly APP_NAME="order-api"
readonly BASE_DIR="/data/${APP_NAME}"
config="${1:-/etc/order-api.conf}"      # 未传参时用默认值
dest="${BASE_DIR}/$(basename "$config")"

echo "$config"                         # 永远加引号
printf '%s\n' "$@"                     # "$@" 保留每个参数；"$*" 会拼成一个字符串
arr=(host1 host2 host3)                # 数组，避免用空格分隔的字符串
```

规则很简单：**所有变量展开都加双引号**，除非你明确需要分词。`eval`、未加引号的 `$VAR` 拼进命令、把外部输入直接当命令执行，是脚本注入的三大来源。

参数解析别手写一堆 `$1 $2 $3`，用 `getopts` 或统一的 `--key=value` 循环：

```bash
dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --config)  config="${2:?--config needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done
```

`--dry-run` 是运维脚本最重要的一项功能：把所有「写」动作前面挂一个判断，先打印将要做什么。

```bash
run() {
  if ((dry_run)); then printf '[dry-run] '; fi
  printf '%q ' "$@"; printf '\n'
  ((dry_run)) || "$@"
}
run systemctl restart order-api
```

## 三、错误处理与清理

```bash
log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$1" "${*:2}" >&2; }

on_err() {
  local exit_code=$?
  log ERROR "failed at line $1 (exit=$exit_code): ${BASH_COMMAND}"
  exit "$exit_code"
}
trap 'on_err $LINENO' ERR

cleanup() {
  [[ -n "${tmp_dir:-}" && -d "$tmp_dir" ]] && rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

tmp_dir="$(mktemp -d)"
chmod 700 "$tmp_dir"
```

要点：

- **日志走 stderr**，stdout 留给真正的数据输出，方便管道与重定向。
- `trap ... EXIT` 保证无论成功失败都清理临时文件；`mktemp -d` 避免固定路径冲突与符号链接攻击。
- 临时文件含敏感内容时先 `umask 077`。
- 自定义退出码并写进文档：`0` 成功、`2` 参数错、`3` 前置校验失败、`4` 执行失败、`5` 人工确认取消。

## 四、幂等、锁与并发

定时任务最怕**上一次没跑完，下一次又启动**。用 `flock` 加一把非阻塞锁：

```bash
lock_file="/var/lock/${APP_NAME}.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  log WARN "another instance is running, skip"
  exit 0
fi
```

幂等的三条写法：

1. **先判断再动作**：`[[ -d "$dst" ]] || mkdir -p "$dst"`、`grep -q` 后再追加配置。
2. **用原子替换**：写临时文件 → 校验 → `mv` 覆盖，避免中途失败留下半截文件。
3. **记录已完成状态**：成功标记写到 state 文件，重跑时跳过已完成批次。

超时与重试：

```bash
timeout 30s curl -fsS https://example.com/health >/dev/null

retry() {
  local max=$1; shift
  local i delay=1
  for ((i=1; i<=max; i++)); do
    "$@" && return 0
    log WARN "attempt $i/$max failed, sleep ${delay}s"
    sleep "$delay"
    delay=$((delay * 2 > 30 ? 30 : delay * 2))   # 指数退避加上限
  done
  return 1
}
retry 4 systemctl is-active --quiet order-api
```

退避要加上限和总时长控制，否则一次故障会让脚本在后台挂几个小时。

## 五、环境差异：cron / systemd 是另一个世界

| 差异          | 交互式 shell           | cron / systemd               |
| ------------- | ---------------------- | ---------------------------- |
| `PATH`        | 完整，含各类工具目录   | 很窄，常只有 `/usr/bin:/bin` |
| 工作目录      | 你在的目录             | 常为 `/` 或 HOME             |
| 环境变量      | 来自 `.bashrc`/profile | 基本没有，需显式注入         |
| stdout/stderr | 终端                   | cron 可能发邮件或直接丢弃    |
| 语言环境      | 通常 UTF-8             | 可能是 `C`，影响排序与中文   |

对应做法：

```bash
#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export LC_ALL=C
cd /data/app || exit 3
set -Eeuo pipefail
```

需要密钥时从 `EnvironmentFile`（systemd）或权限 600 的配置文件读取，**不要写进脚本、不要打印到日志、不要放命令行参数**（`ps` 能看到）。

## 六、上线前的静态检查

```bash
bash -n script.sh          # 语法检查，不执行
bash -x script.sh          # 逐行回显执行过程（含变量展开）
shellcheck script.sh       # 静态分析：引号、未定义变量、可移植性
```

`shellcheck` 几乎总能抓出几处你自觉没问题的引号与数组写法，建议进 CI 门禁。发布流程：

```text
bash -n → shellcheck → --dry-run 全量预演 → 小范围灰度执行
   → 检查退出码与日志 → 接入 cron/systemd → 观察至少两个周期
```

## 七、一个可以直接改的完整骨架

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export LC_ALL=C

readonly APP="order-api"
readonly STATE_DIR="/var/lib/${APP}"
readonly LOCK_FILE="/var/lock/${APP}.lock"
dry_run=0
config="/etc/${APP}.conf"
tmp_dir=""

log()  { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$1" "${*:2}" >&2; }
usage(){ printf 'usage: %s [--dry-run] [--config FILE]\n' "${0##*/}"; }
run()  { if ((dry_run)); then printf '[dry-run] '; fi; printf '%q ' "$@"; printf '\n'; ((dry_run)) || "$@"; }
on_err(){ local c=$?; log ERROR "line $1 exit=$c cmd=${BASH_COMMAND}"; exit "$c"; }
cleanup(){ [[ -n "$tmp_dir" && -d "$tmp_dir" ]] && rm -rf -- "$tmp_dir" || true; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --config)  config="${2:?--config needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) log ERROR "unknown arg: $1"; usage >&2; exit 2 ;;
  esac
done

[[ -r "$config" ]] || { log ERROR "config not readable: $config"; exit 3; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then log WARN "already running, skip"; exit 0; fi

tmp_dir="$(mktemp -d)"
chmod 700 "$tmp_dir"

if ((dry_run)); then
  log INFO "dry-run: no side effects will be applied"
fi

run install -d -m 0750 "$STATE_DIR"
run rsync -a --delete "${STATE_DIR}/staging/" "${STATE_DIR}/current/"
run timeout 30s curl -fsS "http://127.0.0.1:8080/health" -o /dev/null

if ((dry_run)); then
  log INFO "dry-run finished"
else
  log INFO "deploy finished, config=$config"
fi
```

这个骨架里集中了前六节的所有要素：严格模式、固定环境、参数与 dry-run、日志与错误定位、临时目录清理、非阻塞锁、幂等目录创建、超时与原子替换。业务脚本只需要替换最后几行动作。

## 八、实践清单

- 每个脚本以 `set -Eeuo pipefail` + 固定 `PATH`/`LC_ALL`/工作目录开头。
- 变量一律加引号；外部输入不拼进命令；禁止 `eval`。
- 所有「写」动作走统一的 `run` 包装，默认支持 `--dry-run`。
- 定时任务用 `flock -n` 防重入；网络与外部命令加 `timeout`；重试带指数退避与总上限。
- 临时目录用 `mktemp -d` + `trap EXIT` 清理，敏感文件 `umask 077`。
- 日志输出到 stderr 并带 UTC 时间戳与级别；密钥、令牌绝不落日志或命令行。
- 定义并文档化退出码；关键步骤显式判断返回值，不迷信 `set -e`。
- 上线前 `bash -n` + `shellcheck` + dry-run 预演，接入调度后观察至少两个周期。

## 九、面试速答

**Q：`set -euo pipefail` 分别解决什么，有什么陷阱？**
`-u` 防未定义变量、`-e` 遇失败退出、`pipefail` 让管道任一环节失败即整体失败。陷阱是 `-e` 在 `if`/`&&`/`||` 等条件上下文会被抑制，且 `pipefail` 会让「故意允许 grep 无匹配」的管道报错，需要显式处理。

**Q：定时脚本怎么避免重复执行？**
用 `flock -n` 对锁文件加非阻塞锁，抢不到就直接退出；同时把动作写成幂等（先判断状态、临时文件 + 原子 `mv`、记录完成标记），这样即使被中断后重跑也安全。

**Q：脚本在终端正常，放进 crontab 就失败，常见原因？**
PATH 变窄导致命令找不到、工作目录不同导致相对路径失效、环境变量与 locale 缺失、stdout/stderr 被丢弃看不到报错。做法是固定 PATH、绝对路径、显式 `cd`、日志落文件并带时间戳。

## 十、一句话收尾

脚本工程化的目标不是写得更花哨，而是让它在**没人看着的时候**也能给出确定的结果：失败会响、重跑不会坏事、事后能查清做了什么。
