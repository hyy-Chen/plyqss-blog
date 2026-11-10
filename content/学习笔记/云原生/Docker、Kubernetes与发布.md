---
title: "Docker、Kubernetes 与发布"
date: 2026-10-15
tags:
  - "云原生"
  - "Docker"
  - "学习笔记"
---

## 一、核心对象

| 对象               | 作用                       |
| ------------------ | -------------------------- |
| Image / Container  | 不可变应用镜像与运行实例   |
| Pod                | Kubernetes 最小调度单元    |
| Deployment         | 维护副本数与滚动更新       |
| Service            | 稳定服务发现与负载均衡入口 |
| Ingress            | HTTP/HTTPS 路由入口        |
| ConfigMap / Secret | 配置与敏感配置注入         |

## 二、面试题

## 1. readiness、liveness、startup probe 有何区别？

**回答：** readiness 决定实例是否接流量；liveness 失败会重启容器；startup 为慢启动应用提供启动保护。

**补充：** DB 暂时不可用不一定应触发 liveness 重启，否则会形成重启风暴。readiness 更适合摘流，探针应简单、快速且反映真实可服务状态。

## 2. request 和 limit 的区别？

**回答：** request 用于调度时预留资源，limit 是容器可使用上限；超过 memory limit 通常会 OOMKill，CPU limit 通常表现为节流。

**补充：** Go 的 `GOMEMLIMIT` 应低于 container memory limit，为非堆内存留余量。盲目提高 limit 会掩盖泄漏并降低节点密度。

## 3. 如何滚动发布？

**回答：** Deployment 逐步创建新 Pod、等待其 readiness 成功，再缩减旧 Pod；失败时暂停或回滚。

**补充：** 发布前后要看错误率、P99、资源和业务指标。优雅关闭应先 readiness 失败摘流，再等待在途请求完成。

## 三、最小 Go 容器思路

多阶段构建：编译阶段生成静态二进制，运行阶段使用精简基础镜像；以非 root 运行，注入配置而非把密钥写进镜像。
