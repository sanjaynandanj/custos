"""Tiny mock MCP-ish stdio server used for the proxy demo.

Reads JSON-RPC per line, responds with a fake result. Supports `tools/call`.
"""
import json
import sys


def handle(msg: dict) -> dict:
    if msg.get("method") == "tools/call":
        params = msg.get("params") or {}
        tool = params.get("name", "")
        args = params.get("arguments", {})
        # Simulate a tool result
        return {"jsonrpc": "2.0", "id": msg.get("id"), "result": {"tool": tool, "args": args, "ok": True}}
    if msg.get("method") == "initialize":
        return {"jsonrpc": "2.0", "id": msg.get("id"), "result": {"protocolVersion": "0.1"}}
    return {"jsonrpc": "2.0", "id": msg.get("id"), "result": {}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        resp = handle(msg)
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
