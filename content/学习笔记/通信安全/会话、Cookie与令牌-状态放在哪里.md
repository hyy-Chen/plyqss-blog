---
title: "会话、Cookie 与令牌：状态放在哪里"
date: 2026-11-12
tags:
  - "通信安全"
  - "会话管理"
  - "JWT"
  - "后端"
  - "学习笔记"
---

> 鉴权方案吵得最多的问题其实是同一个：**状态放在哪**。放服务端就得每次查、但能立刻撤销；放客户端就免查询、但发出去就收不回；放中间一层引用令牌则两头都不极致。再加上浏览器自动带 Cookie 这个历史设计，CSRF、XSS、登出、多端登录全被卷进来。这篇把取舍摊开。

## 一、三种放置方式

```text
A. 服务端 Session：sid（随机串） → Redis/DB 里的会话记录
B. 自包含令牌 JWT：payload 里直接写 userId / role / exp，签名保护
C. 不透明引用令牌：opaque token → 授权服务器 introspection 接口查状态
```

| 维度         | Session           | JWT（自包含）             | Opaque + Introspection       |
| ------------ | ----------------- | ------------------------- | ---------------------------- |
| 服务端状态   | 有，需共享存储    | 无（撤销机制除外）        | 有，集中在 IdP               |
| 每次请求开销 | 一次 Redis/DB 读  | 验签（CPU）               | 一次 HTTP 内省调用（可缓存） |
| 撤销         | 删记录，立即生效  | 需额外机制                | IdP 侧立即生效               |
| 权限变更生效 | 下一次请求        | 等 token 过期             | 下一次请求或缓存过期         |
| 跨域 / 多端  | Cookie 受同源限制 | 友好                      | 友好                         |
| 载荷隐私     | 不含信息          | Base64 可读，勿放敏感数据 | 不含信息                     |
| 密钥轮换     | 不涉及            | 需 JWKS 与 kid 灰度       | IdP 内部处理                 |
| 典型场景     | 第一方 Web        | 微服务内部、短时授权      | 企业级 SSO、第三方授权       |

一句话选型：**浏览器第一方站点用 Session 或 BFF + Cookie 往往最省心；跨域、多服务、第三方授权交给 OIDC 的短期令牌；千万别因为「无状态听起来快」就把长期 JWT 塞进 localStorage。**

## 二、Cookie 不是「不安全」，属性才是关键

```http
Set-Cookie: __Host-sid=<随机值>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600
```

| 属性                  | 作用                             | 常见错误                                               |
| --------------------- | -------------------------------- | ------------------------------------------------------ |
| `Secure`              | 仅 HTTPS 发送                    | 本地环境关掉后忘了开回来                               |
| `HttpOnly`            | JS 读不到，缓解 XSS 窃取         | 把 token 放 `localStorage` 就完全绕过这层              |
| `SameSite=Lax/Strict` | 限制跨站携带，缓解 CSRF          | 需要跨站回调时一刀切设 Strict 导致登录失败             |
| `Domain` / `Path`     | 限定发送范围                     | 设成 `.example.com` 让所有子域共享，一个弱子域拖垮全局 |
| `__Host-` 前缀        | 强制 Secure + Path=/ + 无 Domain | 老浏览器不支持时需降级判断                             |
| `Max-Age` / `Expires` | 控制生命周期                     | 会话 Cookie 不过期，长期有效                           |

`SameSite=Lax` 已经能挡住大部分跨站 POST，但它**不是 CSRF 的完整解法**：顶级 GET 导航仍会携带 Cookie，子域、同站不同源（`schemeful site` 判定）、以及 `SameSite=None` 的第三方场景仍有缝隙。写操作仍应叠加 CSRF Token（同步器模式或 double-submit）或校验 `Origin`/`Sec-Fetch-Site`。

## 三、XSS 与 CSRF 的拉扯

这是前端存令牌最常见的两难：

