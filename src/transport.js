// WebSocket transport implementing codemirror-languageserver's Transport interface.
// One connection = one zls process on the server side.
export class WsLspTransport {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messageCb = null;
    this.closeCb = null;
    this.errorCb = null;
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data === "string" && this.messageCb) this.messageCb(e.data);
    });
    this.ws.addEventListener("close", () => this.closeCb && this.closeCb());
    this.ws.addEventListener("error", () => this.errorCb && this.errorCb(new Error("LSP WebSocket error")));
  }
  get ready() { return this.ws.readyState === WebSocket.OPEN; }
  send(message) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(message);
  }
  onMessage(cb) { this.messageCb = cb; }
  onClose(cb) { this.closeCb = cb; }
  onError(cb) { this.errorCb = cb; }
  close() { try { this.ws.close(); } catch {} }
}
