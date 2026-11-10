---
title: "Prometheus、Grafana 与 Go 可观测性实践"
date: 2026-10-15
tags:
  - "可观测性"
  - "监控"
  - "学习笔记"
---

> 目标：当接口 P99 升高时，先用指标判断影响面与瓶颈方向，再用日志和 Trace 定位具体请求与下游依赖。

## 一、三大可观测性信号

| 信号            | 回答的问题                     | 常用工具                                 |
| --------------- | ------------------------------ | ---------------------------------------- |
| Metrics（指标） | 是否异常、影响多大、趋势如何？ | Prometheus、Grafana、Alertmanager        |
| Logs（日志）    | 某次错误的上下文是什么？       | Loki、ELK、云日志                        |
| Traces（链路）  | 一次请求慢在哪个服务/SQL/RPC？ | OpenTelemetry、Jaeger、Tempo、SkyWalking |

它们需要关联：日志与 Trace 带 `trace_id`，指标按有限维度聚合。不要把用户 ID、订单号、请求 ID 放到 Prometheus label 中，否则会产生高基数时间序列并拖垮 Prometheus。

## 二、P50、P95、P99 是什么

P99 是 99 分位延迟：99% 请求不超过该值，最慢的 1% 更慢。平均值会掩盖长尾，例如 99 个请求 10ms、1 个请求 10s，平均约 110ms，但用户体验有一个请求极差。

| 指标                | 适合观察                 |
| ------------------- | ------------------------ |
| P50                 | 典型请求体验             |
| P95                 | 大多数慢请求趋势         |
| P99                 | 长尾、排队、GC、下游抖动 |
| 错误率              | 可用性与失败放大         |
| QPS / 并发 / 饱和度 | 容量与过载               |

Prometheus 的 histogram 是按桶统计的近似分位数，桶边界应围绕 SLO 设计，例如接口目标 200ms，可设置 `0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2` 秒。

## 三、Prometheus 与 Grafana 的分工

```text
Go 服务 /metrics ──拉取──> Prometheus ──PromQL──> Grafana 面板
       │                         │
       └── Trace / Log ──────────┴── 告警规则 → Alertmanager → 通知
```

- Prometheus 定期 pull 服务的 `/metrics`，存储时序数据并执行 PromQL。
- Grafana 连接 Prometheus 数据源，绘制面板、变量和告警。
- Alertmanager 负责告警分组、静默、去重和投递；Grafana 主要负责展示。

## 四、Go 暴露业务指标 demo

安装依赖：

```bash
go get github.com/prometheus/client_golang/prometheus
go get github.com/prometheus/client_golang/prometheus/promhttp
```

`main.go`：

```go
package main

import (
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	requests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "http_server_requests_total",
		Help: "HTTP requests completed.",
	}, []string{"method", "route", "status"})

	duration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_server_request_duration_seconds",
		Help:    "HTTP request duration in seconds.",
		Buckets: []float64{0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2},
	}, []string{"method", "route"})

	inflight = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "http_server_in_flight_requests",
		Help: "Requests currently being served.",
	})
)

func init() { prometheus.MustRegister(requests, duration, inflight) }

func hello(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	inflight.Inc()
	defer inflight.Dec()
	defer duration.WithLabelValues(r.Method, "/hello").Observe(time.Since(start).Seconds())

	// 模拟业务耗时；真实项目中在中间件统一记录。
	time.Sleep(30 * time.Millisecond)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
	requests.WithLabelValues(r.Method, "/hello", strconv.Itoa(http.StatusOK)).Inc()
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/hello", hello)
	mux.Handle("/metrics", promhttp.Handler())
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

运行 `go run .` 后访问 `http://localhost:8080/hello` 数次，再访问 `http://localhost:8080/metrics`，可见：

```text
http_server_requests_total{method="GET",route="/hello",status="200"} 3
http_server_request_duration_seconds_bucket{method="GET",route="/hello",le="0.05"} 3
```

### 指标设计原则