| 存法                                     | 主要风险                      | 缓解                                 |
| ---------------------------------------- | ----------------------------- | ------------------------------------ |
| `localStorage` + `Authorization: Bearer` | 任意 XSS 都能直接读走长期令牌 | 令牌极短 TTL、严格 CSP、无第三方脚本 |
| HttpOnly Cookie                          | 浏览器自动携带 → CSRF         | SameSite + CSRF Token + Origin 校验  |
| 内存变量 + Refresh Cookie                | XSS 只能偷当前页短时令牌      | BFF 模式，刷新令牌永不暴露给 JS      |

关键点：**XSS 能读到的东西，等价于攻击者拿到的东西；CSRF 不需要读到，只要浏览器愿意自动带上**。所以现代推荐的 BFF（Backend For Frontend）模式是：

```text
浏览器 ── HttpOnly Secure Cookie（只放会话引用）──> BFF
BFF    ── 服务端持有 access token ──> 下游 API
```

JS 全程拿不到访问令牌，令牌也不进浏览器存储；BFF 负责换取、刷新和撤销。代价是多一跳和一层有状态组件，换来的是把攻击面收窄到 XSS 无法直接窃取凭证。

## 四、JWT 的正确用法与体检清单

一个 JWT 是 `header.payload.signature`，前两段只是 Base64URL 编码，**签名只保证没被篡改，不保证没被看见**。校验必须做全：

```go
// 伪代码：校验顺序比签名本身更容易漏
token, err := jwt.Parse(raw, keyfunc,
    jwt.WithValidMethods([]string{"RS256"}),   // 固定算法白名单，不信 header.alg
    jwt.WithIssuer("https://idp.example.com"),
    jwt.WithAudience("order-api"),
    jwt.WithLeeway(30*time.Second),
)
if err != nil || !token.Valid { return ErrUnauthorized }
// exp / nbf 校验由库完成，但 scope、jti、token_version 仍要业务侧判断
```

| 检查项                 | 漏了会怎样                                               |
| ---------------------- | -------------------------------------------------------- |
| `alg` 白名单           | `alg: none`、RS256→HS256 混淆，攻击者自签令牌            |
| `iss` / `aud`          | 别的系统签发、给 A 服务的令牌被拿到 B 服务用（令牌混用） |
| `exp` / `nbf` / `iat`  | 过期令牌仍被接受                                         |
| `kid` 对应的 JWKS 密钥 | 密钥轮换期间验签失败或误信旧密钥                         |
| `scope` / 角色         | 只认证不授权，越权访问                                   |
| `jti` / 撤销列表       | 登出、封禁、改密后旧令牌继续有效                         |

**不要在 payload 里放**：手机号、身份证、余额、内部权限明细、任何「泄露即合规事故」的字段。JWT 常被写进日志、错误消息、浏览器历史、CDN 缓存键里。

## 五、登出与撤销：无状态方案的账

「JWT 无状态」和「能立刻踢人」在数学上是矛盾的，只能选一个折中：

| 方案          | 做法                                        | 代价                                     |
| ------------- | ------------------------------------------- | ---------------------------------------- |
| 短 TTL        | access token 5~15 分钟                      | 撤销最长延迟一个 TTL；刷新链路更复杂     |
| 黑名单        | 撤销时把 `jti` 写入 Redis，TTL = 剩余有效期 | 重新引入共享状态，但只存少量撤销项       |
| 版本号        | 用户记录 `token_version`，token 内带同值    | 改一次密码让该用户全部令牌失效，粒度较粗 |
| Introspection | 每次（或缓存后）问 IdP                      | 多一次网络调用                           |
| 刷新令牌家族  | 见下节                                      | 需要状态记录                             |

经验值：**access token 5~15 分钟 + refresh token 数天且轮换 + 撤销名单**，能覆盖绝大多数业务的「立即禁用」需求。所谓「纯无状态 JWT，永不查库」通常只适合内部低敏服务。

## 六、Refresh Token 轮换与重放检测

老做法：一个长期 refresh token 反复换 access token，泄露了就是长期有效凭证，且攻击者与合法用户同时刷新也不会被发现。

改进后的轮换（rotation）：

