#!/usr/bin/env python3
"""Import notes from the learn/ knowledge base into Quartz content.

Polishes each note for publishing: adds title/date/tags frontmatter, removes
the body's leading H1 (the page title component renders it), normalizes file
names that contain spaces, and generates a topic-based index page.

Usage:
    python3 scripts/import_learn_notes.py /path/to/learn
"""

import argparse
import datetime
import json
import pathlib

TOPIC_TAGS = {
    "Elasticsearch": ["Elasticsearch", "搜索引擎"],
    "Go语言": ["Go", "后端"],
    "Kafka": ["Kafka", "消息队列"],
    "Linux": ["Linux", "操作系统"],
    "MySQL": ["MySQL", "数据库"],
    "Redis": ["Redis", "数据库"],
    "StarRocks": ["StarRocks", "数据库"],
    "云原生": ["云原生", "Docker"],
    "博客": ["博客", "Quartz"],
    "可观测性": ["可观测性", "监控"],
    "安全": ["安全", "后端"],
    "微服务": ["微服务", "gRPC"],
    "系统设计": ["系统设计", "后端"],
    "网络": ["网络", "后端"],
    "面试准备": ["面试"],
    "算法竞赛": ["算法"],
}


def polled_title(lines):
    for i, line in enumerate(lines):
        if line.startswith("# "):
            title = line[2:].strip()
            del lines[i]
            if i < len(lines) and lines[i].strip() == "":
                del lines[i]
            return title
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="path to the learn directory")
    parser.add_argument("--output", default="content/学习笔记")
    args = parser.parse_args()

    src = pathlib.Path(args.source).expanduser().resolve()
    dst = pathlib.Path(args.output)
    if not src.is_dir():
        raise SystemExit(f"not a directory: {src}")

    files = sorted(
        p
        for p in src.rglob("*.md")
        if ".playwright-cli" not in p.parts and p.name != "AGENTS.md"
    )
    if not files:
        raise SystemExit("no markdown notes found")

    nav = {}
    for path in files:
        rel = path.relative_to(src)
        topic = rel.parts[0]
        lines = path.read_text(encoding="utf8").splitlines(keepends=True)
        title = polled_title(lines) or path.stem
        date = datetime.datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")

        tags = list(TOPIC_TAGS.get(topic, ["技术"]))
        if "面试" in path.stem:
            tags.append("面试题")
        if "底层实现" in path.stem:
            tags.append("底层原理")
        tags.append("学习笔记")

        frontmatter = "---\ntitle: " + json.dumps(title, ensure_ascii=False) + "\n"
        frontmatter += f"date: {date}\ntags:\n"
        frontmatter += "".join(
            "  - " + json.dumps(tag, ensure_ascii=False) + "\n" for tag in tags
        )
        frontmatter += "---\n\n"

        out_name = path.name.replace(" ", "-")
        out = dst / rel.parent / out_name
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(frontmatter + "".join(lines), encoding="utf8")
        nav.setdefault(topic, []).append((title, f"{topic}/{out.stem}"))

    index = [
        "---",
        "title: 学习笔记总览",
        "tags:",
        "  - 学习笔记",
        "---",
        "",
        f"按主题整理的技术笔记与面试题，共 {len(files)} 篇。",
        "",
    ]
    for topic in sorted(nav):
        index += [f"## {topic}", ""]
        index += [f"- [{title}]({link})" for title, link in nav[topic]]
        index.append("")
    (dst / "总览.md").write_text("\n".join(index), encoding="utf8")

    print(f"imported {len(files)} notes in {len(nav)} topics -> {dst}")


if __name__ == "__main__":
    main()
