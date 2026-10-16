#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Android / proot 下的 Chromium 启动器
====================================

## 为什么需要它

DSH 的 Android 版把整个 Linux 环境跑在**自带的 proot** 里
（`PROOT_LOADER` 指向 `libprootloader.so`）。这个 proot 有一个致命偏差：

    它把 open("/proc/self/fd/N", O_RDONLY) **变成 dup()**。

返回的 fd 与原 fd 共享同一个文件描述符 —— 权限、文件偏移全都跟着原 fd 走。
用纯 python 就能复现（与 Chrome 无关）：

    memfd     /proc/self/fd/N  重开 O_RDONLY  → 实际拿到 O_RDWR   ❌
    普通文件  /proc/self/fd/N  重开 O_RDONLY  → 实际拿到 O_RDWR   ❌
    普通文件  /dev/fd/N        重开 O_RDONLY  → O_RDONLY          ✅（真实路径才行）

而 Chromium 建共享内存**正是靠这一手拿「只读句柄」**。于是：

    memfd_create("shared-memory-region")     = 75
    fcntl(75, F_ADD_SEALS, …)                = 0
    open("/proc/self/fd/75", O_RDONLY)       = 76   ← proot 偷偷 dup
    close(75); dup(76) = 75
    fcntl(75, F_GETFL) = O_RDWR              ← 本该是 O_RDONLY！
    --- SIGTRAP ---                          ← Chromium 的 FD ownership 校验
                                               判定违规，主动 brk 自杀

表现就是本文档最上面那句症状：**CDP 端口起来了（打印 `DevTools listening on ws://…`）
随即 SIGTRAP 死亡**，而且一句日志都不打 —— 它其实 `fprintf` 了
`Crashing due to FD ownership violation:`，但紧接着就 brk，stderr 缓冲没刷出去。

## 解法

用 seccomp 让 `memfd_create` 返回 ENOSYS。Chromium 于是退回
「`/tmp` 里的真实文件」那条路，而 proot 对**真实路径**的处理是正确的 → 一切正常。

## 还顺手做两件事

1. **自拉 Xvfb**：驱动是**故意用有头模式**的（`--headless` 是最典型的机器人特征，
   会改指纹），而手机上 DSH 的服务进程没有 `DISPLAY`。本脚本发现没有 DISPLAY
   且参数里没有 `--headless` 时，会自己起一个 `Xvfb :99`。
2. **补两个必要参数**：手机上 `/dev/shm` 不存在 → 补 `--disable-dev-shm-usage`；
   Linux 下以 root 跑 → 补 `--no-sandbox`（只是进程沙箱，不改指纹）。

## 怎么接

