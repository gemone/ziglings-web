#!/usr/bin/env bash
# 拉取上游 ziglings 最新代码并重新生成练习元数据
set -e
cd "$(dirname "$0")/.."

echo "==> git pull upstream ziglings"
git -C ziglings pull --ff-only

echo "==> 重新提取练习元数据"
python3 tools/extract_exercises.py

echo "==> 完成。刷新页面即可看到最新题库（已答进度不受影响，按文件名对应）"
