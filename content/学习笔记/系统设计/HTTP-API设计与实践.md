---
title: "HTTP API 设计与实践"
date: 2026-11-11
tags:
  - "系统设计"
  - "HTTP"
  - "后端"
  - "学习笔记"
---

> API 一旦发布就很难收回。设计阶段多花的时间，会在联调、排障和版本兼容上省回来。本文按「资源与语义 → 请求与响应 → 并发与演进」的顺序，整理一套可以直接落地的约定。

## 一、资源建模

URI 描述**资源**，HTTP 方法描述**动作**。路径用复数名词，层级表达归属关系，避免在路径里塞动词。

```text
GET    /v1/orders/42              单个订单
GET    /v1/orders/42/items        订单下的商品列表
POST   /v1/orders                 创建订单
POST   /v1/orders/42/cancel       确实无法用资源表达的动作
```

确实需要动作型端点时（取消、重试、审批），把它当成「创建一个动作资源」并保持命名一致，例如 `POST /orders/42/cancellations`。不要混用 `/cancelOrder`、`/order_cancel`、`/del?id=42` 三种风格。

ID 建议对外使用不可枚举、无业务含义的字符串（ULID、UUID 或带前缀的 ID，如 `ord_01H...`），既避免被遍历，也避免暴露内部自增主键，方便以后分库分表。

## 二、方法与幂等

| 方法   | 语义           | 幂等 | 可缓存 | 常见用途             |
| ------ | -------------- | ---- | ------ | -------------------- |
| GET    | 读取           | 是   | 是     | 查询、列表           |
| HEAD   | 只取响应头     | 是   | 是     | 探活、检查资源存在   |
| PUT    | 整体替换       | 是   | 否     | 按 ID 全量更新       |
| PATCH  | 局部更新       | 否*  | 否     | 改部分字段           |
| DELETE | 删除           | 是   | 否     | 删除资源             |
| POST   | 创建或触发动作 | 否   | 否*    | 新建、提交、批量操作 |

`*` PATCH 是否幂等取决于载荷语义：`{"status":"paid"}` 是幂等的，`{"count": count+1}` 不是。`POST` 也可以带 `Location` 与 `201` 并配合缓存，但需要显式设置。

幂等不等于「返回相同结果」：第一次 `DELETE` 返回 `204`，第二次可以返回 `404`，只要**服务端状态没有再发生变化**即可。

## 三、状态码与错误体

状态码表达**HTTP 层面**的结果，错误体表达业务细节。不要用 `200 + {"code": 500}` 这类把错误藏在成功响应里的写法，它会让网关、监控和客户端缓存全部误判。

| 状态码 | 场景                                 |
| ------ | ------------------------------------ |
| 200    | 成功且有响应体                       |
| 201    | 创建成功，响应头带 `Location`        |
| 202    | 已受理、异步处理中，返回任务 ID      |
| 204    | 成功且无响应体                       |
| 304    | 缓存未变更（配合 ETag）              |
| 400    | 参数/格式错误                        |
| 401    | 未认证                               |
| 403    | 已认证但无权限                       |
| 404    | 资源不存在（也可用于隐藏资源存在性） |
| 409    | 状态冲突，如重复提交、版本不匹配     |
| 422    | 语义校验失败，如库存不足             |
| 429    | 触发限流，带 `Retry-After`           |
| 5xx    | 服务端或依赖故障                     |

统一的错误结构比散落的字符串更利于客户端处理：

```json
{
  "error": {
    "code": "ORDER_ALREADY_PAID",
    "message": "订单已支付，请勿重复提交",
    "trace_id": "01HQ8Z...",
    "details": [{ "field": "order_id", "issue": "state_conflict" }]
  }
}
```

原则：`code` 供程序分支，`message` 供人阅读（不要塞堆栈或 SQL），`trace_id` 贯穿日志与链路追踪。业务错误码不要替代 HTTP 状态码，两者各司其职。

## 四、分页、过滤与排序

**偏移分页** `?page=2&size=20` 直观，但深分页会让数据库扫描并丢弃大量行，且写入期间容易重复或漏项。数据量大时改用**游标分页**：

```text
GET /v1/orders?status=paid&sort=-created_at,id&limit=20&cursor=eyJpZCI6...
```

要点：

- 排序必须**稳定且唯一**：只用 `created_at` 会在同一时间戳上出现歧义，追加 `id` 作为决胜键。
- 游标应编码上一页最后一条的排序键，而不是页码；内容做签名或加密，避免客户端伪造。
- 过滤字段白名单化，禁止把任意查询参数拼进 SQL。
- 返回 `next_cursor` 与 `has_more`，不要强迫客户端计算总数；`COUNT(*)` 在大表上很贵。
- 支持 `fields=id,status,total` 裁剪响应，减少传输与序列化成本。

## 五、并发控制与幂等写入

### 1. 乐观锁

用 `ETag` 表示资源版本，客户端更新时带 `If-Match`，服务端校验版本并在冲突时返回 `412 Precondition Failed` 或 `409`。

```text
GET /v1/orders/42
→ ETag: "v7"

PUT /v1/orders/42
If-Match: "v7"
→ 版本不匹配时 412，客户端重新拉取后重试
```

### 2. 幂等键