`lib/edge-driver.js` 会自动识别 proot 并把启动命令换成
`python3 <本脚本>`，浏览器路径通过环境变量 `DSH_CHROME_BIN` 传进来。
不想用可以设 `DSH_WEBIN_NO_PROOT_LAUNCHER=1` 关掉。
"""

import ctypes
import errno
import glob
import os
import struct
import sys

# ── 找真正的 chrome ────────────────────────────────────────────────
def find_chrome():
    """优先用驱动传进来的 DSH_CHROME_BIN（就是 resolveEdgePath 找到的那个）。"""
    env = os.environ.get("DSH_CHROME_BIN", "").strip()
    if env and os.path.exists(env):
        return env
    pats = [
        "/root/.cache/puppeteer/chrome/linux-arm64-*/chrome-linux-arm64/chrome",
        "/root/.cache/puppeteer/chrome/linux64-*/chrome-linux64/chrome",
        os.path.expanduser("~/.cache/puppeteer/chrome/*/chrome-linux*/chrome"),
        os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome"),
    ]
    found = []
    for p in pats:
        found += glob.glob(p)
    found = [c for c in found if os.path.isfile(c) and os.access(c, os.X_OK)]
    if not found:
        sys.stderr.write("[proot-launcher] 找不到 chrome，请设 DSH_CHROME_BIN\n")
        sys.exit(127)
    return sorted(found)[-1]


# ── seccomp：把 memfd_create 变成 ENOSYS ───────────────────────────
PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2
SECCOMP_RET_ALLOW = 0x7FFF0000
SECCOMP_RET_ERRNO = 0x00050000

BPF_LD, BPF_W, BPF_ABS = 0x00, 0x00, 0x20
BPF_JMP, BPF_JEQ, BPF_K = 0x05, 0x10, 0x00
BPF_RET = 0x06

# memfd_create 的 syscall 号（按机器架构）
NR_MEMFD_CREATE = {
    "aarch64": 279,
    "x86_64": 319,
    "armv7l": 385,
    "i686": 356,
    "riscv64": 279,
}.get(os.uname().machine, 279)


def _stmt(code, k):
    return struct.pack("HBBI", code, 0, 0, k)


def _jump(code, k, jt, jf):
    return struct.pack("HBBI", code, jt, jf, k)


def block_memfd_create():
    """装 seccomp 过滤器。返回 True 表示成功。

    ⚠️ 装不上就**照常启动**（降级），不让启动器本身变成新的故障点 ——
    真出问题还能靠驱动原来的报错信息定位。
    """
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl.restype = ctypes.c_int
        prog = (
            _stmt(BPF_LD | BPF_W | BPF_ABS, 0)  # A = syscall nr
            + _jump(BPF_JMP | BPF_JEQ | BPF_K, NR_MEMFD_CREATE, 0, 1)
            + _stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | errno.ENOSYS)
            + _stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
        )
        buf = ctypes.create_string_buffer(prog, len(prog))
        fprog = struct.pack("HxxxxxxP", 4, ctypes.cast(buf, ctypes.c_void_p).value)
        if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            sys.stderr.write("[proot-launcher] no_new_privs 失败，跳过 seccomp\n")
            return False
        if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER,
                      ctypes.cast(fprog, ctypes.c_char_p)) != 0:
            sys.stderr.write("[proot-launcher] PR_SET_SECCOMP 失败，跳过 seccomp\n")
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[proot-launcher] seccomp 异常，跳过：{exc}\n")
        return False


# ── 有头模式要一块屏幕 ─────────────────────────────────────────────
def _x_socket_alive(n):
    """**真的去连一下** X 的 unix socket。

    ⚠️ 不能只看 /tmp/.X<n>-lock 是否存在 —— 上一只 Xvfb 被杀之后 lock 和 socket
    文件都会留在原地，只看文件就会把「尸体」当成活的，于是跳过启动 Xvfb、
    DISPLAY 指向一个没人监听的 socket，Chrome 连不上 X server 直接秒退。
    （2026-10-16 实测踩到：驱动报「CDP 端口没起来」，真因就是这个。）
    """
    path = f"/tmp/.X11-unix/X{n}"
    if not os.path.exists(path):
        return False
    import socket
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(1.0)
        s.connect(path)
        return True
    except OSError:
        return False
    finally:
        s.close()


def _spawn_xvfb(n):
    try:
        pid = os.fork()
        if pid == 0:
            os.setsid()
            devnull = os.open(os.devnull, os.O_RDWR)
            os.dup2(devnull, 0)
            os.dup2(devnull, 1)
            os.dup2(devnull, 2)
            os.execv("/usr/bin/Xvfb", ["Xvfb", f":{n}", "-screen", "0", "1280x900x24"])
            os._exit(127)
    except OSError:
        return False
    import time
    for _ in range(80):  # 最多等 8 秒
        if _x_socket_alive(n):
            return True
        time.sleep(0.1)
    return False


def ensure_display(args):
    """驱动刻意用有头模式（--headless 是典型机器人特征），手机上得自己拉 Xvfb。

    调用方已给 DISPLAY 就尊重它；参数里有 --headless 就不需要屏幕。
    """
    if any(a.startswith("--headless") for a in args):
        return
    if os.environ.get("DISPLAY", "").strip():
        return
    if not os.path.exists("/usr/bin/Xvfb"):
        sys.stderr.write("[proot-launcher] 无 DISPLAY 且没装 Xvfb，有头模式可能起不来\n")
        return

    for n in (99, 98, 97, 96):
        if _x_socket_alive(n):
            os.environ["DISPLAY"] = f":{n}"
            sys.stderr.write(f"[proot-launcher] 复用已有 DISPLAY=:{n}\n")
            return
        # 连不上的 lock / socket 都是上次留下的尸体，清掉（不清 Xvfb 会拒绝启动）
        for junk in (f"/tmp/.X{n}-lock", f"/tmp/.X11-unix/X{n}"):
            try:
                os.unlink(junk)
            except OSError:
                pass
        if _spawn_xvfb(n):
            os.environ["DISPLAY"] = f":{n}"
            sys.stderr.write(f"[proot-launcher] DISPLAY=:{n}（自拉 Xvfb）\n")
            return
    sys.stderr.write("[proot-launcher] Xvfb 起不来，有头模式可能失败\n")


def main():
    chrome = find_chrome()
    args = sys.argv[1:]

    # 手机上 /dev/shm 不存在
    if not any(a.startswith("--disable-dev-shm-usage") for a in args):
        args.append("--disable-dev-shm-usage")
    # Linux 下以 root 跑必须关沙箱（不影响指纹，只是进程沙箱）
    if os.name == "posix" and os.geteuid() == 0:
        if not any(a.startswith("--no-sandbox") for a in args):
            args.append("--no-sandbox")

    ensure_display(args)

    blocked = block_memfd_create()
    sys.stderr.write(
        f"[proot-launcher] chrome={chrome} seccomp(memfd→ENOSYS)={blocked} "
        f"display={os.environ.get('DISPLAY', '(无)')} args={len(args)}\n"
    )

    os.execv(chrome, [chrome] + args)


if __name__ == "__main__":
    main()
