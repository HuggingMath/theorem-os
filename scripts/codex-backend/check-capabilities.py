"""Probe the installed app-server without opening a thread or using a provider."""

import json
import os
import subprocess
import sys
import tempfile


def check(executable, profile):
    with subprocess.Popen(
        [executable, "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        cwd=profile, env={"HOME": profile, "CODEX_HOME": profile, "PATH": os.environ["PATH"],
                          "THEOREMOS_HOST_AGENT_CONTROL": "1"},
    ) as server:
        def send(message):
            server.stdin.write(json.dumps(message) + "\n")
            server.stdin.flush()

        def request(request_id, method, params):
            send({"id": request_id, "method": method, "params": params})
            for line in server.stdout:
                reply = json.loads(line)
                if reply.get("id") == request_id:
                    if "error" in reply:
                        raise RuntimeError(f"{method}: {reply['error']}")
                    return reply["result"]
            raise RuntimeError(f"app-server closed before {method} returned")

        try:
            request(1, "initialize", {"clientInfo": {"name": "theoremos-worker-build", "version": "1"},
                                      "capabilities": {"experimentalApi": True}})
            send({"method": "initialized"})
            result = request(2, "theoremos/agentControl/capabilities", {})
            if (result.get("version") != 1 or result.get("backend") != "theoremos-host"
                    or result.get("nativeTools") is not True or result.get("isolatedChildBootstrap") is not True):
                raise RuntimeError(f"incompatible AgentControl backend: {result}")
            print(json.dumps(result))
        finally:
            server.terminate()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temporary:
        check(sys.argv[1], temporary)