1. Counter 只增不减：请求数、错误数、消息消费数。
2. Gauge 可上下波动：并发请求、队列长度、连接数。
3. Histogram 记录延迟/大小分布并计算分位数；Summary 的分位数不能跨实例聚合，服务端指标通常优先 Histogram。
4. Label 只使用低基数维度，如 method、规范化 route、status class、依赖名称；禁止原始 URL、user_id、trace_id。

## 五、Prometheus 抓取配置

`prometheus.yml`：

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: go-demo
    metrics_path: /metrics
    static_configs:
      - targets: ["host.docker.internal:8080"]
```

本机非 Docker 部署可写 `localhost:8080`；Kubernetes 中通常通过 ServiceMonitor/PodMonitor 或服务发现配置目标。Prometheus 的 Targets 页面应显示 job 为 `UP`，否则先检查网络、路径、认证与服务监听地址。

## 六、Grafana 面板与 PromQL

配置 Grafana 的 Prometheus 数据源后，创建以下面板。

### 1. QPS

```promql
sum(rate(http_server_requests_total[5m])) by (route)
```

**效果：** 展示每条路由最近五分钟每秒完成请求数。`rate` 用于 Counter，不能直接对 Counter 原值当 QPS。

### 2. 5xx 错误率

```promql
sum(rate(http_server_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_server_requests_total[5m]))
```

**效果：** 得到 0 到 1 的错误比例；Grafana 可格式化为百分比。生产中还应避免低流量时的噪声告警。

### 3. HTTP P99 延迟

```promql
histogram_quantile(
  0.99,
  sum(rate(http_server_request_duration_seconds_bucket[5m])) by (le, route)
)
```

**效果：** 按路由显示最近五分钟 P99 秒数。必须保留 `le` 维度；多实例场景先按 bucket 聚合、再计算分位数，不能分别求各实例 P99 后取平均。

### 4. 在途请求与饱和度

```promql
http_server_in_flight_requests
```

**效果：** 若并发请求、P99 和错误率同时升高，通常提示服务排队、CPU/连接池/下游已饱和；需要结合 CPU、GC、数据库连接池和 Trace 判断根因。

## 七、告警示例

```yaml
groups:
  - name: api
    rules:
      - alert: HttpP99TooHigh
        expr: histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket[5m])) by (le, route)) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.route }} P99 exceeds 500ms"
```

`for: 10m` 防止瞬时尖峰报警。实际阈值应来自 SLO：例如“99% 请求在 500ms 内完成”，而非照抄示例。告警应包含服务、路由、仪表盘与 runbook 链接。

## 八、Trace：用 OpenTelemetry 定位 P99 为什么变慢

指标发现“`/hello` P99 高”，Trace 回答“哪一条请求慢在 SQL、Redis、RPC 还是服务内部”。常见链路为：Go SDK 创建 span → OTLP exporter 发往 OpenTelemetry Collector → Jaeger/Tempo 展示瀑布图。

核心初始化示意：

```go
// 需依赖 go.opentelemetry.io/otel 等包；实际项目还应配置 exporter 与 shutdown。
tracer := otel.Tracer("orders")
ctx, span := tracer.Start(r.Context(), "GET /orders/{id}")
defer span.End()

ctx, dbSpan := tracer.Start(ctx, "SELECT order")
// 执行数据库查询；发生错误时 dbSpan.RecordError(err)
dbSpan.End()
```

**预期效果：** 在 Jaeger/Tempo 中按慢 Trace 搜索，可见父 span 是 HTTP 请求，子 span 是 SQL、Redis、HTTP/gRPC 调用及各自耗时。用 `trace_id` 从 Trace 跳到日志，再结合当时 P99 曲线完成闭环。

## 九、后端排障顺序

1. Grafana 看错误率、QPS、P99、饱和度何时同时变化。
2. 根据变化判断入口流量、服务自身资源还是下游依赖；查看 CPU、GC、连接池、队列和 DB/Redis 指标。
3. 从异常时间窗抽慢 Trace，定位最长 span；用 `trace_id` 检索结构化日志。
4. 修复后对比同一面板的 P99、错误率和资源占用，避免只看平均延迟。
