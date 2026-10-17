#!/bin/sh
# 仅隔离浏览器测试使用；不触碰真实 profile。
exec python3 "$(dirname "$0")/chrome-proot-launcher.py" "$@"
