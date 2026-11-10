---
title: "Protocol Buffers、gRPC 与服务发现"
date: 2026-10-15
tags:
  - "微服务"
  - "gRPC"
  - "学习笔记"
---

> 本文以 Go 后端为背景。Protobuf 定义接口契约，gRPC 负责 RPC 通信，注册中心解决“服务实例地址会变化”的发现问题；它们共同构成常见微服务调用链。

## 一、一次 RPC 调用如何发生

```text
服务实例启动
  → 注册中心登记 service=order、address=10.0.0.8:9000、健康状态
  → 消费方订阅 order 的实例列表并维护本地缓存
  → 客户端负载均衡选择一个健康实例
  → gRPC/HTTP2 + Protobuf 发起带 deadline 的 RPC
  → 服务端处理并返回状态码；指标、日志、Trace 记录整条调用
```

注册中心不在每次请求的同步路径中：消费者一般订阅后缓存实例列表。否则注册中心短暂故障会直接放大成全链路故障。

## 二、Protocol Buffers 基础

Protobuf 是接口定义语言（IDL）与二进制序列化格式。`.proto` 是跨语言契约；`protoc` 根据契约生成 Go、Java 等代码。相较 JSON，二进制更紧凑、解析更快、类型更明确，但调试可读性较低。

### 1. `.proto` demo

```proto
syntax = "proto3";

package user.v1;
option go_package = "example.com/demo/gen/user/v1;userv1";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
}

message GetUserRequest {
  int64 user_id = 1;
}

message GetUserResponse {
  User user = 1;
}

message User {
  int64 id = 1;
  string name = 2;
  optional string email = 3;
}
```

生成 Go 代码（需安装 `protoc`、`protoc-gen-go`、`protoc-gen-go-grpc`）：

```bash
protoc --go_out=. --go-grpc_out=. api/user/v1/user.proto
```

### 2. 兼容性规则

字段编号是二进制协议的真实标识，发布后不能随意改变。可新增字段；删除字段后应 `reserved` 原字段号和字段名；不要复用已删除字段号；不要把字段类型改成不兼容类型。

```proto
message User {
  reserved 4, 5;
  reserved "old_phone";
  int64 id = 1;
  string name = 2;
}
```

`optional` 用于区分“字段未传”和“传了零值”；互斥结构用 `oneof`。不要把业务状态码塞进“是否为空”的隐式约定，应定义清晰字段或使用 gRPC 状态码。

## 三、gRPC 与 Go demo

gRPC 通常基于 HTTP/2，支持 Unary、服务端流、客户端流和双向流。它适合内部服务调用；对外 Web API 常仍提供 REST/JSON 或 Gateway。

安装依赖：

```bash
go get google.golang.org/grpc
go get google.golang.org/protobuf
```

### 1. 服务端实现

```go
type userServer struct {
	userv1.UnimplementedUserServiceServer
}

func (s *userServer) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
	if req.GetUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id must be positive")
	}
	return &userv1.GetUserResponse{User: &userv1.User{
		Id: req.GetUserId(), Name: "alice",
	}}, nil
}

func serve() error {
	lis, err := net.Listen("tcp", ":9000")
	if err != nil { return err }
	s := grpc.NewServer()
	userv1.RegisterUserServiceServer(s, &userServer{})
	return s.Serve(lis)
}
```

### 2. 客户端调用：deadline 必不可少

```go
func getUser(ctx context.Context, conn *grpc.ClientConn, id int64) (*userv1.User, error) {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	resp, err := userv1.NewUserServiceClient(conn).GetUser(ctx, &userv1.GetUserRequest{UserId: id})
	if err != nil { return nil, err }
	return resp.GetUser(), nil
}
```

服务端同样要检查 `ctx.Done()`，并把 ctx 传入 DB/RPC 调用。没有 deadline 的跨服务调用会在下游卡住时耗尽 goroutine、连接和请求队列。

## 四、注册中心与服务发现

