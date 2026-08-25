#!/usr/bin/env python3
"""acps-bridge — 让 dsh-acps 插件真正使用官方 acps-sdk 的 AIP 客户端。

DSH 插件（Node.js/Cordis）无法直接 import Python 的 acps-sdk，因此本桥接
进程以 stdio 行分隔 JSON-RPC 的形式暴露官方 SDK 的 AipRpcClient：

    请求:   {"id": "...", "method": "start|get|continue|complete|cancel|ping",
              "params": {"url", "leaderId", "taskId", "sessionId", "text", "commandParams"}}
    响应:   {"id": "...", "result": <TaskResult dict>}
            或 {"id": "...", "error": {"code": -32603, "message": "..."}}

TaskResult 通过 pydantic 的 model_dump() 序列化为与 AIP 规范一致的 JSON
（camelCase 字段），与插件其它部分的 wire 形状完全兼容。

用法: python acps_bridge.py [--port N]
  --port N   以 TCP JSON-RPC 服务模式运行（监听 127.0.0.1:N），供 Node 插件
             通过 localhost socket 调用；不传则以 stdio 行协议运行。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path


# ---------------------------------------------------------------------------
# 启动自举：把 acps-sdk 的安装位置加入 sys.path。
# 顺序：1) 显式 PYTHONPATH（插件在 config 里指定 python.pythonPath）
#      2) 本文件附近向上查找含 acps_sdk 的 .pylibs / site-packages 目录
#      3) 环境默认
# ---------------------------------------------------------------------------
def _bootstrap_paths() -> None:
    candidates: list[str] = []
    here = Path(__file__).resolve().parent
    candidates.append(str(here / ".pylibs"))
    for level, parent in enumerate(here.parents):
        if level >= 6:
            break
        candidates.append(str(parent / ".pylibs"))
    # 环境里已有的 PYTHONPATH 优先
    existing = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
    for candidate in existing + candidates:
        probe = Path(candidate)
        if probe.is_dir() and (probe / "acps_sdk").is_dir() and str(probe) not in sys.path:
            sys.path.insert(0, str(probe))


_bootstrap_paths()

from acps_sdk.aip.aip_base_model import TaskCommandType, TextDataItem  # noqa: E402
from acps_sdk.aip.aip_rpc_client import AipRpcClient  # noqa: E402

PROTOCOL_VERSION = "2.0"


class BridgeError(Exception):
    def __init__(self, message: str, code: int = -32603, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


class Bridge:
    """一个 stdio 桥接会话：按 url 缓存 AipRpcClient，分发 JSON-RPC 请求。"""

    def __init__(self) -> None:
        self._clients: dict[str, AipRpcClient] = {}

    def _client(self, url: str, leader_id: str, timeout_ms: int) -> AipRpcClient:
        key = f"{url}|{leader_id}"
        client = self._clients.get(key)
        if client is None:
            client = AipRpcClient(partner_url=url, leader_id=leader_id)
            self._clients[key] = client
        return client

    async def dispatch(self, request: dict) -> dict:
        method = request.get("method")
        params = request.get("params") or {}
        if method == "ping":
            return {"pong": True, "sdk": "acps-sdk"}
        if method not in ("start", "get", "continue", "complete", "cancel"):
            raise BridgeError(f"unknown method {method!r}", code=-32601)
        url = params.get("url")
        leader_id = params.get("leaderId")
        task_id = params.get("taskId")
        session_id = params.get("sessionId")
        text = params.get("text")
        if not url or not leader_id:
            raise BridgeError("params.url and params.leaderId are required", code=-32602)
        client = self._client(url, leader_id, params.get("timeoutMs") or 30000)

        if method == "start":
            if not text:
                raise BridgeError("start requires params.text", code=-32602)
            result = await client.start_task(
                session_id=session_id or f"session-{uuid.uuid4()}",
                user_input=text,
                task_id=task_id or f"task-{uuid.uuid4()}",
            )
        elif method == "get":
            if not task_id:
                raise BridgeError("get requires params.taskId", code=-32602)
            result = await client.get_task(task_id=task_id, session_id=session_id or "")
        elif method == "continue":
            if not task_id or text is None:
                raise BridgeError("continue requires params.taskId and params.text", code=-32602)
            result = await client.continue_task(task_id=task_id, session_id=session_id or "", user_input=text)
        elif method == "complete":
            if not task_id:
                raise BridgeError("complete requires params.taskId", code=-32602)
            result = await client.complete_task(task_id=task_id, session_id=session_id or "")
        else:  # cancel
            if not task_id:
                raise BridgeError("cancel requires params.taskId", code=-32602)
            result = await client.cancel_task(task_id=task_id, session_id=session_id or "")

        return json.loads(result.model_dump_json())

    async def close(self) -> None:
        for client in self._clients.values():
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        self._clients.clear()


async def _serve_tcp(port: int) -> int:
    """TCP 模式：监听 127.0.0.1:port，每个连接按行 JSON-RPC 处理。"""
    bridge = Bridge()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                raw = line.decode("utf-8", errors="replace").strip()
                if not raw:
                    continue
                try:
                    request = json.loads(raw)
                    request_id = request.get("id")
                    try:
                        result = await bridge.dispatch(request)
                        payload = {"jsonrpc": PROTOCOL_VERSION, "id": request_id, "result": result}
                    except BridgeError as error:
                        payload = {"jsonrpc": PROTOCOL_VERSION, "id": request_id, "error": {"code": error.code, "message": error.message, "data": error.data}}
                    except Exception as error:  # noqa: BLE001
                        payload = {"jsonrpc": PROTOCOL_VERSION, "id": request_id, "error": {"code": -32603, "message": str(error)}}
                except json.JSONDecodeError:
                    payload = {"jsonrpc": PROTOCOL_VERSION, "id": None, "error": {"code": -32700, "message": "Parse error"}}
                writer.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
                await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    print(f"[acps-bridge] listening on 127.0.0.1:{port}", flush=True)
    async with server:
        await server.serve_forever()


async def _amain() -> int:
    bridge = Bridge()
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    writer_transport, writer_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout
    )
    writer = asyncio.StreamWriter(writer_transport, writer_protocol, None, loop)

    async def respond(payload: str) -> None:
        writer.write((payload + "\n").encode("utf-8"))
        await writer.drain()

    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            raw = line.decode("utf-8", errors="replace").strip()
            if not raw:
                continue
            try:
                request = json.loads(raw)
                request_id = request.get("id")
                try:
                    result = await bridge.dispatch(request)
                    await respond(json.dumps({"jsonrpc": PROTOCOL_VERSION, "id": request_id, "result": result}, ensure_ascii=False))
                except BridgeError as error:
                    await respond(json.dumps({"jsonrpc": PROTOCOL_VERSION, "id": request_id, "error": {"code": error.code, "message": error.message, "data": error.data}}, ensure_ascii=False))
                except Exception as error:  # noqa: BLE001
                    await respond(json.dumps({"jsonrpc": PROTOCOL_VERSION, "id": request_id, "error": {"code": -32603, "message": str(error)}}, ensure_ascii=False))
            except json.JSONDecodeError:
                await respond(json.dumps({"jsonrpc": PROTOCOL_VERSION, "id": None, "error": {"code": -32700, "message": "Parse error"}}))
    finally:
        await bridge.close()
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:]]
    port = None
    if "--port" in args:
        try:
            port = int(args[args.index("--port") + 1])
        except (ValueError, IndexError):
            print("acps-bridge: --port requires a number", file=sys.stderr)
            return 2
    try:
        if port is not None:
            return asyncio.run(_serve_tcp(port))
        return asyncio.run(_amain())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