```text
登录        → 签发 AT1 + RT1（家族 family=F）
刷新(RT1)  → 签发 AT2 + RT2，并把 RT1 标记为已使用
刷新(RT2)  → 签发 AT3 + RT3，RT2 标记已使用
若再次使用 RT1 → 判定为泄露 → 撤销整个家族 F 的所有令牌，强制重新登录
```

实现要点：

- 服务端按 `family_id` 记录已使用的 RT 与当前有效 RT；检测要**原子**（Redis Lua 或事务），否则并发刷新会误判。
- 合法客户端也可能因网络重试重复提交同一个 RT，所以要容忍一小段窗口的幂等返回（返回同一组新令牌），而不是立刻全家族撤销。
- RT 必须绑定客户端（`client_id`）、设备、scope，且只发给能安全存储的端（后端 BFF / 原生 App 安全存储；SPA 用 `refresh_token` 需配合轮换与额外限制）。

## 七、多端、并发与会话固定

| 场景                      | 老做法的坑                                           | 应有行为                                      |
| ------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| 会话固定 Session Fixation | 登录前后沿用同一个 `sid`，攻击者预先塞给用户一个 sid | 登录成功**必须重新生成** sid                  |
| 多端登录                  | 一个全局 token 覆盖，另一台设备被挤掉或全共享        | 按设备维护会话列表，可分别撤销                |
| 并发刷新                  | 多个标签页同时刷新，互相把对方 RT 判为重用           | 原子轮换 + 短窗口幂等                         |
| 权限变更                  | 降权后旧 token 仍带 admin                            | 校验时以最新权限为准，或 token 内带权限版本号 |
| 登出                      | 只删前端 Cookie，服务端令牌仍有效                    | 服务端撤销会话 + 清 Cookie + 撤销 RT 家族     |

## 八、实践清单

- 第一方 Web 优先 HttpOnly + Secure + SameSite Cookie；BFF 模式让令牌不落到 JS 可读取的位置。
- 所有写操作叠加 CSRF 防护，不单独依赖 `SameSite`。
- access token 分钟级、refresh token 轮换、密钥经 JWKS 支持灰度轮换。
- JWT 校验写全 `alg`/`iss`/`aud`/`exp`/`nbf`，业务侧再判 `scope` 与撤销状态。
- 登录成功后重新生成会话标识；提供「查看并踢出其他设备」的会话管理界面。
- 敏感操作做逐步认证（step-up authentication，重新验证口令或 MFA），不只看「是否登录」。
- 审计记录主体、凭证指纹（`jti` 或哈希）、来源 IP、决策结果，但绝不记录令牌原文。

## 九、面试速答

**Q：token 放 localStorage 有什么问题？**
任何 XSS 都能直接读取并外传，且 `HttpOnly` 保护完全失效。若令牌长期有效，等价于账号永久失陷。更稳的是 HttpOnly Cookie + CSRF 防护，或 BFF 让浏览器只持有会话引用、令牌留在服务端。

**Q：JWT 登出怎么做？**
纯自包含 JWT 没法真正「立即失效」。工程上用短 TTL 缩小窗口，叠加 `jti` 黑名单、用户 `token_version` 或 IdP introspection；刷新令牌则通过轮换 + 家族撤销覆盖长期凭证。

**Q：有了 SameSite 还要 CSRF Token 吗？**
要。Lax 下顶级 GET 导航仍带 Cookie，跨站回调、子域与 `SameSite=None` 场景也有缝隙；CSRF Token 或 `Origin`/`Sec-Fetch-Site` 校验是独立的一层。

**Q：Session 和 JWT 怎么选？**
看是否必须「立刻撤销」和是否跨域。第一方 Web、需要即时封禁与权限变更 → Session/BFF 更简单；多服务、第三方授权、内部短时调用 → 短期 JWT，并配好撤销路径。规模本身不是选 JWT 的理由。

## 十、一句话收尾

会话设计的本质是**在「少查一次」和「收得回来」之间定价**：状态放得越远，扩展越轻松，控制力越弱。别让一个「无状态」的流行词，替你做掉撤销、审计和泄露半径的取舍。