| 组件               | 常见定位                                        |
| ------------------ | ----------------------------------------------- |
| Nacos              | 注册发现 + 配置管理，国内常用                   |
| Consul             | 注册发现、健康检查、KV、服务网格能力            |
| etcd               | 强一致 KV，常作为 Kubernetes 等系统的基础组件   |
| Kubernetes Service | 集群内 DNS 服务发现；EndpointSlice 维护后端实例 |

### 1. 服务注册

实例启动后注册服务名、地址、端口、版本、权重和 TTL/健康信息；定期心跳续约。优雅停止时先标为不健康/注销，等待负载均衡摘流，再关闭监听和在途请求。

```go
// 伪代码：注册中心客户端的接口因 Nacos/Consul/etcd 而不同。
type Registry interface {
	Register(ctx context.Context, instance Instance) error
	Deregister(ctx context.Context, instanceID string) error
	Watch(ctx context.Context, service string) (<-chan []Instance, error)
}
```

### 2. 客户端发现和负载均衡

客户端订阅实例变更，将健康实例维护在本地；每次调用按 round-robin、加权随机、最少连接或一致性哈希选择实例。实例列表短暂过期时应保留最后一次可用列表并限制重试，避免注册中心故障导致全量不可用。

在 Kubernetes 内，简单场景可直接通过 `user.default.svc.cluster.local:9000` 使用 Service DNS；更细的客户端负载均衡、灰度与熔断可由 service mesh 或应用 SDK 实现。

## 五、健康检查、重试与熔断

健康检查应区分：进程是否存活（liveness）、是否可接流量（readiness）、是否能访问关键依赖。不要把所有依赖瞬时失败都判作 liveness 失败，否则会产生重启风暴。

重试仅适用于幂等操作或带幂等键的写操作。使用 deadline、最大次数、指数退避和抖动；客户端、网关和 service mesh 不能同时无约束重试，否则形成重试风暴。

```text
单次请求预算 300ms
  ├── 第一次 RPC：最多 180ms
  └── 可选重试：最多 100ms + 随机退避
```

熔断在错误率/超时率持续超过阈值时快速失败，保护下游并给其恢复窗口；限流控制入口压力，隔离（bulkhead）将不同租户/依赖的资源隔开，三者解决的问题不同。

## 六、微服务可观测性与安全

每次 RPC 都应有 request ID/trace ID、方法名、状态码、耗时和调用方信息；用 OpenTelemetry 传播 trace context，结合 Prometheus 观察每个 RPC 方法的 QPS、错误率、P99 和在途请求。

生产环境应使用 TLS/mTLS、服务身份认证与最小权限；不要因为“内网 RPC”而信任任意调用者。gRPC metadata 中的认证信息须校验，且不得写入普通日志。

## 七、高频面试题

## 1. 为什么需要服务发现？

**回答：** 服务实例会弹性扩缩、重启和迁移，地址不稳定；服务发现让调用方动态获得健康实例，而不是硬编码 IP。

**补充：** 服务发现有客户端模式和服务端模式。客户端模式由 SDK 选实例；服务端模式由 LB/代理转发。两者都需要健康检查、缓存和故障处理。

## 2. gRPC 为什么比 HTTP/JSON 常用于内部调用？

**回答：** Protobuf 体积小、类型契约明确，HTTP/2 支持多路复用和流式调用，代码生成减少样板代码。

**补充：** 它不天然更可靠；超时、重试、幂等、限流、鉴权和版本兼容仍要由工程设计保证。浏览器兼容和可读性需求强时 REST 可能更合适。

## 3. 注册中心宕机会怎样？

**回答：** 已启动的消费者应继续使用本地缓存的最后可用实例列表；新实例注册、新消费者发现和实例变更会受影响。

**补充：** 因此注册中心要高可用部署，客户端要有本地缓存、订阅重连和启动降级策略。不能让业务请求每次同步查询注册中心。

## 4. 微服务重试为什么危险？

**回答：** 超时不代表服务端未执行，重试可能造成重复写；故障时重试还会放大下游压力。

**补充：** 仅对可安全重试的错误与幂等请求重试，限制次数与总 deadline，并记录重试指标。写操作使用幂等键、唯一约束或状态机。
