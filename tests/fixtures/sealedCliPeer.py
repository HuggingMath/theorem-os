#!/usr/bin/python3
"""Disposable generic CLI fixture. All provider replies come from a local test peer."""
import json, os, subprocess, sys, urllib.request

args = sys.argv[1:]
def argument(name):
    return args[args.index(name) + 1]

prompt = sys.stdin.read()
request = {
    'model': argument('--model'), 'reasoning_effort': argument('--effort'), 'stream': False,
    'messages': [{'role': 'user', 'content': prompt}],
    'tools': [{'type': 'function', 'function': {'name': 'bash', 'description': 'Run a local disposable fixture command.',
        'parameters': {'type': 'object', 'properties': {'command': {'type': 'string'}}, 'required': ['command']}}}],
}
for _ in range(8):
    connection = urllib.request.Request(os.environ['FIXTURE_MODEL_URL'] + '/chat/completions',
        data=json.dumps(request).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['FIXTURE_MODEL_KEY']})
    with urllib.request.urlopen(connection) as response:
        value = json.load(response)
    message = value['choices'][0]['message']
    request['messages'].append(message)
    if not message.get('tool_calls'):
        print(json.dumps({'text': message['content'], 'usage': value['usage']}))
        break
    for tool in message['tool_calls']:
        command = json.loads(tool['function']['arguments'])['command']
        result = subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', command], capture_output=True, text=True)
        request['messages'].append({'role': 'tool', 'tool_call_id': tool['id'], 'content': result.stdout + result.stderr})
else:
    raise RuntimeError('fixture tool loop exhausted')
