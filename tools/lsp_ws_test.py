import base64, json, socket, os, time
sock = socket.create_connection(("127.0.0.1", 8123))
key = base64.b64encode(os.urandom(16)).decode()
sock.sendall((f"GET /lsp HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
resp=b""
while b"\r\n\r\n" not in resp: resp += sock.recv(4096)
def send_text(s):  # bare JSON over WS, like codemirror-languageserver
    payload=s.encode(); mask=os.urandom(4); header=bytearray([0x81]); n=len(payload)
    if n<126: header.append(0x80|n)
    elif n<65536: header.append(0x80|126); header+=struct.pack(">H",n)
    else: header.append(0x80|127); header+=struct.pack(">Q",n)
    header+=mask
    sock.sendall(bytes(header)+bytes(b^mask[i%4] for i,b in enumerate(payload)))
import struct
def send(msg): send_text(json.dumps(msg))
ROOT=os.path.abspath("work/runs")
uri="file://"+ROOT+"/001_hello.zig"
text=open("ziglings/exercises/001_hello.zig").read()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":None,"rootUri":"file://"+ROOT,"capabilities":{}}})
send({"jsonrpc":"2.0","method":"initialized","params":{}})
send({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"zig","version":1,"text":text}}})
sock.settimeout(15)
buf=b""
try:
    while True:
        d=sock.recv(262144)
        if not d: print("WS closed"); break
        buf+=d
except socket.timeout: pass
out=buf.decode(errors="replace")
print("bytes:",len(buf),"diags:",out.count("publishDiagnostics"),"initResult:", '"capabilities"' in out)
i=out.find("publishDiagnostics")
if i>=0: print(out[i:i+400])