创建类接口让调用方生成 `Idempotency-Key`，服务端记录「键 → 结果」，重复请求直接返回首次结果。

```text
POST /v1/payments
Idempotency-Key: 8f3c...（调用方持久化生成，不能每次重试换一个）
```

实现细节：键要与业务 ID 绑定唯一索引；同一个键但请求体不同应返回 `409`；结果需保留足够长的时间（至少覆盖客户端最大重试窗口）；处理中的并发请求应等待或返回 `409`，而不是各自执行一遍。

### 3. 状态机

比「幂等表」更根本的是让业务状态只能单向迁移：

```text
CREATED → PAID → SHIPPED → DONE
                  ↘ REFUNDED
```

重复收到 `PAID` 事件时，如果当前状态已是 `SHIPPED`，直接确认成功即可；若试图从 `DONE` 回到 `PAID`，返回冲突并告警。更新语句带上状态条件：`UPDATE orders SET status='PAID' WHERE id=? AND status='CREATED'`，用影响行数判断是否真的生效。

## 六、版本与兼容

| 方式              | 例子                                | 适用                   |
| ----------------- | ----------------------------------- | ---------------------- |
| URI 版本          | `/v1/orders`                        | 简单直观、便于网关路由 |
| Header 版本       | `Accept: application/vnd.x.v2+json` | 同一资源多版本共存     |
| 无版本 + 兼容演进 | 只增字段、不改语义                  | 内部服务、可控客户端   |

兼容性红线：

- 只**新增**可选字段，不删除、不改名、不改字段类型和含义。
- 客户端必须容忍未知字段（这也是 Protobuf 的默认行为）。
- 枚举值扩展要考虑旧客户端如何处理未知值，必要时提供 `UNKNOWN`。
- 破坏性变更必须开新版本，并给出迁移期、双写/双读方案和下线时间。

废弃流程：文档标注 `deprecated` → 响应加 `Deprecation` / `Sunset` 头 → 监控调用量 → 通知剩余调用方 → 才下线。

## 七、安全与可靠性清单

1. **认证与授权分离**：401 与 403 不要混用；每个接口做对象级鉴权，防止越权访问他人 `order_id`。
2. **输入约束**：限制请求体大小、数组长度、分页上限、字符串长度；对 JSON 深度做防护。
3. **参数化查询**：所有动态条件走预编译语句或白名单映射，禁止字符串拼接 SQL。
4. **限流与超时**：按租户/接口限流，返回 429 与 `Retry-After`；服务端超时要短于网关超时。
5. **日志脱敏**：不记录密码、令牌、身份证、完整卡号；给每个请求分配 `trace_id` 并透传到下游。
6. **安全响应头**：`Cache-Control: no-store` 用于敏感数据，避免被中间代理缓存。
7. **CORS 与 CSRF**：浏览器场景明确允许的来源与方法；Cookie 鉴权时处理 CSRF。

## 八、文档与契约

用 OpenAPI 描述路径、参数、请求体、响应体、错误码和示例，并把 schema 作为服务端校验和客户端代码生成的来源，避免「文档写一套、代码跑一套」。至少要覆盖：

- 每个接口的成功与**所有**可预期的错误响应；
- 幂等键、分页游标、版本头等特殊约定的说明；
- 限流配额与超时建议；
- 一个可直接复制的最小请求示例。

契约测试（如基于 schema 的自动化断言）比人工检查更可靠：把「新增字段是否破坏旧客户端」变成 CI 里的一条检查。

## 九、Go 侧的最小骨架

```go
func (h *Handler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    key := r.Header.Get("Idempotency-Key")
    if key == "" {
        writeError(w, http.StatusBadRequest, "MISSING_IDEMPOTENCY_KEY")
        return
    }

    var req CreateOrderRequest
    dec := json.NewDecoder(http.LimitReader(r.Body, 1<<20))
    dec.DisallowUnknownFields()
    if err := dec.Decode(&req); err != nil {
        writeError(w, http.StatusBadRequest, "INVALID_BODY")
        return
    }
    if err := req.Validate(); err != nil {
        writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
        return
    }

    order, created, err := h.svc.Create(ctx, key, req)
    if err != nil {
        writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR")
        return
    }
    status := http.StatusOK
    if created {
        status = http.StatusCreated
        w.Header().Set("Location", "/v1/orders/"+order.ID)
    }
    writeJSON(w, status, order)
}
```

要点：`LimitReader` 限制体积、`DisallowUnknownFields` 尽早发现拼写错误、`context` 贯通超时与取消、幂等键由服务层与业务写入放在同一事务里。示例省略了鉴权、日志与指标，生产代码必须补齐。

## 十、面试速答

**问：PUT 和 PATCH 的区别？** PUT 语义是整体替换且幂等，客户端需提供完整资源；PATCH 是局部修改，是否幂等取决于载荷语义。

**问：如何设计一个防重复提交的创建接口？** 调用方生成并持久化 `Idempotency-Key`，服务端用唯一索引记录键与结果，重复请求返回首次结果；业务状态再用状态机约束，并对同键不同请求体返回 409。

**问：深分页怎么优化？** 用基于稳定排序键的游标分页替代 `OFFSET`，排序追加唯一键消除歧义，返回 `next_cursor` 而不是总数。
