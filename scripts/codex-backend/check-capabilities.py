"""Probe AgentControl and Code Mode against a fixed loopback Responses fixture."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread


class ProbeResponses(BaseHTTPRequestHandler):
    calls = 0
    tool_output = None

    def do_POST(self):
        if self.path != "/v1/responses":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        fixture = type(self)
        fixture.calls += 1
        if fixture.calls == 1:
            item = {"type": "custom_tool_call", "call_id": "probe-exec", "name": "exec",
                    "input": "text('theoremos-' + (17 + 25));"}
        elif fixture.calls == 2:
            fixture.tool_output = next(
                (item["output"] for item in body["input"]
                 if item["type"] == "custom_tool_call_output" and item["call_id"] == "probe-exec"),
                None,
            )
            item = {"type": "message", "id": "probe-done", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Probe completed."}]}
        else:
            self.send_error(500, "unexpected additional Responses request")
            return
        response = {"id": f"probe-{fixture.calls}"}
        events = [
            {"type": "response.created", "response": response},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": response},
        ]
        payload = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                          for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


def check_agent_control(executable, profile, environment):
    with subprocess.Popen(
        [executable, "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        cwd=profile, env={**environment, "THEOREMOS_HOST_AGENT_CONTROL": "1"},
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
            return result
        finally:
            server.terminate()


def check_code_mode(executable, profile, environment):
    with HTTPServer(("127.0.0.1", 0), ProbeResponses) as responses:
        base_url = f"http://127.0.0.1:{responses.server_port}"
        Path(profile, "config.toml").write_text(f"""model = "theoremos-probe"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
chatgpt_base_url = "{base_url}"
[analytics]
enabled = false
[features]
code_mode_only = true
code_mode_host = true
[model_providers.fixture]
name = "Code Mode probe"
base_url = "{base_url}/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
""", encoding="utf-8")
        serving = Thread(target=responses.serve_forever, daemon=True)
        serving.start()
        try:
            run = subprocess.run(
                [executable, "exec", "--ephemeral", "--skip-git-repo-check", "Run the Code Mode probe."],
                cwd=profile, env=environment, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
            )
            if run.returncode != 0:
                raise RuntimeError(f"Code Mode probe failed: {run.stderr.strip()}")
            if "theoremos-42" not in json.dumps(ProbeResponses.tool_output):
                raise RuntimeError(f"Code Mode probe returned: {ProbeResponses.tool_output}")
        finally:
            responses.shutdown()
            serving.join()


if __name__ == "__main__":
    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory() as profile:
        environment = {"HOME": profile, "CODEX_HOME": profile, "PATH": os.environ["PATH"]}
        capabilities = check_agent_control(executable, profile, environment)
        check_code_mode(executable, profile, environment)
        print(json.dumps({**capabilities, "codeModeProbe": "passed"}))
