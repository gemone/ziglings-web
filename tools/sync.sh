#!/usr/bin/env bash
# 拉取上游 ziglings 最新代码并重新生成练习元数据
set -e
cd "$(dirname "$0")/.."

echo "==> fetch upstream ziglings"
git -C ziglings fetch origin main --tags --force

# 若配置了 zig 版本 tag（work/config.json），同步后恢复对应 tag 检出
if [ -f work/config.json ]; then
  VER=$(python3 -c "import json;print(json.load(open('work/config.json')).get('zigVersion',''))" 2>/dev/null)
  if [ -n "$VER" ]; then
    TAG=$(git -C ziglings tag -l "v${VER%.*}.*" | sort -V | tail -1)
    if [ -n "$TAG" ]; then
      echo "==> re-checkout $TAG"
      git -C ziglings checkout -f "$TAG"
    fi
  fi
fi

echo "==> 重新提取练习元数据"
python3 tools/extract_exercises.py

echo "==> 完成。刷新页面即可看到最新题库（已答进度不受影响，按文件名对应）"
